import {
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileCode2,
  Focus,
  Folder,
  FolderOpen,
  Grid3x3,
  History,
  Layers3,
  LibraryBig,
  LoaderCircle,
  Magnet,
  PackageCheck,
  PenLine,
  Redo2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Type,
  TriangleAlert,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { Easy2AlgApi } from "../../shared/ipc";
import type {
  AllegroInstall,
  AllegroVersion,
  AppSettings,
  ConversionPlan,
  ConversionResult,
  GenerationProgress,
  HistoryEntry,
  LocalLibraryDeviceSummary,
  NormalizedCircle,
  NormalizedFootprint,
  NormalizedLine,
  NormalizedSymbol,
  OlbWriteOutcome,
  OlbPartSummary,
  OlbWriteResult,
  ProductSearchHit,
  QueueItem,
} from "../../shared/schemas";
import { createMockApi } from "./mock-api";
import { PanZoom, type PanZoomHandle } from "./PanZoom";
import { SymbolGrid } from "./SymbolGrid";
import { SymbolProperties } from "./SymbolProperties";
import { SymbolPreview } from "./SymbolPreview";
import { applySelection, selectRunnableItems, shouldOfferRegeneration } from "./selection";
import {
  accumulateFontSize,
  accumulateOffset,
  accumulateRotation,
  applySymbolEdits,
  symbolShapeKey,
  EMPTY_SYMBOL_EDITS,
  appendAddedTexts,
  hasSymbolEdits,
  setPinPoints,
  setPinText,
  setRectBounds,
  setTextContent,
  type RectEdges,
  type SymbolEdits,
  type SymbolEdit,
  type AddedTextShape,
  type SymbolPinPoints,
  type SymbolShapeBounds,
} from "../../shared/symbol-edit";
import {
  canRedo,
  canUndo,
  EMPTY_EDIT_HISTORY,
  pushUndo,
  redoOnce,
  undoOnce,
  type EditHistory,
} from "../../shared/edit-history";
import { sanitizeLibraryName } from "../../shared/naming";
import {
  defaultVisibleLayers,
  footprintLayers,
  normalizeVisibleLayers,
  type FootprintLayerId,
} from "../../shared/preview-layers";
import {
  defaultUiSettings,
  directoryOfPath,
  LEFT_RAIL_RANGE,
  RIGHT_RAIL_RANGE,
  type UiSettingsPatch,
} from "../../shared/schemas";
import {
  DEFAULT_SYMBOL_TEXT_HEIGHT,
  sectionPreviewBounds,
  selectionBox,
  symbolKeysInBox,
  symbolSelectableKeys,
} from "../../shared/symbol-labels";
import { collectBoxes, planLayoutAction } from "../../shared/symbol-align";
import { arrowStep, gridMil, snapValue } from "../../shared/symbol-snap";
import { reattachPinsToBounds } from "../../shared/symbol-pin";
import {
  readElementProps,
  writeElementHeight,
  writeElementWidth,
  writeElementX,
  writeElementY,
  writeTextHeight,
  writeTextRotation,
  type ElementField,
} from "../../shared/symbol-property";

type Page = "convert" | "history" | "settings";

const createUnavailableApi = (): Easy2AlgApi => {
  const unavailable = async (): Promise<never> => {
    throw new Error(
      "软件后台服务未能启动。请关闭当前软件并使用完整安装包或免安装包重新打开。",
    );
  };
  return {
    getAppInfo: unavailable,
    getSettings: unavailable,
    saveSettings: unavailable,
    saveUiSettings: unavailable,
    chooseLibraryDirectory: unavailable,
    chooseAllegroExecutable: unavailable,
    detectAllegro: unavailable,
    searchProducts: unavailable,
    fetchComponent: unavailable,
    fetchSymbol: unavailable,
    chooseLocalLibraryFile: unavailable,
    readLocalLibrary: unavailable,
    fetchLocalComponent: unavailable,
    fetchLocalSymbol: unavailable,
    chooseOlbLibrary: unavailable,
    createOlbLibrary: unavailable,
    writeOlb: unavailable,
    createPlan: unavailable,
    generate: unavailable,
    onGenerationProgress: () => () => undefined,
    getHistory: unavailable,
    openPath: unavailable,
  };
};

const isBrowserPreview =
  import.meta.env.DEV &&
  (window.location.protocol === "http:" || window.location.protocol === "https:");
const api: Easy2AlgApi =
  window.easy2alg ??
  (isBrowserPreview ? createMockApi() : createUnavailableApi());
const emptySettings: AppSettings = {
  allegroVersion: "23.1",
  libraryDirectory: "",
  setupCompleted: false,
  allegroExecutablePath: null,
  olbLibraryPath: null,
  unifiedLibraryFolder: false,
  fillPcbFootprint: true,
  ui: defaultUiSettings(),
};

const AllegroVersionOptions: readonly {
  readonly value: AllegroVersion;
  readonly label: string;
}[] = [
  { value: "23.1", label: "Cadence Allegro 23.1" },
  { value: "22.1", label: "Cadence Allegro 22.1" },
  { value: "17.4", label: "Cadence Allegro 17.4" },
  { value: "17.2", label: "Cadence Allegro 17.2" },
  { value: "16.6", label: "Cadence Allegro 16.6" },
];

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type SymbolEntry = {
  readonly symbol: NormalizedSymbol;
  /** 未指定 OLB 时用来命名自动新建的库文件（取源 .elibz2 文件名） */
  readonly libraryName: string;
};

type OlbOutcome =
  | { readonly status: "ok"; readonly result: OlbWriteResult }
  | { readonly status: "failed"; readonly message: string };

/** 单个器件上用户做过的调整：输出改名 + 原理图元件元素位移。 */
type DeviceEdit = {
  readonly pcbName: string | null;
  readonly symbolName: string | null;
  readonly symbolEdits: SymbolEdits;
  /** 用户新加的文本（0.1.46）：追加在对应段末尾，「重置调整」会一并清掉 */
  readonly addedTexts?: readonly AddedTextShape[];
};

const EMPTY_DEVICE_EDIT: DeviceEdit = {
  pcbName: null,
  symbolName: null,
  symbolEdits: EMPTY_SYMBOL_EDITS,
};

/** 把改名与元素位移套到符号上 —— 预览与最终写入 .olb 走的是同一条路径。 */
const applyEdits = (symbol: NormalizedSymbol, edit: DeviceEdit): NormalizedSymbol => {
  const name = edit.symbolName === null ? "" : sanitizeLibraryName(edit.symbolName);
  const named = name.length === 0 ? symbol : { ...symbol, name };
  // 先追加新文本（在段末尾、下标稳定），再做既有编辑 —— 预览与写库同源
  return applySymbolEdits(appendAddedTexts(named, edit.addedTexts), edit.symbolEdits);
};

const basenameOf = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath;

/**
 * 连续编辑（拖动 / 长按方向键）的合并窗口：停手这么久就把这一步结算成一个撤销点。
 * 太小 → 一次拖动攒一堆撤销点；太大 → 两次独立操作被并成一步。
 */
const EDIT_STEP_IDLE_MS = 400;

const libraryNameOf = (sourcePath: string): string => {
  const base = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

const splitIds = (value: string): readonly string[] => [
  ...new Set(
    value
      .toUpperCase()
      .split(/[\s,;，；]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ),
];

const formatDate = (iso: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

/** PCB 封装俯视内容（不含 <svg>，交给 PanZoom 统一承载缩放平移）。y 轴向上。 */
/**
 * PCB 封装俯视内容（不含 <svg>，交给 PanZoom 统一承载缩放平移）。y 轴向上。
 *
 * 按图层分组渲染，图层的可见性由右侧「图层显示」勾选框驱动；图层名用 Allegro
 * 的实际叫法（见 shared/preview-layers.ts）。
 * 阻焊/钢网不是源数据里的独立几何：阻焊 = 焊盘按 maskExpansionMm 外扩，
 * 钢网 = 表贴焊盘等大，与生成 .dra 时的推导规则一致。
 */
/** 把 #rrggbb 按比例往白色（amount>0）或黑色（amount<0）混。 */
const mixColor = (color: string, amount: number): string => {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (match === null) {
    return color;
  }
  const value = Number.parseInt(match[1], 16);
  const target = amount >= 0 ? 255 : 0;
  const ratio = Math.abs(amount);
  const channel = (shift: number): string => {
    const base = (value >> shift) & 0xff;
    return Math.round(base + (target - base) * ratio)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
};

const FootprintPreview = ({
  footprint,
  visible,
  maskExpansionMm,
  layerColors,
}: {
  readonly footprint: NormalizedFootprint;
  readonly visible: ReadonlySet<FootprintLayerId>;
  readonly maskExpansionMm: number;
  /** 用户在「图层显示」里改过的颜色：图层 id → #rrggbb */
  readonly layerColors: Readonly<Record<string, string>>;
}): ReactElement => {
  const width = Math.max(footprint.bounds.maxX - footprint.bounds.minX, 1);
  const height = Math.max(footprint.bounds.maxY - footprint.bounds.minY, 1);
  const margin = Math.max(width, height) * 0.15;
  const declared = footprintLayers(footprint);
  const shapesOn = (layer: string): readonly (NormalizedLine | NormalizedCircle)[] => [
    ...footprint.lines.filter((line) => line.layer === layer),
    ...footprint.circles.filter((circle) => circle.layer === layer),
  ];
  const strokeOf = (layer: FootprintLayerId): string =>
    layerColors[layer] ?? declared.find((item) => item.id === layer)?.color ?? "#8f9ba8";

  const padOutline = (
    pad: NormalizedFootprint["pads"][number],
    grow: number,
    key: string,
    color: string,
  ): ReactElement => (
    <g
      key={key}
      transform={`translate(${pad.center.x} ${pad.center.y}) rotate(${pad.rotation})`}
    >
      <rect
        x={-pad.width / 2 - grow}
        y={-pad.height / 2 - grow}
        width={pad.width + grow * 2}
        height={pad.height + grow * 2}
        rx={pad.shape === "oval" || pad.shape === "circle" ? Math.min(pad.width, pad.height) / 2 : 0}
        fill="none"
        stroke={color}
        strokeWidth="0.04"
        strokeDasharray="0.18 0.12"
      />
    </g>
  );

  return (
    <>
      <defs>
        <pattern id="footprint-grid" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#dfe4ea" strokeWidth="0.025" />
        </pattern>
      </defs>
      <rect
        x={footprint.bounds.minX - margin}
        y={footprint.bounds.minY - margin}
        width={width + margin * 2}
        height={height + margin * 2}
        fill="url(#footprint-grid)"
      />
      <g transform="scale(1 -1)">
        {visible.has("solderMask")
          ? footprint.pads.map((pad, index) =>
              padOutline(pad, maskExpansionMm, `mask-${index}`, strokeOf("solderMask")),
            )
          : null}
        {visible.has("pasteMask")
          ? footprint.pads
              .filter((pad) => pad.holeWidth === 0)
              .map((pad, index) => padOutline(pad, 0, `paste-${index}`, strokeOf("pasteMask")))
          : null}

        {visible.has("pads")
          ? footprint.pads.map((pad) => (
              <g
                key={`${pad.number}-${pad.center.x}-${pad.center.y}`}
                transform={`translate(${pad.center.x} ${pad.center.y}) rotate(${pad.rotation})`}
              >
                <rect
                  x={-pad.width / 2}
                  y={-pad.height / 2}
                  width={pad.width}
                  height={pad.height}
                  rx={pad.shape === "roundedRectangle" ? Math.min(pad.width, pad.height) * 0.2 : pad.shape === "oval" || pad.shape === "circle" ? Math.min(pad.width, pad.height) / 2 : 0}
                  // 1 脚提亮一点，方便一眼找到方向（颜色跟随用户自定义的「铜焊盘」色）
                  fill={pad.number === "1" ? mixColor(strokeOf("pads"), 0.3) : strokeOf("pads")}
                  stroke={mixColor(strokeOf("pads"), -0.3)}
                  strokeWidth="0.05"
                />
              </g>
            ))
          : null}

        {visible.has("holes") ? (
          <>
            {footprint.pads
              .filter((pad) => pad.holeWidth > 0)
              .map((pad, index) => (
                <ellipse
                  key={`hole-${index}`}
                  cx={pad.center.x}
                  cy={pad.center.y}
                  rx={pad.holeWidth / 2}
                  ry={Math.max(pad.holeHeight, pad.holeWidth) / 2}
                  fill={mixColor(strokeOf("holes"), 0.86)}
                  stroke={strokeOf("holes")}
                  strokeWidth="0.05"
                />
              ))}
            {footprint.holes.map((hole, index) => (
              <circle
                key={`mech-${index}`}
                cx={hole.center.x}
                cy={hole.center.y}
                r={hole.diameter / 2}
                fill={mixColor(strokeOf("holes"), 0.86)}
                stroke={strokeOf("holes")}
                strokeWidth="0.05"
              />
            ))}
          </>
        ) : null}

        {visible.has("pinNumbers")
          ? footprint.pads.map((pad) => (
              <g
                key={`num-${pad.number}-${pad.center.x}-${pad.center.y}`}
                transform={`translate(${pad.center.x} ${pad.center.y}) rotate(${pad.rotation})`}
              >
                <text
                  x="0"
                  y="0"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={Math.max(Math.min(pad.width, pad.height) * 0.42, 0.18)}
                  fill={mixColor(strokeOf("pinNumbers"), -0.15)}
                  transform={`scale(1 -1) rotate(${-pad.rotation})`}
                >
                  {pad.number}
                </text>
              </g>
            ))
          : null}

        {(["silkscreen", "assembly", "courtyard", "documentation"] as const).map((layer) =>
          visible.has(layer)
            ? shapesOn(layer).map((shape, index) => {
                const color = strokeOf(layer);
                const dashed = layer === "courtyard" || layer === "documentation";
                if ("radius" in shape) {
                  return (
                    <circle
                      key={`${layer}-c${index}`}
                      cx={shape.center.x}
                      cy={shape.center.y}
                      r={shape.radius}
                      fill="none"
                      stroke={color}
                      strokeWidth={shape.width}
                    />
                  );
                }
                if ("start" in shape) {
                  return (
                    <line
                      key={`${layer}-l${index}`}
                      x1={shape.start.x}
                      y1={shape.start.y}
                      x2={shape.end.x}
                      y2={shape.end.y}
                      stroke={color}
                      strokeWidth={Math.max(shape.width, 0.06)}
                      strokeDasharray={dashed ? "0.25 0.18" : undefined}
                    />
                  );
                }
                return null;
              })
            : null,
        )}
      </g>
    </>
  );
};

const NavButton = ({
  active,
  icon,
  label,
  onClick,
  testId,
}: {
  readonly active: boolean;
  readonly icon: ReactElement;
  readonly label: string;
  readonly onClick: () => void;
  readonly testId: string;
}): ReactElement => (
  <button
    className={`nav-button ${active ? "active" : ""}`}
    onClick={onClick}
    data-testid={testId}
    type="button"
  >
    {icon}
    <span>{label}</span>
  </button>
);

const SetupDialog = ({
  initial,
  installs,
  onInstallDetected,
  onSave,
}: {
  readonly initial: AppSettings;
  readonly installs: readonly AllegroInstall[];
  readonly onInstallDetected: (install: AllegroInstall) => void;
  readonly onSave: (settings: AppSettings) => Promise<void>;
}): ReactElement => {
  const configured = installs.find((install) => install.version === initial.allegroVersion);
  const initialVersion = configured?.version ?? installs[0]?.version ?? initial.allegroVersion;
  const [version, setVersion] = useState<AllegroVersion>(initialVersion);
  const [directory, setDirectory] = useState(initial.libraryDirectory);
  const [manualExecutablePath, setManualExecutablePath] = useState<string | null>(
    initialVersion === initial.allegroVersion ? initial.allegroExecutablePath : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedInstall =
    (manualExecutablePath === null
      ? installs.find((install) => install.version === version)
      : installs.find(
          (install) =>
            install.version === version &&
            install.executablePath.toLowerCase() === manualExecutablePath.toLowerCase(),
        )) ?? null;

  const chooseDirectory = async (): Promise<void> => {
    const selected = await api.chooseLibraryDirectory();
    if (selected !== null) {
      setDirectory(selected);
    }
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        allegroVersion: version,
        libraryDirectory: directory,
        setupCompleted: true,
        allegroExecutablePath: manualExecutablePath,
        olbLibraryPath: initial.olbLibraryPath,
        unifiedLibraryFolder: initial.unifiedLibraryFolder,
        fillPcbFootprint: initial.fillPcbFootprint,
        ui: initial.ui,
      });
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };
  const chooseExecutable = async (): Promise<void> => {
    setError(null);
    try {
      const install = await api.chooseAllegroExecutable();
      if (install !== null) {
        onInstallDetected(install);
        setVersion(install.version);
        setManualExecutablePath(install.executablePath);
      }
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="setup-dialog" aria-modal="true" role="dialog" data-testid="setup-dialog">
        <div className="setup-mark"><Zap size={25} /></div>
        <p className="eyebrow">安装检查</p>
        <h2>确认真实的 Allegro</h2>
        <p className="muted">只有检测到实际程序后才能生成封装，不再使用默认连接状态。</p>
        <label className="field-label" htmlFor="setup-version">Allegro 版本</label>
        <select
          id="setup-version"
          value={version}
          onChange={(event) => {
            setVersion(event.target.value as AllegroVersion);
            setManualExecutablePath(null);
          }}
        >
          {AllegroVersionOptions.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
              {installs.some((install) => install.version === option.value) ? "（已检测）" : ""}
            </option>
          ))}
        </select>
        <div className={`detection-card ${selectedInstall === null ? "missing" : ""}`}>
          {selectedInstall === null ? (
            <>
              <TriangleAlert size={18} />
              <div><strong>未检测到 Allegro {version}</strong><span>可以选择实际的 allegro.exe</span></div>
            </>
          ) : (
            <>
              <Check size={18} />
              <div><strong>已检测 Allegro {selectedInstall.version}</strong><span>{selectedInstall.executablePath}</span></div>
            </>
          )}
          <button type="button" className="secondary-button" onClick={() => void chooseExecutable()}>
            手动选择
          </button>
        </div>
        {error === null ? null : <p className="setup-error">{error}</p>}
        <label className="field-label" htmlFor="setup-directory">封装库目录</label>
        <div className="directory-row">
          <input
            id="setup-directory"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="选择保存目录"
          />
          <button type="button" className="icon-button" onClick={chooseDirectory} aria-label="选择目录">
            <FolderOpen size={18} />
          </button>
        </div>
        <button
          className="primary-button wide"
          type="button"
          disabled={directory.trim().length === 0 || selectedInstall === null || saving}
          onClick={save}
          data-testid="setup-confirm"
        >
          {saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
          保存并开始
        </button>
      </section>
    </div>
  );
};

const ProgressSteps = [
  { stage: "preparing", label: "准备封装数据" },
  { stage: "launching", label: "启动 Allegro" },
  { stage: "generating", label: "生成焊盘和封装" },
  { stage: "verifying", label: "回读并检查封装" },
  { stage: "copying", label: "写入封装库目录" },
] as const;

const GenerationProgressDialog = ({
  progress,
  onClose,
  onOpenDirectory,
}: {
  readonly progress: GenerationProgress;
  readonly onClose: () => void;
  readonly onOpenDirectory: (absolutePath: string) => Promise<void>;
}): ReactElement => {
  const terminal = progress.stage === "completed" || progress.stage === "failed";
  const activeIndex =
    progress.stage === "completed"
      ? ProgressSteps.length
      : progress.stage === "failed"
        ? Math.min(Math.floor(progress.percent / 20), ProgressSteps.length - 1)
        : ProgressSteps.findIndex((step) => step.stage === progress.stage);
  return (
    <div className="progress-backdrop">
      <section
        className={`progress-dialog ${progress.stage}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-progress-title"
        data-testid="generation-progress-dialog"
      >
        <div className="progress-heading">
          <div className="progress-symbol">
            {progress.stage === "completed" ? (
              <Check size={24} />
            ) : progress.stage === "failed" ? (
              <X size={24} />
            ) : (
              <LoaderCircle className="spin" size={24} />
            )}
          </div>
          <div>
            <p>{progress.lcscId}</p>
            <h2 id="generation-progress-title">
              {progress.stage === "completed"
                ? "生成并验证完成"
                : progress.stage === "failed"
                  ? "生成未完成"
                  : "正在生成并验证"}
            </h2>
          </div>
        </div>
        <div className="progress-meter" aria-label={`完成 ${progress.percent}%`}>
          <i style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="progress-percent">
          <span data-testid="generation-progress-message">{progress.message}</span>
          <strong data-testid="generation-progress-percent">{progress.percent}%</strong>
        </div>
        <div className="progress-steps">
          {ProgressSteps.map((step, index) => {
            const completed = progress.stage === "completed" || index < activeIndex;
            const active = index === activeIndex && !terminal;
            const failed = progress.stage === "failed" && index === activeIndex;
            return (
              <div
                className={`progress-step ${completed ? "completed" : ""} ${active ? "active" : ""} ${failed ? "failed" : ""}`}
                key={step.stage}
              >
                <span>
                  {completed ? (
                    <Check size={14} />
                  ) : failed ? (
                    <X size={14} />
                  ) : active ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <strong>{step.label}</strong>
              </div>
            );
          })}
        </div>
        {progress.stage === "failed" && progress.diagnosticDirectory !== null ? (
          <div className="progress-diagnostics">
            <span>本次临时文件已保留</span>
            <strong>{progress.diagnosticDirectory}</strong>
          </div>
        ) : null}
        {terminal ? (
          <div className="progress-actions">
            {progress.stage === "failed" && progress.diagnosticDirectory !== null ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void onOpenDirectory(progress.diagnosticDirectory!)}
                data-testid="generation-progress-open-diagnostics"
              >
                <FolderOpen size={16} />打开临时文件
              </button>
            ) : null}
            <button
              className="primary-button progress-close"
              type="button"
              onClick={onClose}
              data-testid="generation-progress-close"
            >
              {progress.stage === "completed" ? "完成" : "关闭"}
            </button>
          </div>
        ) : (
          <p className="progress-note">请不要关闭软件或操作 Allegro 窗口</p>
        )}
      </section>
    </div>
  );
};

/**
 * 覆盖同名器件的**二次确认**（用户 2026-10-16 反馈"同名不覆盖也没提醒"）。
 * 把"库里旧的"和"这次要写的"两份内容都摆出来，确认了才动手。
 */
const OverwriteConfirmDialog = ({
  request,
  onCancel,
  onConfirm,
}: {
  readonly request: Extract<OlbWriteOutcome, { status: "needsConfirm" }>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement => {
  const describe = (part: OlbPartSummary): string =>
    `${part.sectionCount} 段 / ${part.pinCount} 脚${
      part.bodyWidth === null ? "" : `，本体宽 ${part.bodyWidth}`
    }`;
  return (
    <div className="progress-backdrop">
      <section
        className="progress-dialog failed overwrite-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="overwrite-confirm-title"
        data-testid="overwrite-confirm-dialog"
      >
        <div className="progress-heading">
          <div className="progress-symbol">
            <TriangleAlert size={24} />
          </div>
          <div>
            <p>{request.packageName}</p>
            <h2 id="overwrite-confirm-title">目标库里已有同名器件</h2>
          </div>
        </div>
        <div className="overwrite-body">
          <p>
            <strong>{basenameOf(request.libraryPath)}</strong> 里已经有一个{" "}
            <strong>{request.packageName}</strong>：
          </p>
          <dl className="overwrite-facts">
            <div>
              <dt>库里现有</dt>
              <dd>{describe(request.existing)}</dd>
            </div>
            <div>
              <dt>本次写入</dt>
              <dd>{describe(request.incoming)}</dd>
            </div>
          </dl>
          <p className="overwrite-note">
            {request.existing.sectionCount === request.incoming.sectionCount &&
            request.existing.pinCount === request.incoming.pinCount &&
            request.existing.bodyWidth === request.incoming.bodyWidth ? (
              <>
                库里的内容与本次写入<b>一致</b>，通常不需要重写（重写只是为了确保万无一失）。
                <br />
              </>
            ) : null}
            继续将<b>覆盖</b>旧内容（写入前会自动留一份 .bak 备份）。
            <br />
            如果 OrCAD Capture 正开着这个库，请先关闭它再继续，否则 Capture 会把内存里的旧内容写回去。
          </p>
        </div>
        <div className="progress-actions">
          <button className="secondary-button" type="button" onClick={onCancel} data-testid="overwrite-cancel">
            跳过这个器件
          </button>
          <button className="primary-button progress-close" type="button" onClick={onConfirm} data-testid="overwrite-confirm">
            覆盖写入
          </button>
        </div>
      </section>
    </div>
  );
};

/**
 * 右侧检查结果里的可折叠分组。折叠状态存在设置里（settings.ui.collapsedSections），
 * 下次打开保持原样 —— 用户 2026-10-16 反馈"右侧支持展开与隐藏，需要持久化"。
 */
const InspectorSection = ({
  id,
  title,
  collapsed,
  onToggle,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly collapsed: boolean;
  readonly onToggle: (id: string) => void;
  readonly children: ReactNode;
}): ReactElement => (
  <section className={`inspector-section${collapsed ? " is-collapsed" : ""}`}>
    <button
      className="section-toggle"
      type="button"
      aria-expanded={!collapsed}
      onClick={() => onToggle(id)}
      data-testid={`section-toggle-${id}`}
    >
      <h3>
        {title}
        <ChevronRight size={15} className="section-chevron" />
      </h3>
    </button>
    {collapsed ? null : children}
  </section>
);

const ConverterPage = ({
  settings,
  allegroInstall,
  queue,
  setQueue,
  selectedId,
  setSelectedId,
  onGenerated,
  onUiChange,
}: {
  readonly settings: AppSettings;
  readonly allegroInstall: AllegroInstall | null;
  readonly queue: readonly QueueItem[];
  readonly setQueue: Dispatch<SetStateAction<readonly QueueItem[]>>;
  readonly selectedId: string | null;
  readonly setSelectedId: (id: string | null) => void;
  readonly onGenerated: (entry: HistoryEntry) => void;
  /** 界面偏好（侧栏宽度 / 分组折叠 / 图层配色）：落盘但不重跑 Allegro 探测 */
  readonly onUiChange: (patch: UiSettingsPatch) => void;
}): ReactElement => {
  const [input, setInput] = useState("C2040");
  const [plans, setPlans] = useState<Readonly<Record<string, ConversionPlan>>>({});
  // 本地库导入时从同一份 .elibz2 里顺带取出的原理图元件（C 编号链路没有符号）。
  const [symbols, setSymbols] = useState<Readonly<Record<string, SymbolEntry>>>({});
  const [olbOutcomes, setOlbOutcomes] = useState<Readonly<Record<string, OlbOutcome>>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  /** 关键字搜索结果（输入框下方列出，点一下加入队列） */
  const [searching, setSearching] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<readonly ProductSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // 生成哪些产物：PCB 封装（.dra/.psm/.pad）与原理图元件（.olb）各自独立开关。
  const [targets, setTargets] = useState<{ pcb: boolean; symbol: boolean }>({
    pcb: true,
    symbol: true,
  });
  const [previewTab, setPreviewTab] = useState<"pcb" | "sch">("pcb");
  const [sectionIndex, setSectionIndex] = useState(0);
  /**
   * 符号编辑的**选中集**：支持多选（空白处拖出橡皮筋框选，然后一起移动 ——
   * 用户 2026-10-16 要求）。单选就是长度为 1。
   */
  const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
  /** 单选时的那一个键 —— 旋转 / 字号这类只对单个元素有意义的操作看它。 */
  const selectedShapeKey = selectedKeys.length === 1 ? selectedKeys[0] : null;
  /** 正在拖的橡皮筋框里命中的键（拖动过程实时高亮用；null = 没在框选）。 */
  const [marqueeKeys, setMarqueeKeys] = useState<readonly string[] | null>(null);
  /** 框选中优先显示"正要选中的"，松手后才变成正式选中集。 */
  const effectiveSelectedKeys = useMemo(
    () => new Set(marqueeKeys ?? selectedKeys),
    [marqueeKeys, selectedKeys],
  );
  // PCB 预览的图层开关（右侧「图层显示」面板直接驱动画布）
  const [visibleLayers, setVisibleLayers] = useState<ReadonlySet<FootprintLayerId>>(
    () => defaultVisibleLayers([]),
  );
  // 每个器件的手工调整（符号元素位移）与输出改名。
  const [deviceEdits, setDeviceEdits] = useState<Readonly<Record<string, DeviceEdit>>>({});
  // 拖动侧栏时的实时宽度（松手才落盘，避免拖拽过程刷 IPC）
  const [liveRail, setLiveRail] = useState<{ readonly side: "left" | "right"; readonly width: number } | null>(null);
  /**
   * 「编辑」模式：与浏览（缩放/平移）互斥。开着时元素可点选拖动，
   * 键盘快捷键生效（见 onSymbolEditorKeyDown 的注释）。
   */
  const [editMode, setEditMode] = useState(false);
  /** 「添加文本」后自动进入行内编辑的请求（nonce 变化即重新触发） */
  const [textEditRequest, setTextEditRequest] = useState<{ key: string; nonce: number } | null>(null);
  // 原理图元件预览的网格设置（用户 2026-10-20）：100 mil / 50 mil 两档
  const snapEnabled = settings.ui.symbolSnapEnabled;
  const snapGrid = settings.ui.symbolSnapGrid;
  const gridVisible = settings.ui.symbolGridVisible;
  const snapState = useMemo(() => ({ enabled: snapEnabled, grid: snapGrid }), [snapEnabled, snapGrid]);
  // 覆盖同名器件的二次确认（promise 化，生成流程里 await 它）
  const [overwriteAsk, setOverwriteAsk] = useState<{
    readonly request: Extract<OlbWriteOutcome, { status: "needsConfirm" }>;
    readonly resolve: (confirmed: boolean) => void;
  } | null>(null);
  const progressRef = useRef<GenerationProgress | null>(null);
  const selected = queue.find((item) => item.id === selectedId) ?? queue[0] ?? null;
  const selectedPlan = selected === null ? null : (plans[selected.id] ?? null);
  const selectedOlb = selected === null ? null : (olbOutcomes[selected.id] ?? null);
  // 按钮可用性与生成目标共用同一判据，见 selection.ts 的注释。
  const runnableItems = useMemo(() => selectRunnableItems(queue, plans), [queue, plans]);

  const selectedEdit = (selected === null ? undefined : deviceEdits[selected.id]) ?? EMPTY_DEVICE_EDIT;
  const selectedSymbolEntry = selected === null ? undefined : symbols[selected.id];
  // 预览用的是**套完命名与手工调整之后**的符号，所见即最终写入 .olb 的内容。
  const editedSymbol = useMemo(
    () => (selectedSymbolEntry === undefined ? null : applyEdits(selectedSymbolEntry.symbol, selectedEdit)),
    [selectedSymbolEntry, selectedEdit],
  );
  const previewSection =
    editedSymbol === null
      ? null
      : editedSymbol.sections[Math.min(sectionIndex, editedSymbol.sections.length - 1)];
  // 引脚号排在**本体外面**（上下边引脚的脚号比引脚本身还长），包围盒要并进去，
  // 否则「适应窗口」会把它们裁掉。
  const previewBounds = previewSection === null ? null : sectionPreviewBounds(previewSection);

  /** 属性面板要读**未套编辑**的原始段（读的是"原始值 + 当前编辑"，套过的会双重叠加）。 */
  const rawSection =
    selectedSymbolEntry === undefined || selectedSymbolEntry === null
      ? null
      : (selectedSymbolEntry.symbol.sections[
          Math.min(sectionIndex, selectedSymbolEntry.symbol.sections.length - 1)
        ] ?? null);
  const elementProps = useMemo(() => {
    if (!editMode || rawSection === null || selectedKeys.length !== 1) {
      return null;
    }
    return readElementProps(rawSection, selectedEdit.symbolEdits, selectedKeys[0]);
  }, [editMode, rawSection, selectedEdit.symbolEdits, selectedKeys]);

  /**
   * 画布命令面（用户 2026-10-20）：缩放到选中。
   * 有选中 → 选中包围盒外扩半格；无选中 → 回到整个符号。
   */
  const symbolPanRef = useRef<PanZoomHandle | null>(null);
  const focusSelection = useCallback((): void => {
    const pad = Math.max(settings.ui.symbolSnapGrid, 4);
    const box =
      previewSection === null
        ? null
        : selectionBox(previewSection, selectedKeys.length > 0 ? selectedKeys : []);
    const target =
      box !== null
        ? { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad }
        : previewBounds === null
          ? null
          : {
              minX: previewBounds.minX - pad,
              minY: previewBounds.minY - pad,
              maxX: previewBounds.maxX + pad,
              maxY: previewBounds.maxY + pad,
            };
    if (target !== null) {
      symbolPanRef.current?.fitTo(target);
    }
  }, [previewBounds, previewSection, selectedKeys, settings.ui.symbolSnapGrid]);

  // 编辑模式下当前选中的是不是文本（旋转/字号只对文本有意义）
  const selectedIsText =
    editMode &&
    previewSection !== null &&
    selectedShapeKey !== null &&
    !selectedShapeKey.startsWith("p") &&
    previewSection.shapes[
      Number(selectedShapeKey.split(":")[1] ?? -1)
    ]?.kind === "text";


  // 勾选目标后仍要保证"有东西可生成"。
  // **只勾符号时不要求封装计划**（用户 2026-10-19：本地库器件封装计划丢了/没建过，
  // 但符号在 —— 想只写 .olb 却被"先在左侧勾选至少一个已读取的器件"拦住）。
  // PCB 走 runnableItems（那里要求 plans 有计划）；符号只看 symbols 表。
  const generatableItems = useMemo(() => {
    if (targets.pcb) {
      return runnableItems;
    }
    if (targets.symbol) {
      return queue.filter((item) => item.selected && symbols[item.id] !== undefined);
    }
    return [];
  }, [queue, runnableItems, symbols, targets.pcb, targets.symbol]);

  // 切到没有符号的器件时把分页退回 PCB，避免"分页停在符号、画布却是封装"的错位。
  const hasSymbol = editedSymbol !== null;
  useEffect(() => {
    if (!hasSymbol) {
      setPreviewTab("pcb");
    }
  }, [hasSymbol]);

  /**
   * 符号条目自愈：选中的器件在 symbols 表里缺条目时自动补拉一次。
   *
   * 正常流程里导入就会带上符号，但"清空列表 → 重新导入"等路径可能只恢复了
   * 队列行（封装还在、能看 PCB 预览），符号却是空的 —— 表现为"原理图元件"
   * tab 灰掉点不动（用户 2026-10-19）。每台只试一次（ref 去重），器件真没
   * 符号时也不会反复打接口。
   */
  const symbolRetryRef = useRef<ReadonlySet<string>>(new Set());
  const selectedQueueItem = selected;
  useEffect(() => {
    const item = selectedQueueItem;
    if (item === null || item === undefined) {
      return;
    }
    if (symbols[item.id] !== undefined || symbolRetryRef.current.has(item.id)) {
      return;
    }
    symbolRetryRef.current = new Set([...symbolRetryRef.current, item.id]);
    let cancelled = false;
    void (async () => {
      try {
        const symbol =
          item.local === undefined
            ? await api.fetchSymbol(item.id)
            : await api.fetchLocalSymbol(item.local.sourcePath, item.local.deviceUuid);
        if (!cancelled && symbol !== null) {
          const libraryName =
            item.local === undefined ? item.id : libraryNameOf(item.local.sourcePath);
          setSymbols((current) =>
            current[item.id] !== undefined
              ? current
              : { ...current, [item.id]: { symbol, libraryName } },
          );
        }
      } catch {
        // 拉不到就保持没有符号（tab 维持禁用 + 提示），不打断用户
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedQueueItem, symbols]);

  /**
   * 封装计划自愈：右侧"检查结果"面板依赖 plans 表，队列行还留着旧数据（封装在、
   * 状态绿勾）但计划丢了时，面板会一直显示"等待器件数据"。选中时补建一次。
   */
  const planRetryRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const item = selectedQueueItem;
    if (item === null || item === undefined || item.footprint === null) {
      return;
    }
    if (plans[item.id] !== undefined || planRetryRef.current.has(item.id)) {
      return;
    }
    planRetryRef.current = new Set([...planRetryRef.current, item.id]);
    let cancelled = false;
    void (async () => {
      try {
        const plan = await api.createPlan(item.footprint!);
        if (!cancelled) {
          setPlans((current) =>
            current[item.id] !== undefined ? current : { ...current, [item.id]: plan },
          );
        }
      } catch {
        // 建不出计划就保持空态提示，不打断用户
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedQueueItem, plans]);
  const selectedKeyId = selected?.id ?? null;
  useEffect(() => {
    setSectionIndex(0);
    setSelectedKeys([]);
  }, [selectedKeyId]);

  // 当前器件实际存在的图层（源数据里没有的层不列出来）。换器件时把上次残留的
  // 勾选收敛到新图层表，并保证至少留一层可见。
  const layers = useMemo(
    () => (selected?.footprint == null ? [] : footprintLayers(selected.footprint)),
    [selected?.footprint],
  );
  useEffect(() => {
    if (layers.length === 0) {
      return;
    }
    setVisibleLayers((current) => {
      const next = normalizeVisibleLayers(layers, current);
      return next.size === current.size && [...next].every((id) => current.has(id))
        ? current
        : next;
    });
  }, [layers]);

  /**
   * 撤销 / 重做（用户 2026-10-16 要求"编辑支持退回步骤"）。每台器件一条栈，
   * 栈里存的是**编辑前**的 SymbolEdits 快照 —— 编辑本身不可变，退回即放回旧快照。
   */
  const [editHistory, setEditHistory] = useState<Record<string, EditHistory>>({});
  const deviceEditsRef = useRef(deviceEdits);
  deviceEditsRef.current = deviceEdits;
  /** 正在进行的"一步"（拖动/长按方向键期间挂着，空闲后结算）。 */
  const editStepRef = useRef<{
    readonly deviceId: string;
    readonly before: SymbolEdits;
    timer: number;
  } | null>(null);

  const symbolEditsOf = useCallback(
    (deviceId: string): SymbolEdits =>
      deviceEditsRef.current[deviceId]?.symbolEdits ?? EMPTY_SYMBOL_EDITS,
    [],
  );

  /**
   * 结算未完成的一步：真改动过才压撤销栈，并把这份"改动前快照"返回给调用方。
   *
   * 返回值是必要的：`setEditHistory` 是异步的，撤销/重做若只看渲染期的
   * `editHistory`，就看不到刚刚结算的这一步 —— 表现是"拖完立刻 Ctrl+Z 没反应"
   * （必须等 400ms 合并窗口自然结算才行）。
   */
  const sealEditStep = useCallback((): { readonly deviceId: string; readonly before: SymbolEdits } | null => {
    const open = editStepRef.current;
    if (open === null) {
      return null;
    }
    editStepRef.current = null;
    window.clearTimeout(open.timer);
    if (symbolEditsOf(open.deviceId) === open.before) {
      return null;
    }
    setEditHistory((current) => ({
      ...current,
      [open.deviceId]: pushUndo(current[open.deviceId] ?? EMPTY_EDIT_HISTORY, open.before),
    }));
    return { deviceId: open.deviceId, before: open.before };
  }, [symbolEditsOf]);

  /**
   * 改符号编辑状态（统一入口，带撤销记录）。
   *
   * `continuous=true` 用于拖动与长按方向键：连续改动先挂在同一个"步"里，
   * 停手 `EDIT_STEP_IDLE_MS` 之后才结算 —— 否则一次拖动会攒出几十个撤销点，
   * Ctrl+Z 要按到手酸。
   *
   * **状态更新必须是函数式**：指针事件会被浏览器合并（一次批处理里来两个 move），
   * 若以渲染期的 ref 为基线，后一个事件会把前一个的位移整个覆盖掉
   * （实测一次拖动只走了最后一步的位移）。
   */
  const mutateSymbolEdits = useCallback(
    (deviceId: string, mutate: (edits: SymbolEdits) => SymbolEdits, continuous: boolean): void => {
      const before = symbolEditsOf(deviceId);
      const open = editStepRef.current;
      if (continuous && open !== null && open.deviceId === deviceId) {
        window.clearTimeout(open.timer);
        open.timer = window.setTimeout(sealEditStep, EDIT_STEP_IDLE_MS);
      } else {
        sealEditStep();
        if (continuous) {
          editStepRef.current = {
            deviceId,
            before,
            timer: window.setTimeout(sealEditStep, EDIT_STEP_IDLE_MS),
          };
        } else {
          setEditHistory((current) => ({
            ...current,
            [deviceId]: pushUndo(current[deviceId] ?? EMPTY_EDIT_HISTORY, before),
          }));
        }
      }
      setDeviceEdits((current) => {
        const base = current[deviceId] ?? EMPTY_DEVICE_EDIT;
        const next = mutate(base.symbolEdits);
        if (next === base.symbolEdits) {
          return current;
        }
        return {
          ...current,
          [deviceId]: { ...base, symbolEdits: next },
        };
      });
    },
    [sealEditStep, symbolEditsOf],
  );

  const currentEditHistory =
    (selectedKeyId === null ? undefined : editHistory[selectedKeyId]) ?? EMPTY_EDIT_HISTORY;

  const undoEdit = useCallback((): void => {
    const sealed = sealEditStep();
    if (selectedKeyId === null) {
      return;
    }
    // 刚结算的这一步还没进 state，先并进来，否则"拖完立刻 Ctrl+Z"会没反应
    const stack =
      sealed !== null && sealed.deviceId === selectedKeyId
        ? pushUndo(currentEditHistory, sealed.before)
        : currentEditHistory;
    const result = undoOnce(stack, symbolEditsOf(selectedKeyId));
    if (result === null) {
      return;
    }
    setEditHistory((current) => ({ ...current, [selectedKeyId]: result.history }));
    setDeviceEdits((current) => ({
      ...current,
      [selectedKeyId]: {
        ...(current[selectedKeyId] ?? EMPTY_DEVICE_EDIT),
        symbolEdits: result.edits,
      },
    }));
  }, [currentEditHistory, sealEditStep, selectedKeyId, symbolEditsOf]);

  const redoEdit = useCallback((): void => {
    const sealed = sealEditStep();
    if (selectedKeyId === null) {
      return;
    }
    const stack =
      sealed !== null && sealed.deviceId === selectedKeyId
        ? pushUndo(currentEditHistory, sealed.before)
        : currentEditHistory;
    const result = redoOnce(stack, symbolEditsOf(selectedKeyId));
    if (result === null) {
      return;
    }
    setEditHistory((current) => ({ ...current, [selectedKeyId]: result.history }));
    setDeviceEdits((current) => ({
      ...current,
      [selectedKeyId]: {
        ...(current[selectedKeyId] ?? EMPTY_DEVICE_EDIT),
        symbolEdits: result.edits,
      },
    }));
  }, [currentEditHistory, sealEditStep, selectedKeyId, symbolEditsOf]);

  const updateDeviceEdit = (id: string, patch: Partial<DeviceEdit>): void => {
    setDeviceEdits((current) => ({
      ...current,
      [id]: { ...EMPTY_DEVICE_EDIT, ...current[id], ...patch },
    }));
  };

  /** 平移一个元素（图形或引脚）—— 拖动与方向键共用。 */
  const moveSymbolElement = useCallback(
    (id: string, key: string, dx: number, dy: number): void => {
      // continuous：一次拖动（或长按方向键）合并成同一个撤销点
      mutateSymbolEdits(id, (edits) => accumulateOffset(edits, key, dx, dy), true);
    },
    [mutateSymbolEdits],
  );

  /**
   * 符号预览里"按住左键拖动元素"的落点 —— **整组一起移动**（框选出来的多选）。
   * 引用必须稳定：引脚层是 memo 的，拖动时每一帧 setState 都会重渲染 App，
   * 匿名回调会把 676 个引脚的 memo 全部打穿（拖动明显发顿）。
   */
  const moveSelectedElements = useCallback(
    (keys: readonly string[], dx: number, dy: number): void => {
      if (selectedKeyId === null || keys.length === 0) {
        return;
      }
      // continuous：一次拖动合并成同一个撤销点
      mutateSymbolEdits(
        selectedKeyId,
        (edits) => keys.reduce((acc, key) => accumulateOffset(acc, key, dx, dy), edits),
        true,
      );
    },
    [mutateSymbolEdits, selectedKeyId],
  );

  /** 拖本体框线改大小（绝对值 + 被拖的边，来自 SymbolPreview 的边界计算）。 */
  const resizeSelectedRect = useCallback(
    (key: string, bounds: SymbolShapeBounds, dragged: RectEdges): void => {
      if (selectedKeyId === null) {
        return;
      }
      mutateSymbolEdits(
        selectedKeyId,
        (edits) => {
          const next = setRectBounds(edits, key, bounds, dragged);
          // 引脚跟着边走（用户 2026-10-21）：本体改大小后，每条边上的引脚重新贴边；
          // 缩小时沿边夹紧，出现重叠就把这一排均匀铺开。
          if (previewSection === null) {
            return next;
          }
          const finalBounds = next[key]?.bounds;
          if (finalBounds === undefined) {
            return next;
          }
          const entries = reattachPinsToBounds(
            previewSection,
            sectionIndex,
            { minX: finalBounds.min.x, minY: finalBounds.min.y, maxX: finalBounds.max.x, maxY: finalBounds.max.y },
            snapState,
          );
          if (entries.length === 0) {
            return next;
          }
          // 直接赋值而不是逐条 reduce：676 脚的器件每帧 reduce 会 O(n²)
          const withPins: Record<string, SymbolEdit> = { ...next };
          for (const entry of entries) {
            withPins[entry.key] = { points: entry.points };
          }
          return withPins;
        },
        true,
      );
    },
    [mutateSymbolEdits, previewSection, sectionIndex, selectedKeyId, snapState],
  );

  /**
   * 对齐 / 分布（用户 2026-10-20）：算出每个元素的位移后一次性写入。
   * `continuous=false` → 先结算上一步、再压一个新撤销点：一次对齐 = 一次 Ctrl+Z。
   */
  const applyLayoutAction = useCallback(
    (action: string): void => {
      if (selectedKeyId === null || previewSection === null || selectedKeys.length < 2) {
        return;
      }
      const offsets = planLayoutAction(collectBoxes(previewSection, selectedKeys), action);
      if (offsets.size === 0) {
        return;
      }
      mutateSymbolEdits(
        selectedKeyId,
        (edits) =>
          [...offsets].reduce(
            (acc, [key, offset]) => accumulateOffset(acc, key, offset.dx, offset.dy),
            edits,
          ),
        false,
      );
    },
    [mutateSymbolEdits, previewSection, selectedKeyId, selectedKeys],
  );

  /**
   * 拖动结束后的引脚重定向（用户 2026-10-21）：拖到本体另一侧时方向要翻过来。
   * continuous=true → 并进当前拖动那一步撤销，不额外多一个撤销点。
   */
  const reorientPins = useCallback(
    (entries: readonly { readonly key: string; readonly points: SymbolPinPoints }[]): void => {
      if (selectedKeyId === null || entries.length === 0) {
        return;
      }
      mutateSymbolEdits(
        selectedKeyId,
        (edits) =>
          entries.reduce((acc, entry) => setPinPoints(acc, entry.key, entry.points), edits),
        true,
      );
    },
    [mutateSymbolEdits, selectedKeyId],
  );

  /** 双击文本改内容（用户 2026-10-21）：一次提交 = 一个撤销点。 */
  const editTextContent = useCallback(
    (key: string, text: string): void => {
      if (selectedKeyId === null) {
        return;
      }
      mutateSymbolEdits(selectedKeyId, (edits) => setTextContent(edits, key, text), false);
    },
    [mutateSymbolEdits, selectedKeyId],
  );

  /**
   * 添加文本（用户 2026-10-21）：放在本体中心、默认字号，追加为该段末尾的文本形状，
   * 然后自动进入行内编辑。追加的形状下标稳定，可拖动/改字/进属性面板。
   */
  const addDeviceText = useCallback((): void => {
    if (selectedKeyId === null || previewSection === null || previewBounds === null) {
      return;
    }
    const shape: AddedTextShape = {
      id: `t${Date.now().toString(36)}`,
      section: sectionIndex,
      text: "文本",
      at: {
        x: snapValue((previewBounds.minX + previewBounds.maxX) / 2, snapGrid),
        y: snapValue((previewBounds.minY + previewBounds.maxY) / 2, snapGrid),
      },
      height: DEFAULT_SYMBOL_TEXT_HEIGHT,
    };
    const key = symbolShapeKey(sectionIndex, previewSection.shapes.length);
    setDeviceEdits((current) => ({
      ...current,
      [selectedKeyId]: {
        ...(current[selectedKeyId] ?? EMPTY_DEVICE_EDIT),
        addedTexts: [...(current[selectedKeyId]?.addedTexts ?? []), shape],
      },
    }));
    setSelectedKeys([key]);
    setTextEditRequest({ key, nonce: Date.now() });
  }, [previewBounds, previewSection, sectionIndex, selectedKeyId, snapGrid]);

  /** 双击引脚名/脚号改字（用户 2026-10-22）：一次提交 = 一个撤销点。 */
  const editPinText = useCallback(
    (key: string, kind: "name" | "number", text: string): void => {
      if (selectedKeyId === null) {
        return;
      }
      mutateSymbolEdits(selectedKeyId, (edits) => setPinText(edits, key, kind, text), false);
    },
    [mutateSymbolEdits, selectedKeyId],
  );

  /** 编辑模式下点画布空白处 = 取消选中当前元素。 */
  const clearSymbolSelection = useCallback((): void => {
    setSelectedKeys([]);
  }, []);

  /** 属性面板提交：绝对值写入（rect 的 X/Y 只动 offset，宽高只动 bounds）。 */
  const commitElementField = useCallback(
    (field: ElementField, value: number): void => {
      if (selectedKeyId === null || rawSection === null || selectedKeys.length !== 1) {
        return;
      }
      const key = selectedKeys[0];
      mutateSymbolEdits(
        selectedKeyId,
        (edits) => {
          switch (field) {
            case "x":
              return writeElementX(rawSection, edits, key, value);
            case "y":
              return writeElementY(rawSection, edits, key, value);
            case "width":
              return writeElementWidth(rawSection, edits, key, value);
            case "height":
              return writeElementHeight(rawSection, edits, key, value);
            case "textHeight":
              return writeTextHeight(rawSection, edits, key, value);
            default:
              return writeTextRotation(rawSection, edits, key, value);
          }
        },
        false,
      );
    },
    [mutateSymbolEdits, rawSection, selectedKeyId, selectedKeys],
  );

  /** 旋转一个文本（90° 步进）。单次操作：每按一次一个撤销点。 */
  const rotateSymbolText = (id: string, key: string): void => {
    mutateSymbolEdits(id, (edits) => accumulateRotation(edits, key), false);
  };

  /** 缩放一个文本的字号。 */
  const scaleSymbolText = (id: string, key: string, factor: number): void => {
    mutateSymbolEdits(id, (edits) => accumulateFontSize(edits, key, factor), false);
  };

  /**
   * 编辑模式快捷键（用户 2026-10-16 要求"空格旋转、上下左右移动、更多按键"）：
   *   ← ↑ → ↓  平移一格（吸附开：按当前档位 10/5 单位；Shift=1 单位精调，
   *             Alt=10 格粗调；吸附关：1/1/10 单位）—— 选中的**全部**元素一起动
   *   空格 / R  文本旋转 90°（仅单选一个文本时）
   *   [ / -    文本字号缩小（仅单选一个文本时）
   *   ] / =    文本字号放大（仅单选一个文本时）
   *   Ctrl+Z / Ctrl+Shift+Z  退回 / 前进（见下面那条 effect）
   *   Esc      取消选择
   * 只在「编辑」开着、且已选中元素时接管按键；输入框聚焦时不抢。
   */
  useEffect(() => {
    if (
      !editMode ||
      previewTab !== "sch" ||
      selected === null ||
      selectedKeys.length === 0
    ) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      // 新增的档位/对齐 <select> 也会吞方向键 —— 统一用 closest 判输入控件
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable]") !== null
      ) {
        return;
      }
      const step = arrowStep(snapState, { shift: event.shiftKey, alt: event.altKey });
      const deltas: Record<string, readonly [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (event.key in deltas) {
        event.preventDefault();
        const [dx, dy] = deltas[event.key];
        // 方向键动的是**全部选中**的元素（框选出来的那一批一起微调）
        moveSelectedElements(selectedKeys, dx, dy);
        return;
      }
      if (selectedShapeKey === null) {
        return; // 多选时旋转/字号没有意义（那是单选文本的操作）
      }
      if (event.key === " " || event.key.toLowerCase() === "r") {
        if (!selectedIsText) {
          return;
        }
        event.preventDefault();
        rotateSymbolText(selected.id, selectedShapeKey);
        return;
      }
      if ((event.key === "[" || event.key === "-") && selectedIsText) {
        event.preventDefault();
        scaleSymbolText(selected.id, selectedShapeKey, 1 / 1.15);
        return;
      }
      if ((event.key === "]" || event.key === "=" || event.key === "+") && selectedIsText) {
        event.preventDefault();
        scaleSymbolText(selected.id, selectedShapeKey, 1.15);
        return;
      }
      if (event.key === "Escape") {
        setSelectedKeys([]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    editMode,
    previewTab,
    selected,
    selectedKeys,
    selectedShapeKey,
    selectedIsText,
    moveSelectedElements,
    rotateSymbolText,
    scaleSymbolText,
    snapState,
  ]);

  /**
   * Ctrl/Cmd+A 全选（用户 2026-10-20）：语义与框选一致 —— 引脚 + 非 rect 图形。
   * 单独一条 effect：不要求"已经选中了什么"（上面那条在空选时直接 return）。
   */
  useEffect(() => {
    if (!editMode || previewTab !== "sch" || previewSection === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable]") !== null
      ) {
        return;
      }
      event.preventDefault();
      setSelectedKeys(symbolSelectableKeys(previewSection, sectionIndex));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editMode, previewTab, previewSection, sectionIndex]);

  /**
   * 撤销 / 重做快捷键（用户 2026-10-16 要求"编辑支持退回步骤 + 添加快捷键"）：
   *   Ctrl+Z            退回一步
   *   Ctrl+Shift+Z / Ctrl+Y  前进回来
   * 与上面那条不同：**不要求先选中元素** —— 退回一步之后往往正好是"什么都没选"的状态。
   */
  useEffect(() => {
    if (!editMode || previewTab !== "sch") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable]") !== null
      ) {
        return;
      }
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoEdit();
        } else {
          undoEdit();
        }
        return;
      }
      if (key === "y") {
        event.preventDefault();
        redoEdit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editMode, previewTab, undoEdit, redoEdit]);

  /** 生成时用的封装计划：套上用户改过的 PCB 封装名。 */
  const planFor = (id: string): ConversionPlan | null => {
    const plan = plans[id];
    if (plan === undefined) {
      return null;
    }
    const raw = deviceEdits[id]?.pcbName ?? null;
    const name = raw === null ? "" : sanitizeLibraryName(raw);
    if (name.length === 0) {
      return plan;
    }
    return {
      ...plan,
      footprint: { ...plan.footprint, info: { ...plan.footprint.info, targetPackageName: name } },
    };
  };

  /** 生成时用的符号：套上用户改过的符号名与手工调整。 */
  const symbolFor = (id: string): NormalizedSymbol | null => {
    const entry = symbols[id];
    return entry === undefined ? null : applyEdits(entry.symbol, deviceEdits[id] ?? EMPTY_DEVICE_EDIT);
  };

  useEffect(
    () =>
      api.onGenerationProgress((item) => {
        progressRef.current = item;
        setProgress(item);
      }),
    [],
  );

  const updateItem = (id: string, patch: Partial<QueueItem>): void => {
    setQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  /**
   * 从队列里删掉器件（用户 2026-10-19 要求）。
   *
   * 不能只 `filter(queue)`：每台器件在 plans / symbols / olbOutcomes / deviceEdits /
   * editHistory 里各有一份状态，留着的话**同一个编号再次导入会带着上次的残留**
   * （改过的封装名、拖过的符号、上一次的撤销栈）。
   */
  const removeDevices = useCallback((ids: readonly string[]): void => {
    if (ids.length === 0) {
      return;
    }
    const gone = new Set(ids);
    const drop = <T,>(record: Readonly<Record<string, T>>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !gone.has(key)));

    setQueue((current) => current.filter((item) => !gone.has(item.id)));
    setPlans((current) => drop(current));
    setSymbols((current) => drop(current));
    setOlbOutcomes((current) => drop(current));
    setDeviceEdits((current) => drop(current));
    setEditHistory((current) => drop(current));
    setSelectedKeys([]);
    // 正在结算的"一步"如果属于被删掉的器件，定时器与快照一起丢掉。
    if (editStepRef.current !== null && gone.has(editStepRef.current.deviceId)) {
      window.clearTimeout(editStepRef.current.timer);
      editStepRef.current = null;
    }
  }, []);

  /** 删一台：选中它时顺手把选中项挪到相邻器件，别让右侧预览空着。 */
  const removeDevice = (id: string): void => {
    if (selectedId === id) {
      const index = queue.findIndex((item) => item.id === id);
      const neighbour = queue[index + 1]?.id ?? queue[index - 1]?.id ?? null;
      setSelectedId(neighbour);
    }
    removeDevices([id]);
  };

  /** 把一批 C 编号加入队列并读取（搜索命中后也走这里）。 */
  const importIdList = async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) {
      return;
    }
    const existing = new Set(queue.map((item) => item.id));
    const newItems = ids
      .filter((id) => !existing.has(id))
      .map<QueueItem>((id) => ({
        id,
        state: "loading",
        footprint: null,
        message: "正在读取器件信息…",
        selected: true,
      }));
    if (newItems.length === 0) {
      setSelectedId(ids[0] ?? null);
      return;
    }
    const nextQueue = [...queue, ...newItems];
    setQueue(nextQueue);
    setSelectedId(newItems[0]?.id ?? null);
    setInput("");
    const loaded = await Promise.all(
      newItems.map(
        async (
          item,
        ): Promise<{ item: QueueItem; plan: ConversionPlan | null; symbol: NormalizedSymbol | null }> => {
          try {
            const footprint = await api.fetchComponent(item.id);
            const plan = await api.createPlan(footprint);
            // 原理图元件就在同一次接口响应里（主进程缓存了原始响应，不额外发请求）；
            // 器件本来就没有符号时为 null，不算错误。
            const symbol = await api.fetchSymbol(item.id).catch(() => null);
            return {
              item: {
                ...item,
                state: plan.checks.some((check) => check.severity === "warning") ? "warning" : "ready",
                footprint,
                message: "已读取，等待生成",
              },
              plan,
              symbol,
            };
          } catch (error) {
            return {
              item: {
                ...item,
                state: "error",
                message: errorMessage(error),
              },
              plan: null,
              symbol: null,
            };
          }
        },
      ),
    );
    const loadedMap = new Map(loaded.map((result) => [result.item.id, result.item]));
    setQueue(nextQueue.map((item) => loadedMap.get(item.id) ?? item));
    setPlans((current) => {
      const additions = Object.fromEntries(
        loaded
          .filter(
            (
              result,
            ): result is {
              item: QueueItem;
              plan: ConversionPlan;
              symbol: NormalizedSymbol | null;
            } => result.plan !== null,
          )
          .map((result) => [result.item.id, result.plan]),
      );
      return { ...current, ...additions };
    });
    setSymbols((current) => {
      const additions: Record<string, SymbolEntry> = {};
      for (const result of loaded) {
        if (result.symbol !== null) {
          // 没指定 .olb 时按立创编号自动建库（C2040.olb）
          additions[result.item.id] = { symbol: result.symbol, libraryName: result.item.id };
        }
      }
      return { ...current, ...additions };
    });
  };

  /**
   * 关键字搜索（用户 2026-10-19 要求"输入元件名模糊搜索"）。
   * 输入框里的非 C 编号词条按关键字处理，命中的结果列在输入框下方，点一下即加入队列。
   * 例：输入 LMK00301ARHST → 命中 C2866150。
   */
  const runSearch = async (keyword: string): Promise<void> => {
    setSearching(true);
    setSearchError(null);
    setSearchHits(null);
    setSearchKeyword(keyword);
    try {
      const result = await api.searchProducts(keyword);
      setSearchHits(result.hits);
      if (result.hits.length === 0) {
        setSearchError(`没有找到与「${keyword}」匹配的元件，换个型号或封装关键字试试`);
      }
    } catch (error) {
      setSearchError(errorMessage(error));
    } finally {
      setSearching(false);
    }
  };

  /** 输入框 → 有 C 编号就直接导入，其余当关键字搜索。 */
  const importIds = async (): Promise<void> => {
    const tokens = splitIds(input);
    if (tokens.length === 0) {
      return;
    }
    const ids = tokens.filter((token) => /^C\d+$/.test(token));
    const keywords = tokens.filter((token) => !/^C\d+$/.test(token));
    if (ids.length > 0) {
      setInput("");
      await importIdList(ids);
    }
    if (keywords.length > 0) {
      // 多个关键字时只搜第一个：搜索是给"找一个型号"用的，不是批量入口
      await runSearch(keywords[0]);
    }
  };

  /** 点搜索结果 = 把该 C 编号加入队列。 */
  const addSearchHit = (lcscId: string): void => {
    setSearchHits(null);
    setSearchError(null);
    setSearchKeyword(null);
    void importIdList([lcscId]);
  };

  /**
   * 「导入本地库」：每次都弹选择框，但**默认落在上次用过的目录**。
   *
   * 记住的是目录而不是文件（用户 2026-10-16 要求）—— 换库文件时通常就在同一个
   * 目录里挑，之前一进来就直接复用旧文件、反而没法换。
   */
  const importLocalLibrary = async (): Promise<void> => {
    setLocalError(null);
    setLocalLoading(true);
    try {
      const filePath = await api.chooseLocalLibraryFile(settings.ui.localLibraryDir);
      if (filePath === null) {
        return;
      }
      const directory = directoryOfPath(filePath);
      if (directory !== null && directory !== settings.ui.localLibraryDir) {
        onUiChange({ localLibraryDir: directory });
      }
      const devices = await api.readLocalLibrary(filePath);
      if (devices.length === 0) {
        setLocalError("库文件中没有找到带封装的器件。");
        return;
      }
      const makeItem = (device: LocalLibraryDeviceSummary): QueueItem => ({
        id: device.lcscId,
        state: "loading",
        footprint: null,
        message: `读取本地库：${device.footprintTitle}（${device.padCount} 脚）`,
        selected: true,
        local: { sourcePath: device.sourcePath, deviceUuid: device.deviceUuid },
      });
      // 合并规则：同 id 已存在且是 error 项 → 替换重读；**符号条目丢了也重读**
      // （用户 2026-10-19：重新导入后"原理图元件"tab 灰掉点不动 —— 旧的"非 error
      // 就跳过"会让 symbols 表缺了之后永远补不回来，PCB 预览正常但符号没了）。
      const nextQueue = [...queue];
      const targets: LocalLibraryDeviceSummary[] = [];
      for (const device of devices) {
        const index = nextQueue.findIndex((item) => item.id === device.lcscId);
        if (index >= 0) {
          if (
            nextQueue[index].state === "error" ||
            symbols[nextQueue[index].id] === undefined
          ) {
            nextQueue[index] = makeItem(device);
            targets.push(device);
          }
          continue;
        }
        nextQueue.push(makeItem(device));
        targets.push(device);
      }
      if (targets.length === 0) {
        setQueue(nextQueue);
        return;
      }
      setQueue(nextQueue);
      setSelectedId(targets[0].lcscId);
      const loaded = await Promise.all(
        targets.map(async (device) => {
          try {
            // 符号与封装来自同一份归档；符号缺失（标准版链路）不算错误，
            // 只意味着这一次没有原理图库可生成。
            const [footprint, symbol] = await Promise.all([
              api.fetchLocalComponent(device.sourcePath, device.deviceUuid),
              api
                .fetchLocalSymbol(device.sourcePath, device.deviceUuid)
                .catch(() => null),
            ]);
            const plan = await api.createPlan(footprint);
            return {
              id: device.lcscId,
              footprint,
              plan,
              symbol,
              libraryName: libraryNameOf(device.sourcePath),
              error: null as string | null,
            };
          } catch (error) {
            return {
              id: device.lcscId,
              footprint: null,
              plan: null,
              symbol: null,
              libraryName: libraryNameOf(device.sourcePath),
              error: errorMessage(error),
            };
          }
        }),
      );
      const loadedMap = new Map(loaded.map((entry) => [entry.id, entry]));
      setQueue((current) =>
        current.map((item) => {
          const entry = loadedMap.get(item.id);
          if (entry === undefined) {
            return item;
          }
          if (entry.error !== null) {
            return { ...item, state: "error", message: entry.error };
          }
          return {
            ...item,
            state: entry.plan!.checks.some((check) => check.severity === "warning")
              ? "warning"
              : "ready",
            footprint: entry.footprint,
            message: "已读取，等待生成",
          };
        }),
      );
      setPlans((current) => {
        const additions: Record<string, ConversionPlan> = {};
        for (const entry of loaded) {
          if (entry.plan !== null) {
            additions[entry.id] = entry.plan;
          }
        }
        return { ...current, ...additions };
      });
      setSymbols((current) => {
        const additions: Record<string, SymbolEntry> = {};
        for (const entry of loaded) {
          if (entry.symbol !== null) {
            additions[entry.id] = {
              symbol: entry.symbol,
              libraryName: entry.libraryName,
            };
          }
        }
        return { ...current, ...additions };
      });
      setOlbOutcomes((current) => {
        const next: Record<string, OlbOutcome> = { ...current };
        for (const entry of loaded) {
          delete next[entry.id];
        }
        return next;
      });
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setLocalLoading(false);
    }
  };

  const generateSelected = async (): Promise<void> => {
    const items = generatableItems;
    if (items.length === 0) {
      // 按钮不再做灰，点下去要把"为什么现在生成不了"说清楚
      setLocalError(generateTitle);
      return;
    }
    setLocalError(null);
    const wantPcb = targets.pcb;
    const wantSymbol = targets.symbol;
    setRunning(true);
    try {
    for (const item of items) {
      const plan = planFor(item.id);
      const symbol = wantSymbol ? symbolFor(item.id) : null;
      const entry = symbols[item.id];
      const notes: string[] = [];
      let pcbFailure: string | null = null;
      let pcbResult: ConversionResult | null = null;

      updateItem(item.id, {
        state: "loading",
        message: wantPcb ? "Allegro 正在生成并检查…" : "正在写入原理图元件库（.olb）…",
      });

      // ① PCB 封装（.dra/.psm/.pad）
      if (wantPcb && plan !== null) {
        const startingProgress: GenerationProgress = {
          lcscId: item.id,
          stage: "preparing",
          percent: 1,
          message: "正在提交生成任务",
          diagnosticDirectory: null,
          timestamp: new Date().toISOString(),
        };
        progressRef.current = startingProgress;
        setProgress(startingProgress);
        try {
          pcbResult = await api.generate(plan);
          notes.push(pcbResult.message);
        } catch (error) {
          const previousProgress = progressRef.current;
          const reportedFailure =
            previousProgress?.lcscId === item.id && previousProgress.stage === "failed"
              ? previousProgress
              : null;
          pcbFailure = reportedFailure?.message ?? errorMessage(error);
        }
      }

      // ② 原理图元件（.olb）—— 与封装相互独立：封装失败也不该拦着符号落库。
      if (wantSymbol && symbol !== null && entry !== undefined) {
        updateItem(item.id, { state: "loading", message: "正在写入原理图元件库（.olb）…" });
        try {
          const request = {
            symbol,
            libraryPath: settings.olbLibraryPath,
            libraryName: entry.libraryName,
            // 跟随界面磁吸开关（用户 2026-10-20）：关掉后写库按实际坐标，仍取整
            snapPins: settings.ui.symbolSnapEnabled,
          };
          let outcome = await api.writeOlb(request);
          // 库里已有同名器件 → 二次确认后再覆盖（用户 2026-10-16 要求）。
          // 实测 mode 1 会覆盖，但得让用户知道"这次会换掉旧内容"。
          if (outcome.status === "needsConfirm") {
            const confirmed = await askOverwriteConfirm(outcome);
            if (!confirmed) {
              const message = `已跳过 ${outcome.packageName}：${basenameOf(outcome.libraryPath)} 里已有同名器件`;
              setOlbOutcomes((current) => ({
                ...current,
                [item.id]: { status: "failed", message },
              }));
              notes.push(message);
              if (pcbFailure === null) {
                pcbFailure = message;
              }
              updateItem(item.id, { state: "generationFailed", message });
              continue;
            }
            outcome = await api.writeOlb({ ...request, confirmOverwrite: true });
          }
          if (outcome.status === "written") {
            setOlbOutcomes((current) => ({
              ...current,
              [item.id]: { status: "ok", result: outcome.result },
            }));
            notes.push(outcome.result.message);
          }
        } catch (error) {
          const message = errorMessage(error);
          setOlbOutcomes((current) => ({
            ...current,
            [item.id]: { status: "failed", message },
          }));
          notes.push(`原理图元件库未写入：${message}`);
          if (pcbFailure === null) {
            pcbFailure = message;
          }
        }
      }

      if (pcbFailure !== null) {
        updateItem(item.id, {
          state: "generationFailed",
          message: `上次生成失败，可直接重试：${pcbFailure}`,
        });
        if (wantPcb && pcbResult === null) {
          const previousProgress = progressRef.current;
          const failedProgress: GenerationProgress = {
            lcscId: item.id,
            stage: "failed",
            percent:
              previousProgress?.lcscId === item.id ? Math.min(previousProgress.percent, 99) : 1,
            message: pcbFailure,
            diagnosticDirectory: previousProgress?.lcscId === item.id ? previousProgress.diagnosticDirectory : null,
            timestamp: new Date().toISOString(),
          };
          progressRef.current = failedProgress;
          setProgress(failedProgress);
        }
      } else {
        updateItem(item.id, { state: "generated", message: notes.join("") });
      }
      if (pcbResult !== null) {
        onGenerated({ ...pcbResult, id: `${pcbResult.lcscId}-${pcbResult.completedAt}` });
      }
    }
    } finally {
      // 任何一步抛出来都不能把 running 卡在 true —— 那会让按钮永远灰着（用户 2026-10-19）
      setRunning(false);
    }
  };

  // ---------- 侧栏宽度（可拖动，宽度持久化在 settings.ui 里）----------
  const leftWidth = liveRail?.side === "left" ? liveRail.width : settings.ui.leftRailWidth;
  const rightWidth = liveRail?.side === "right" ? liveRail.width : settings.ui.rightRailWidth;
  const collapsedSections = settings.ui.collapsedSections;
  const layerColors = settings.ui.layerColors;

  const askOverwriteConfirm = (
    request: Extract<OlbWriteOutcome, { status: "needsConfirm" }>,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      setOverwriteAsk({ request, resolve });
    });

  const toggleSection = (id: string): void => {
    onUiChange({
      collapsedSections: collapsedSections.includes(id)
        ? collapsedSections.filter((item) => item !== id)
        : [...collapsedSections, id],
    });
  };

  /**
   * 拖动侧栏边缘调宽。拖动过程只动本地状态（跟手），松手才写设置，
   * 免得每一帧都走一次 IPC。
   */
  const startRailDrag =
    (side: "left" | "right") =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth = side === "left" ? leftWidth : rightWidth;
      const range = side === "left" ? LEFT_RAIL_RANGE : RIGHT_RAIL_RANGE;
      let width = startWidth;
      const onMove = (moveEvent: PointerEvent): void => {
        // 右侧栏拖的是它的左边缘，方向相反
        const delta = side === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        width = Math.min(Math.max(Math.round(startWidth + delta), range.min), range.max);
        setLiveRail({ side, width });
      };
      const onEnd = (): void => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        setLiveRail(null);
        onUiChange(side === "left" ? { leftRailWidth: width } : { rightRailWidth: width });
      };
      handle.setPointerCapture(event.pointerId);
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    };

  const readyCount = generatableItems.length;
  const retryCount = generatableItems.filter((item) => item.state === "generationFailed").length;
  const regenerateOnly = shouldOfferRegeneration(generatableItems);
  const wantsNothing = !targets.pcb && !targets.symbol;
  const pcbBlocked = targets.pcb && allegroInstall === null;
  /**
   * 生成按钮**只在运行中变灰**（用户 2026-10-19："不需要进行变灰处理，需要每次都能执行"）。
   * 其它"现在不能生成"的情况改成点一下把原因写在输入框下方，而不是把按钮做灰 ——
   * 灰按钮不给原因，用户只会觉得"点了没反应"。
   */
  const generateDisabled = running;
  const generateTitle = running
    ? "正在生成…"
    : wantsNothing
      ? "至少勾选一种生成内容"
      : readyCount === 0
        ? // 只勾符号且确实勾了器件 → 是"没有符号数据"，不是"没勾选"
          (!targets.pcb && queue.some((item) => item.selected)
            ? "勾选的器件没有原理图元件数据"
            : runnableItems.length > 0
              ? "勾选的器件没有原理图元件数据（立创编号链路只有封装）"
              : "先在左侧勾选至少一个已读取的器件")
        : pcbBlocked
          ? "生成 PCB 封装需要先检测到 Allegro"
          : retryCount > 0 || regenerateOnly
            ? "对勾选的器件再跑一次"
            : "对勾选的器件生成所选内容";
  const generateLabel = running
    ? "正在生成…"
    : wantsNothing
      ? "未选择生成内容"
      : pcbBlocked
        ? "未检测到 Allegro"
        : `${retryCount > 0 || regenerateOnly ? "重新" : ""}${
            targets.pcb && targets.symbol
              ? "生成并验证"
              : targets.pcb
                ? "生成 PCB 封装"
                : "写入原理图元件"
          }`;
  return (
    <>
    <main
      className={`workbench${liveRail === null ? "" : " is-resizing"}`}
      style={{ gridTemplateColumns: `${leftWidth}px minmax(360px, 1fr) ${rightWidth}px` }}
    >
      <aside className="left-rail">
        <div className="rail-header">
          <h2>待转换器件</h2>
          <span>{queue.length} 项</span>
        </div>
        <div className="input-block">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入立创编号或型号，如 C2040 / LMK00301ARHST"
            data-testid="lcsc-input"
          />
          <div className="input-actions">
            <button className="primary-button" type="button" onClick={() => void importIds()} data-testid="import-button">
              <Search size={16} />查询
            </button>
            <button className="secondary-button" type="button" onClick={() => setInput("")}>
              <Plus size={16} />导入清单
            </button>
            <button
              className="secondary-button wide-action"
              type="button"
              onClick={() => void importLocalLibrary()}
              disabled={localLoading}
              data-testid="import-local-button"
              title={
                settings.ui.localLibraryDir === null
                  ? "导入立创EDA专业版导出的 .elibz2 库文件，无需立创编号"
                  : `选择框会打开上次用过的目录：${settings.ui.localLibraryDir}`
              }
            >
              <FolderOpen size={16} />{localLoading ? "解析中…" : "导入本地库"}
            </button>
          </div>
          {settings.ui.localLibraryDir === null ? null : (
            <p className="local-library-hint" title={settings.ui.localLibraryDir}>
              上次目录：{basenameOf(settings.ui.localLibraryDir)}
            </p>
          )}
          {/* 关键字搜索结果：输入型号（如 LMK00301ARHST）时列在这里，点一下加入队列 */}
          {searching ? (
            <p className="local-library-hint">正在搜索 {searchKeyword ?? ""} …</p>
          ) : null}
          {searchHits !== null && searchHits.length > 0 ? (
            <div className="search-results" data-testid="search-results">
              <div className="search-results-header">
                <span>「{searchKeyword}」命中 {searchHits.length} 个</span>
                <button
                  type="button"
                  className="legend-reset"
                  onClick={() => {
                    setSearchHits(null);
                    setSearchError(null);
                    setSearchKeyword(null);
                  }}
                >
                  关闭
                </button>
              </div>
              {searchHits.map((hit) => (
                <button
                  key={hit.lcscId}
                  type="button"
                  className="search-hit"
                  onClick={() => addSearchHit(hit.lcscId)}
                  title={`${hit.manufacturer} ${hit.mpn}`}
                  data-testid={`search-hit-${hit.lcscId}`}
                >
                  <strong>{hit.lcscId}</strong>
                  <span className="search-hit-mpn">{hit.mpn}</span>
                  <span className="search-hit-meta">{hit.package}</span>
                  <span className="search-hit-meta">库存 {hit.stock}</span>
                </button>
              ))}
            </div>
          ) : null}
          {searchError === null ? null : (
            <p className="local-import-error" data-testid="search-error">{searchError}</p>
          )}
          {localError === null ? null : (
            <p className="local-import-error" data-testid="local-import-error">{localError}</p>
          )}
        </div>
        <div className="queue-columns"><span>器件 / 封装</span><span>状态</span></div>
        <div className="rail-list">
          {queue.length === 0 ? (
            <div className="empty-state"><Layers3 size={28} /><strong>暂无器件</strong><span>先查询一个立创编号</span></div>
          ) : queue.map((item) => (
            /* 行本身是按钮，删除按钮只能做**兄弟节点**（button 里不能再嵌 button），
             * 用绝对定位压在同一行的右上角，悬停/聚焦时才浮出来。 */
            <div className="rail-item-wrap" key={item.id}>
              <button
                type="button"
                className={`rail-item ${selected?.id === item.id ? "selected" : ""}`}
                onClick={() => setSelectedId(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Delete") {
                    event.preventDefault();
                    removeDevice(item.id);
                  }
                }}
                data-testid={`queue-item-${item.id}`}
              >
                <input
                  type="checkbox"
                  checked={item.selected}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => updateItem(item.id, { selected: event.target.checked })}
                  aria-label={`选择 ${item.id}`}
                />
                <span className={`source-dot ${item.state}`} />
                <div>
                  <strong>{item.id}</strong><small>{item.footprint?.info.name ?? ""}</small>
                  {/* 失败时必须让用户看到原因（2026-10-19：Capture 占着库导致写入被拒，
                   * 但 em 槽位被封装名占着，错误文本根本显示不出来，用户只看到红 X） */}
                  {item.state === "error" || item.state === "generationFailed" ? (
                    <em className="rail-error-text" title={item.message}>{item.message}</em>
                  ) : (
                    <em>{item.footprint?.info.sourcePackageName ?? item.message}</em>
                  )}
                </div>
                <div className={`rail-state ${item.state}`}>
                  {item.state === "loading" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : item.state === "warning" ? (
                    <TriangleAlert size={15} />
                  ) : item.state === "error" || item.state === "generationFailed" ? (
                    <X size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                </div>
              </button>
              <button
                type="button"
                className="rail-delete"
                onClick={() => removeDevice(item.id)}
                title={`从列表删除 ${item.id}`}
                aria-label={`删除 ${item.id}`}
                data-testid={`queue-remove-${item.id}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        {queue.length > 0 ? (
          <button
            className="clear-list"
            type="button"
            onClick={() => {
              removeDevices(queue.map((item) => item.id));
              setSelectedId(null);
            }}
            data-testid="clear-queue"
          >
            <Trash2 size={14} />清空列表
          </button>
        ) : null}
        <div
          className="rail-resizer rail-resizer-left"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整左侧栏宽度"
          title="拖动调整宽度"
          onPointerDown={startRailDrag("left")}
          onDoubleClick={() => onUiChange({ leftRailWidth: LEFT_RAIL_RANGE.min + 74 })}
          data-testid="rail-resizer-left"
        />
      </aside>

      <section className="main-stage">
        <header className="stage-heading">
          <div><h2>封装预览</h2><span>{selected?.id ?? ""} · {selected?.footprint?.info.sourcePackageName ?? "请选择器件"}</span></div>
          <div className="stage-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === "pcb"}
              className={previewTab === "pcb" ? "active" : ""}
              onClick={() => setPreviewTab("pcb")}
              disabled={selected?.footprint === null || selected?.footprint === undefined}
              data-testid="tab-pcb"
            >
              PCB 封装
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === "sch"}
              className={previewTab === "sch" ? "active" : ""}
              onClick={() => setPreviewTab("sch")}
              disabled={editedSymbol === null}
              title={editedSymbol === null ? "该器件的源数据里没有原理图元件" : undefined}
              data-testid="tab-sch"
            >
              原理图元件
            </button>
          </div>
          {previewTab === "sch" && editedSymbol !== null ? (
            <div className="edit-toolbar">
              <button
                type="button"
                className={`edit-mode-toggle ${editMode ? "on" : ""}`}
                onClick={() => {
                  setEditMode((current) => !current);
                  setSelectedKeys([]);
                }}
                title={
                  editMode
                    ? "退出编辑模式"
                    : "进入编辑：按住鼠标左键拖动图形/引脚即可移动（滚轮缩放、空白处拖动平移，方向键微调）"
                }
                data-testid="edit-mode-toggle"
              >
                <PenLine size={15} />
                {editMode ? "编辑中" : "编辑"}
              </button>
              {/* 撤销/重做：不依赖是否选中元素，编辑模式下一直可用（用户 2026-10-16 要求） */}
              <button
                type="button"
                className="edit-history-button"
                onClick={undoEdit}
                disabled={!canUndo(currentEditHistory)}
                title="退回一步（Ctrl+Z）"
                aria-label="撤销"
                data-testid="edit-undo"
              >
                <Undo2 size={15} />
              </button>
              <button
                type="button"
                className="edit-history-button"
                onClick={redoEdit}
                disabled={!canRedo(currentEditHistory)}
                title="前进回来（Ctrl+Shift+Z 或 Ctrl+Y）"
                aria-label="重做"
                data-testid="edit-redo"
              >
                <Redo2 size={15} />
              </button>
            </div>
          ) : null}
          {previewTab === "sch" && editedSymbol !== null && editedSymbol.sections.length > 1 ? (
            <div className="stage-sections" aria-label="符号分段">
              {editedSymbol.sections.map((section, index) => (
                <button
                  key={section.name}
                  type="button"
                  className={index === sectionIndex ? "active" : ""}
                  onClick={() => {
                    setSectionIndex(index);
                    setSelectedKeys([]);
                  }}
                  title={section.name}
                >
                  {String.fromCharCode(65 + (index % 26))}
                </button>
              ))}
            </div>
          ) : null}
        </header>
        <div className={`engineering-canvas${previewTab === "sch" ? " symbol-canvas" : ""}`}>
          {previewTab === "sch" && editedSymbol !== null && editMode ? (
            /* 网格/对齐工具条：放画布左上角而不是 52px 的 stage-heading ——
             * 1120px 最小窗口下 header 已经被标题、tabs、撤销按钮占满。 */
            <div className="symbol-toolbar" role="toolbar" aria-label="网格与对齐">
              <button
                type="button"
                className={`symbol-tool ${snapEnabled ? "on" : ""}`}
                onClick={() => onUiChange({ symbolSnapEnabled: !snapEnabled })}
                title={
                  snapEnabled
                    ? "吸附到网格：开（点击关闭；关闭后写库也按实际坐标）"
                    : "吸附到网格：关（点击开启）"
                }
                aria-pressed={snapEnabled}
                data-testid="snap-toggle"
              >
                <Magnet size={15} />
              </button>
              <select
                className="symbol-tool-select"
                value={snapGrid}
                onChange={(event) =>
                  onUiChange({ symbolSnapGrid: Number(event.target.value) === 5 ? 5 : 10 })
                }
                title="网格档位（背景网格与吸附同步）"
                aria-label="网格档位"
                data-testid="snap-grid"
              >
                <option value={10}>100 mil</option>
                <option value={5}>50 mil</option>
              </select>
              <button
                type="button"
                className={`symbol-tool ${gridVisible ? "on" : ""}`}
                onClick={() => onUiChange({ symbolGridVisible: !gridVisible })}
                title={gridVisible ? "隐藏背景网格" : "显示背景网格"}
                aria-pressed={gridVisible}
                data-testid="grid-toggle"
              >
                <Grid3x3 size={15} />
              </button>
              <button
                type="button"
                className="symbol-tool"
                onClick={addDeviceText}
                title="添加文本（放在本体中心，可拖动、双击改字）"
                aria-label="添加文本"
                data-testid="add-text"
              >
                <Type size={15} />
              </button>
              <select
                className="symbol-tool-select"
                value=""
                onChange={(event) => applyLayoutAction(event.target.value)}
                disabled={selectedKeys.length < 2}
                title={
                  selectedKeys.length < 2
                    ? "选中 2 个以上元素后可对齐（3 个以上可等距分布）"
                    : "对齐 / 等距分布"
                }
                aria-label="对齐与分布"
                data-testid="align-select"
              >
                <option value="" disabled>
                  对齐
                </option>
                <optgroup label="对齐">
                  <option value="align:left">左对齐</option>
                  <option value="align:right">右对齐</option>
                  <option value="align:top">顶对齐</option>
                  <option value="align:bottom">底对齐</option>
                  <option value="align:centerX">水平居中</option>
                  <option value="align:centerY">垂直居中</option>
                </optgroup>
                <optgroup label="等距分布">
                  <option value="distribute:horizontal" disabled={selectedKeys.length < 3}>
                    水平等距
                  </option>
                  <option value="distribute:vertical" disabled={selectedKeys.length < 3}>
                    垂直等距
                  </option>
                </optgroup>
              </select>
              <button
                type="button"
                className="symbol-tool"
                onClick={focusSelection}
                title={selectedKeys.length > 0 ? "缩放到选中（Focus）" : "缩放到整个符号"}
                aria-label="缩放到选中"
                data-testid="focus-selection"
              >
                <Focus size={15} />
              </button>
            </div>
          ) : null}
          {previewTab === "sch" && editMode && elementProps !== null ? (
            <SymbolProperties element={elementProps} snap={snapState} onField={commitElementField} />
          ) : null}
          {previewTab === "sch" && editedSymbol !== null && previewSection !== null ? (
            <PanZoom
              ref={symbolPanRef}
              bounds={previewBounds!}
              resetKey={`sch:${selected?.id ?? ""}:${sectionIndex}:${editedSymbol.sections.length}`}
              ariaLabel="原理图元件预览"
              onBackgroundClick={editMode ? clearSymbolSelection : undefined}
              onMarquee={
                editMode
                  ? (box, done) => {
                      if (box === null) {
                        setMarqueeKeys(null);
                        return;
                      }
                      const keys =
                        previewSection === null ? [] : symbolKeysInBox(previewSection, sectionIndex, box);
                      setMarqueeKeys(keys);
                      if (done) {
                        setSelectedKeys(keys);
                        setMarqueeKeys(null);
                      }
                    }
                  : undefined
              }
            >
              {({ scale, tx, ty, width, height }) => (
                <>
                  <SymbolGrid
                    view={{ tx, ty, width, height, scale }}
                    grid={snapGrid}
                    visible={gridVisible}
                  />
                  <SymbolPreview
                    symbol={editedSymbol}
                    sectionIndex={Math.min(sectionIndex, editedSymbol.sections.length - 1)}
                    scale={scale}
                    edits={selectedEdit.symbolEdits}
                    editing={editMode}
                    selectedKeys={effectiveSelectedKeys}
                    onSelectKeys={(keys, mode) =>
                      setSelectedKeys((current) => applySelection(current, keys, mode ?? "replace"))
                    }
                    onMoveElements={moveSelectedElements}
                    onResizeRect={resizeSelectedRect}
                    onReorientPins={reorientPins}
                    onTextEdit={editTextContent}
                    onPinTextEdit={editPinText}
                    textEditRequest={textEditRequest}
                    snap={snapState}
                  />
                </>
              )}
            </PanZoom>
          ) : selected?.footprint !== null && selected?.footprint !== undefined ? (
            <PanZoom
              bounds={selected.footprint.bounds}
              resetKey={`pcb:${selected.id}`}
              ariaLabel="PCB 封装预览"
            >
              {() => (
                <FootprintPreview
                  footprint={selected.footprint!}
                  visible={visibleLayers}
                  maskExpansionMm={selectedPlan?.solderMaskExpansionMm ?? 0.05}
                  layerColors={settings.ui.layerColors}
                />
              )}
            </PanZoom>
          ) : (
            <div className="empty-state large"><Box size={36} /><strong>这里会显示封装俯视图</strong><span>焊盘、丝印和外形可以在生成前确认</span></div>
          )}
          {previewTab === "pcb" && selected?.footprint !== null && selected?.footprint !== undefined ? (
            <div className="canvas-legend">
              {layers
                .filter((layer) => visibleLayers.has(layer.id))
                .map((layer) => (
                  <span key={layer.id}>
                    <i style={{ background: layerColors[layer.id] ?? layer.color }} />
                    {layer.label}
                  </span>
                ))}
            </div>
          ) : null}
          {previewTab === "sch" && editedSymbol !== null ? (
            <div className="canvas-legend symbol-legend">
              <span><i className="legend-silk" />本体 / 图形</span>
              <span><i className="legend-pad" />引脚</span>
              <span>
                {editMode
                  ? `编辑中：拖元素移动 · 双击文本/引脚标签改字 · T 加文本 · 框选/Shift 追加/Ctrl 切换 · Ctrl+A 全选 · 拖框线改大小 · ←↑→↓ 一格（Shift 精调/Alt 粗调） · 空格 旋转文本 · [ ] 字号 · Ctrl+Z 退回 · Esc 取消 · 网格 ${gridMil(snapGrid)} mil${snapEnabled ? " 吸附开" : " 吸附关（写库按实际坐标）"}`
                  : "点「编辑」后按住鼠标左键拖动文字、图形与引脚（滚轮缩放照常可用）"}
                {hasSymbolEdits(selectedEdit.symbolEdits) ? (
                  <button
                    type="button"
                    className="legend-reset"
                    onClick={() => {
                      if (selected !== null) {
                        // 走统一入口：重置也是一步，可以 Ctrl+Z 退回来
                        mutateSymbolEdits(selected.id, () => EMPTY_SYMBOL_EDITS, false);
                        setSelectedKeys([]);
                        setTextEditRequest(null);
                        // 追加的文本没有对应的 SymbolEdit，重置时一并移除
                        setDeviceEdits((current) => ({
                          ...current,
                          [selected.id]: {
                            ...(current[selected.id] ?? EMPTY_DEVICE_EDIT),
                            addedTexts: undefined,
                          },
                        }));
                      }
                    }}
                  >
                    重置调整
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
        <footer className="stage-footer">
          <div><span>ALLEGRO 库目录</span><strong><Folder size={14} />{settings.libraryDirectory}</strong></div>
          <div className="generation-side">
            <div className="target-toggles">
              <label title="生成 Allegro 封装：.dra / .psm / .pad">
                <input
                  type="checkbox"
                  checked={targets.pcb}
                  onChange={(event) => setTargets((current) => ({ ...current, pcb: event.target.checked }))}
                  data-testid="target-pcb"
                />
                PCB 封装
              </label>
              <label title="生成 OrCAD Capture 原理图元件并写入 .olb（仅本地库器件有符号数据）">
                <input
                  type="checkbox"
                  checked={targets.symbol}
                  onChange={(event) => setTargets((current) => ({ ...current, symbol: event.target.checked }))}
                  data-testid="target-symbol"
                />
                原理图元件
              </label>
            </div>
            <button
              className="primary-button generate-main"
              type="button"
              disabled={generateDisabled}
              onClick={() => void generateSelected()}
              data-testid="generate-button"
              title={generateTitle}
            >
              {running ? <LoaderCircle className="spin" size={17} /> : <Play size={17} fill="currentColor" />}
              {generateLabel}
            </button>
          </div>
        </footer>
      </section>

      <aside className="right-rail">
        <div className="inspector-header"><h2>检查结果</h2><span>{selectedPlan === null ? "等待数据" : `${selectedPlan.checks.filter((item) => item.severity === "pass").length} 通过`}</span></div>
        {selectedPlan === null || selected?.footprint === null ? (
          <div className="empty-state detail-empty"><Sparkles size={28} /><strong>等待器件数据</strong><span>读取完成后会列出检查结果</span></div>
        ) : (
          <div className="inspector-scroll">
            <InspectorSection id="facts" title="器件信息" collapsed={collapsedSections.includes("facts")} onToggle={toggleSection}>
              <dl className="facts">
                <div><dt>立创编号</dt><dd>{selected.footprint.info.lcscId}</dd></div>
                <div><dt>制造商型号</dt><dd>{selected.footprint.info.manufacturerPartNumber || selected.footprint.info.name}</dd></div>
                <div><dt>原始封装</dt><dd>{selected.footprint.info.sourcePackageName}</dd></div>
                <div><dt>目标名称</dt><dd>{selectedEdit.pcbName === null ? selected.footprint.info.targetPackageName : (sanitizeLibraryName(selectedEdit.pcbName) || selected.footprint.info.targetPackageName)}</dd></div>
              </dl>
            </InspectorSection>
            <InspectorSection id="naming" title="输出命名" collapsed={collapsedSections.includes("naming")} onToggle={toggleSection}>
              <div className="name-fields">
                <label>
                  <span>PCB 封装名 <em>.dra / .psm / .pad</em></span>
                  <input
                    value={selectedEdit.pcbName ?? selected.footprint.info.targetPackageName}
                    onChange={(event) => updateDeviceEdit(selected.id, { pcbName: event.target.value })}
                    spellCheck={false}
                    data-testid="pcb-name"
                  />
                </label>
                {selectedSymbolEntry === undefined ? null : (
                  <label>
                    <span>原理图元件名 <em>.olb 内的器件名</em></span>
                    <input
                      value={selectedEdit.symbolName ?? selectedSymbolEntry.symbol.name}
                      onChange={(event) => updateDeviceEdit(selected.id, { symbolName: event.target.value })}
                      spellCheck={false}
                      data-testid="symbol-name"
                    />
                  </label>
                )}
                <p className="name-hint">
                  仅允许 A-Z 0-9 _ -，超长会被截断；留空则用自动推导的名字。
                </p>
              </div>
            </InspectorSection>
            <InspectorSection id="checks" title="自动检查" collapsed={collapsedSections.includes("checks")} onToggle={toggleSection}>
              <div className="check-list">
                {selectedPlan.checks.map((item) => (
                  <div className="check-item" key={item.id}>
                    {item.severity === "warning" ? <TriangleAlert size={16} className="warning-icon" /> : <Check size={16} className="green-icon" />}
                    <div><strong>{item.label}</strong><span>{item.detail}</span></div>
                  </div>
                ))}
              </div>
            </InspectorSection>
            <InspectorSection id="layers" title="图层显示" collapsed={collapsedSections.includes("layers")} onToggle={toggleSection}>
              {layers.length === 0 ? (
                <div className="layer-empty">读取器件后这里会列出实际存在的图层</div>
              ) : (
                <div className="layer-list">
                  {layers.map((layer) => (
                    <div className="layer-row" key={layer.id}>
                      <input
                        type="checkbox"
                        checked={visibleLayers.has(layer.id)}
                        onChange={(event) => {
                          setVisibleLayers((current) => {
                            const next = new Set(current);
                            if (event.target.checked) {
                              next.add(layer.id);
                            } else {
                              next.delete(layer.id);
                            }
                            return next;
                          });
                        }}
                        aria-label={`显示 ${layer.label}`}
                        data-testid={`layer-${layer.id}`}
                      />
                      {/* 图层颜色可改（点色块）—— 画布与图例跟随，颜色写进设置持久化 */}
                      <input
                        type="color"
                        className="layer-swatch"
                        value={layerColors[layer.id] ?? layer.color}
                        title={`${layer.label} · ${layer.allegro}：点击更改颜色`}
                        onChange={(event) =>
                          onUiChange({ layerColors: { ...layerColors, [layer.id]: event.target.value } })
                        }
                        data-testid={`layer-color-${layer.id}`}
                      />
                      <span className="layer-name" title={`${layer.label} · ${layer.allegro}`}>
                        {layer.label}
                        <em>{layer.allegro}</em>
                      </span>
                      <span className="layer-count">{layer.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </InspectorSection>
            <InspectorSection id="model" title="三维模型" collapsed={collapsedSections.includes("model")} onToggle={toggleSection}>
              <div className="model-row"><Check size={15} />{selected.footprint.model3d?.name ?? "源数据未提供模型"}</div>
            </InspectorSection>
            <InspectorSection id="olb" title="原理图元件库" collapsed={collapsedSections.includes("olb")} onToggle={toggleSection}>
              {selectedOlb === null ? (
                <div className="model-row">
                  <span className="muted">
                    {symbols[selected.id] === undefined
                      ? "源数据不含原理图元件"
                      : "生成封装时会一并写入 .olb"}
                  </span>
                </div>
              ) : selectedOlb.status === "ok" ? (
                <>
                  <div className="model-row"><Check size={15} className="green-icon" />{selectedOlb.result.message}</div>
                  <div className="model-row"><span className="muted">{selectedOlb.result.libraryPath}</span></div>
                </>
              ) : (
                <div className="model-row"><TriangleAlert size={15} className="warning-icon" />{selectedOlb.message}</div>
              )}
            </InspectorSection>
          </div>
        )}
        <div
          className="rail-resizer rail-resizer-right"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整右侧栏宽度"
          title="拖动调整宽度"
          onPointerDown={startRailDrag("right")}
          onDoubleClick={() => onUiChange({ rightRailWidth: RIGHT_RAIL_RANGE.min + 62 })}
          data-testid="rail-resizer-right"
        />
      </aside>
    </main>
    {progress !== null ? (
      <GenerationProgressDialog
        progress={progress}
        onClose={() => setProgress(null)}
        onOpenDirectory={api.openPath}
      />
    ) : null}
    {overwriteAsk === null ? null : (
      <OverwriteConfirmDialog
        request={overwriteAsk.request}
        onCancel={() => {
          overwriteAsk.resolve(false);
          setOverwriteAsk(null);
        }}
        onConfirm={() => {
          overwriteAsk.resolve(true);
          setOverwriteAsk(null);
        }}
      />
    )}
    </>
  );
};

const HistoryPage = ({
  history,
  settings,
}: {
  readonly history: readonly HistoryEntry[];
  readonly settings: AppSettings;
}): ReactElement => (
  <main className="page">
    <header className="page-heading">
      <div>
        <p className="eyebrow">转换记录</p>
        <h1>最近生成的封装</h1>
        <p>查看结果，也可以直接打开封装库目录。</p>
      </div>
      <button className="secondary-button" type="button" onClick={() => void api.openPath(settings.libraryDirectory)}>
        <FolderOpen size={17} />打开库目录
      </button>
    </header>
    <section className="history-card panel">
      {history.length === 0 ? (
        <div className="empty-state history-empty">
          <History size={34} />
          <strong>还没有转换记录</strong>
          <span>生成成功后会自动保存在这里</span>
        </div>
      ) : (
        history.map((entry) => (
          <div className="history-row" key={entry.id}>
            <div className="history-status"><Check size={18} /></div>
            <div className="history-main">
              <strong>{entry.lcscId}</strong>
              <span>{entry.targetPackageName}</span>
            </div>
            <span className="file-count">{entry.files.length} 个文件</span>
            <span className="history-time"><Clock3 size={14} />{formatDate(entry.completedAt)}</span>
            <button type="button" className="quiet-button" aria-label={`查看 ${entry.lcscId}`}>
              <ChevronRight size={18} />
            </button>
          </div>
        ))
      )}
    </section>
  </main>
);

const SettingsPage = ({
  settings,
  installs,
  onInstallDetected,
  onSave,
}: {
  readonly settings: AppSettings;
  readonly installs: readonly AllegroInstall[];
  readonly onInstallDetected: (install: AllegroInstall) => void;
  readonly onSave: (settings: AppSettings) => Promise<void>;
}): ReactElement => {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedInstall =
    (draft.allegroExecutablePath === null
      ? installs.find((install) => install.version === draft.allegroVersion)
      : installs.find(
          (install) =>
            install.version === draft.allegroVersion &&
            install.executablePath.toLowerCase() ===
              draft.allegroExecutablePath?.toLowerCase(),
        )) ?? null;
  const choose = async (): Promise<void> => {
    const selected = await api.chooseLibraryDirectory();
    if (selected !== null) {
      setDraft({ ...draft, libraryDirectory: selected });
    }
  };
  const chooseExecutable = async (): Promise<void> => {
    setError(null);
    try {
      const install = await api.chooseAllegroExecutable();
      if (install !== null) {
        onInstallDetected(install);
        setDraft({
          ...draft,
          allegroVersion: install.version,
          allegroExecutablePath: install.executablePath,
        });
      }
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    }
  };
  // OLB 目标：既能挑已有库（追加），也能新建（不存在时按该路径创建）。
  const chooseOlb = async (): Promise<void> => {
    setError(null);
    try {
      const selected = await api.chooseOlbLibrary();
      if (selected !== null) {
        setDraft({ ...draft, olbLibraryPath: selected });
      }
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    }
  };
  const createOlb = async (): Promise<void> => {
    setError(null);
    try {
      const created = await api.createOlbLibrary("easy2alg");
      if (created !== null) {
        setDraft({ ...draft, olbLibraryPath: created });
      }
    } catch (createError) {
      setError(errorMessage(createError));
    }
  };
  const save = async (): Promise<void> => {
    setError(null);
    try {
      await onSave({ ...draft, setupCompleted: true });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  };
  return (
    <main className="page narrow-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">设置</p>
          <h1>Allegro 与库目录</h1>
          <p>通常只需在第一次使用时确认。</p>
        </div>
      </header>
      <section className="settings-card panel">
        <div className="setting-section">
          <div className="setting-icon"><Zap size={21} /></div>
          <div className="setting-content">
            <label htmlFor="allegro-version">Allegro 版本</label>
            <p>选择电脑上已经安装的版本。</p>
            <select
              id="allegro-version"
              value={draft.allegroVersion}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  allegroVersion: event.target.value as AllegroVersion,
                  allegroExecutablePath: null,
                });
                setSaved(false);
              }}
            >
              {AllegroVersionOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                  {installs.some((install) => install.version === option.value)
                    ? "（已检测）"
                    : ""}
                </option>
              ))}
            </select>
            <div className={`detection-card ${selectedInstall === null ? "missing" : ""}`}>
              {selectedInstall === null ? (
                <>
                  <TriangleAlert size={18} />
                  <div>
                    <strong>未检测到 Allegro {draft.allegroVersion}</strong>
                    <span>请确认版本，或选择实际的 allegro.exe</span>
                  </div>
                </>
              ) : (
                <>
                  <Check size={18} />
                  <div>
                    <strong>已检测 Allegro {selectedInstall.version}</strong>
                    <span>{selectedInstall.executablePath}</span>
                  </div>
                </>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => void chooseExecutable()}
                data-testid="choose-allegro-executable"
              >
                手动选择
              </button>
            </div>
          </div>
        </div>
        <div className="setting-section">
          <div className="setting-icon"><LibraryBig size={21} /></div>
          <div className="setting-content">
            <label htmlFor="library-directory">封装库目录</label>
            <p>生成的封装、焊盘和转换记录会分类保存在此目录。</p>
            <div className="directory-row">
              <input
                id="library-directory"
                value={draft.libraryDirectory}
                onChange={(event) => setDraft({ ...draft, libraryDirectory: event.target.value })}
              />
              <button type="button" className="icon-button" onClick={() => void choose()} aria-label="选择库目录">
                <FolderOpen size={18} />
              </button>
            </div>
          </div>
        </div>
        <div className="setting-section">
          <div className="setting-icon"><FileCode2 size={21} /></div>
          <div className="setting-content">
            <label htmlFor="olb-library">原理图元件库（.olb）</label>
            <p>填写本地库时生成的 OrCAD Capture 符号会写入此文件；留空则自动新建。</p>
            <div className="directory-row">
              <input
                id="olb-library"
                value={draft.olbLibraryPath ?? ""}
                placeholder="未指定 · 转换时自动新建"
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    olbLibraryPath:
                      event.target.value.trim().length === 0 ? null : event.target.value,
                  })
                }
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => void chooseOlb()}
                data-testid="choose-olb-library"
              >
                选择已有
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void createOlb()}
                data-testid="create-olb-library"
              >
                新建
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => setDraft({ ...draft, olbLibraryPath: null })}
                aria-label="清除 OLB 路径"
                title="清除后将在库目录的 schlib 下自动新建"
              >
                <X size={18} />
              </button>
            </div>
          </div>
        </div>
        <div className="setting-section">
          <div className="setting-icon"><Layers3 size={21} /></div>
          <div className="setting-content">
            <label>输出结构与器件字段</label>
            <p>默认把焊盘放进 padstacks、封装放进 symbols；勾选后全部放在库目录下。</p>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={draft.unifiedLibraryFolder}
                onChange={(event) =>
                  setDraft({ ...draft, unifiedLibraryFolder: event.target.checked })
                }
                data-testid="setting-unified-folder"
              />
              <span>焊盘、封装、符号库都用同一个文件夹</span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={draft.fillPcbFootprint}
                onChange={(event) => setDraft({ ...draft, fillPcbFootprint: event.target.checked })}
                data-testid="setting-fill-footprint"
              />
              <span>在 .olb 的器件里填入 PCB Footprint 字段</span>
            </label>
          </div>
        </div>
        <div className="settings-actions">
          <span className={error === null ? "" : "settings-error"}>
            {error ?? (saved ? "已保存" : "")}
          </span>
          <button
            className="primary-button"
            type="button"
            onClick={() => void save()}
            disabled={
              selectedInstall === null || draft.libraryDirectory.trim().length === 0
            }
            data-testid="save-settings"
          >
            <Check size={17} />保存设置
          </button>
        </div>
      </section>
    </main>
  );
};

export const App = (): ReactElement => {
  const [page, setPage] = useState<Page>("convert");
  const [settings, setSettings] = useState<AppSettings>(emptySettings);
  const [queue, setQueue] = useState<readonly QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);
  const [installs, setInstalls] = useState<readonly AllegroInstall[]>([]);
  const [ready, setReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getSettings(), api.getHistory(), api.detectAllegro()])
      .then(([loadedSettings, loadedHistory, detectedInstalls]) => {
        setSettings(loadedSettings);
        setHistory(loadedHistory);
        setInstalls(detectedInstalls);
        setReady(true);
      })
      .catch((error: unknown) => {
        setFatalError(errorMessage(error));
        setReady(true);
      });
  }, []);

  const selectedReady = useMemo(
    () => queue.filter((item) => item.selected && item.state !== "error").length,
    [queue],
  );
  const activeInstall = useMemo(
    () =>
      (settings.allegroExecutablePath === null
        ? installs.find((install) => install.version === settings.allegroVersion)
        : installs.find(
            (install) =>
              install.version === settings.allegroVersion &&
              install.executablePath.toLowerCase() ===
                settings.allegroExecutablePath?.toLowerCase(),
          )) ?? null,
    [installs, settings.allegroExecutablePath, settings.allegroVersion],
  );
  const addInstall = (install: AllegroInstall): void => {
    setInstalls((current) => [
      install,
      ...current.filter(
        (candidate) =>
          candidate.executablePath.toLowerCase() !== install.executablePath.toLowerCase(),
      ),
    ]);
  };
  const saveSettings = async (nextSettings: AppSettings): Promise<void> => {
    const saved = await api.saveSettings(nextSettings);
    setSettings(saved);
    setInstalls(await api.detectAllegro());
  };
  /**
   * 界面偏好：先本地生效（拖动/点击要跟手），再落盘。
   * 走的是独立通道，不会顺带重跑 Allegro 探测（那个要扫注册表，很慢）。
   */
  const patchUiSettings = (patch: UiSettingsPatch): void => {
    setSettings((current) => ({ ...current, ui: { ...current.ui, ...patch } }));
    void api.saveUiSettings(patch).catch(async () => {
      setSettings(await api.getSettings());
    });
  };
  if (!ready) {
    return (
      <div className="app-loading">
        <div className="brand-mark small"><Zap size={21} /></div>
        <LoaderCircle className="spin" size={24} />
      </div>
    );
  }
  if (fatalError !== null) {
    return (
      <div className="fatal-card">
        <TriangleAlert size={28} />
        <h1>软件启动失败</h1>
        <p>{fatalError}</p>
        <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
          <RotateCcw size={17} />重新载入
        </button>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span className="brand-trace" /></div>
          <div className="brand-copy"><strong>Easy2ALG</strong><span>封装转换与检查</span></div>
        </div>
        <div className="top-actions">
          <button className="top-action" type="button" onClick={() => setPage("history")} data-testid="nav-history">
            <History size={17} />转换记录
          </button>
          <button className="top-action" type="button" onClick={() => setPage("settings")} data-testid="nav-settings">
            <Settings size={17} />设置
          </button>
          <button className="top-action" type="button">
            <CircleHelp size={17} />帮助
          </button>
          {page !== "convert" ? (
            <button className="top-action back-action" type="button" onClick={() => setPage("convert")} data-testid="nav-convert">
              <ChevronRight className="back-icon" size={17} />返回转换
            </button>
          ) : null}
        </div>
      </header>
      {page === "convert" ? (
        <ConverterPage
          settings={settings}
          allegroInstall={activeInstall}
          queue={queue}
          setQueue={setQueue}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          onGenerated={(entry) => setHistory((current) => [entry, ...current])}
          onUiChange={patchUiSettings}
        />
      ) : page === "history" ? (
        <HistoryPage history={history} settings={settings} />
      ) : (
        <SettingsPage
          settings={settings}
          installs={installs}
          onInstallDetected={addInstall}
          onSave={saveSettings}
        />
      )}
      <footer className="statusbar">
        <span title={activeInstall?.executablePath}>
          Allegro {activeInstall?.version ?? settings.allegroVersion}
        </span>
        <i className={activeInstall === null ? "missing" : ""} />
        <span>{activeInstall === null ? "未检测到" : "已检测"}</span>
        <span>规则库 1.0</span>
        <span className="status-spacer" />
        <span>{selectedReady} 个器件已选择</span>
        <span>UTF-8</span>
      </footer>
      {!settings.setupCompleted || activeInstall === null ? (
        <SetupDialog
          initial={settings}
          installs={installs}
          onInstallDetected={addInstall}
          onSave={saveSettings}
        />
      ) : null}
    </div>
  );
};
