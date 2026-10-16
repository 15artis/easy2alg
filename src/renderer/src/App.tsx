import {
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileCode2,
  Folder,
  FolderOpen,
  FolderSearch,
  History,
  Layers3,
  LibraryBig,
  LoaderCircle,
  PackageCheck,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import {
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
  OlbWriteResult,
  QueueItem,
} from "../../shared/schemas";
import { createMockApi } from "./mock-api";
import { PanZoom } from "./PanZoom";
import { SymbolPreview } from "./SymbolPreview";
import { selectRunnableItems, shouldOfferRegeneration } from "./selection";
import {
  applySymbolEdits,
  EMPTY_SYMBOL_EDITS,
  hasSymbolEdits,
  type SymbolEdits,
} from "../../shared/symbol-edit";
import { sanitizeLibraryName } from "../../shared/naming";
import {
  defaultVisibleLayers,
  footprintLayers,
  normalizeVisibleLayers,
  type FootprintLayerId,
} from "../../shared/preview-layers";
import {
  defaultUiSettings,
  LEFT_RAIL_RANGE,
  RIGHT_RAIL_RANGE,
  type UiSettingsPatch,
} from "../../shared/schemas";
import { sectionPreviewBounds } from "../../shared/symbol-labels";

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

/** 单个器件上用户做过的调整：输出改名 + 原理图符号元素位移。 */
type DeviceEdit = {
  readonly pcbName: string | null;
  readonly symbolName: string | null;
  readonly symbolEdits: SymbolEdits;
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
  return applySymbolEdits(named, edit.symbolEdits);
};

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
  // 本地库导入时从同一份 .elibz2 里顺带取出的原理图符号（C 编号链路没有符号）。
  const [symbols, setSymbols] = useState<Readonly<Record<string, SymbolEntry>>>({});
  const [olbOutcomes, setOlbOutcomes] = useState<Readonly<Record<string, OlbOutcome>>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 生成哪些产物：PCB 封装（.dra/.psm/.pad）与原理图符号（.olb）各自独立开关。
  const [targets, setTargets] = useState<{ pcb: boolean; symbol: boolean }>({
    pcb: true,
    symbol: true,
  });
  const [previewTab, setPreviewTab] = useState<"pcb" | "sch">("pcb");
  const [sectionIndex, setSectionIndex] = useState(0);
  const [selectedShapeKey, setSelectedShapeKey] = useState<string | null>(null);
  // PCB 预览的图层开关（右侧「图层显示」面板直接驱动画布）
  const [visibleLayers, setVisibleLayers] = useState<ReadonlySet<FootprintLayerId>>(
    () => defaultVisibleLayers([]),
  );
  // 每个器件的手工调整（符号元素位移）与输出改名。
  const [deviceEdits, setDeviceEdits] = useState<Readonly<Record<string, DeviceEdit>>>({});
  // 拖动侧栏时的实时宽度（松手才落盘，避免拖拽过程刷 IPC）
  const [liveRail, setLiveRail] = useState<{ readonly side: "left" | "right"; readonly width: number } | null>(null);
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

  // 勾选目标后仍要保证"有东西可生成"：只要 PCB 就要求有封装，只勾符号就要求该器件有符号。
  const generatableItems = useMemo(
    () =>
      targets.pcb || targets.symbol
        ? runnableItems.filter((item) => targets.pcb || symbols[item.id] !== undefined)
        : [],
    [runnableItems, symbols, targets.pcb, targets.symbol],
  );

  // 切到没有符号的器件时把分页退回 PCB，避免"分页停在符号、画布却是封装"的错位。
  const hasSymbol = editedSymbol !== null;
  useEffect(() => {
    if (!hasSymbol) {
      setPreviewTab("pcb");
    }
  }, [hasSymbol]);
  const selectedKeyId = selected?.id ?? null;
  useEffect(() => {
    setSectionIndex(0);
    setSelectedShapeKey(null);
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

  const updateDeviceEdit = (id: string, patch: Partial<DeviceEdit>): void => {
    setDeviceEdits((current) => ({
      ...current,
      [id]: { ...EMPTY_DEVICE_EDIT, ...current[id], ...patch },
    }));
  };

  const moveShape = (id: string, key: string, dx: number, dy: number): void => {
    setDeviceEdits((current) => {
      const base = current[id] ?? EMPTY_DEVICE_EDIT;
      const previous = base.symbolEdits[key] ?? { dx: 0, dy: 0 };
      return {
        ...current,
        [id]: {
          ...base,
          symbolEdits: {
            ...base.symbolEdits,
            [key]: { dx: previous.dx + dx, dy: previous.dy + dy },
          },
        },
      };
    });
  };

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

  const importIds = async (): Promise<void> => {
    const ids = splitIds(input);
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
            // 原理图符号就在同一次接口响应里（主进程缓存了原始响应，不额外发请求）；
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

  /** forcePick=true 时强制弹选择框（"重新选择库文件"按钮）。 */
  const importLocalLibrary = async (forcePick = false): Promise<void> => {
    setLocalError(null);
    setLocalLoading(true);
    try {
      // 记住上次选的库文件：再次点击直接读它，不用重新选（用户 2026-10-16 要求持久化）。
      const remembered = forcePick ? null : settings.ui.localLibraryPath;
      const filePath = remembered ?? (await api.chooseLocalLibraryFile());
      if (filePath === null) {
        return;
      }
      if (filePath !== settings.ui.localLibraryPath) {
        onUiChange({ localLibraryPath: filePath });
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
      });
      // 合并规则：同 id 已存在且是 error 项 → 替换重读；其它状态 → 跳过。
      const nextQueue = [...queue];
      const targets: LocalLibraryDeviceSummary[] = [];
      for (const device of devices) {
        const index = nextQueue.findIndex((item) => item.id === device.lcscId);
        if (index >= 0) {
          if (nextQueue[index].state === "error") {
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
      return;
    }
    const wantPcb = targets.pcb;
    const wantSymbol = targets.symbol;
    setRunning(true);
    for (const item of items) {
      const plan = planFor(item.id);
      const symbol = wantSymbol ? symbolFor(item.id) : null;
      const entry = symbols[item.id];
      const notes: string[] = [];
      let pcbFailure: string | null = null;
      let pcbResult: ConversionResult | null = null;

      updateItem(item.id, {
        state: "loading",
        message: wantPcb ? "Allegro 正在生成并检查…" : "正在写入原理图符号库（.olb）…",
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

      // ② 原理图符号（.olb）—— 与封装相互独立：封装失败也不该拦着符号落库。
      if (wantSymbol && symbol !== null && entry !== undefined) {
        updateItem(item.id, { state: "loading", message: "正在写入原理图符号库（.olb）…" });
        try {
          const olb = await api.writeOlb({
            symbol,
            libraryPath: settings.olbLibraryPath,
            libraryName: entry.libraryName,
          });
          setOlbOutcomes((current) => ({ ...current, [item.id]: { status: "ok", result: olb } }));
          notes.push(olb.message);
        } catch (error) {
          const message = errorMessage(error);
          setOlbOutcomes((current) => ({
            ...current,
            [item.id]: { status: "failed", message },
          }));
          notes.push(`原理图符号库未写入：${message}`);
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
    setRunning(false);
  };

  // ---------- 侧栏宽度（可拖动，宽度持久化在 settings.ui 里）----------
  const leftWidth = liveRail?.side === "left" ? liveRail.width : settings.ui.leftRailWidth;
  const rightWidth = liveRail?.side === "right" ? liveRail.width : settings.ui.rightRailWidth;
  const collapsedSections = settings.ui.collapsedSections;
  const layerColors = settings.ui.layerColors;

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
  const generateDisabled = readyCount === 0 || running || wantsNothing || pcbBlocked;
  const generateTitle = running
    ? "正在生成…"
    : wantsNothing
      ? "至少勾选一种生成内容"
      : readyCount === 0
        ? runnableItems.length > 0
          ? "勾选的器件没有原理图符号数据（立创编号链路只有封装）"
          : "先在左侧勾选至少一个已读取的器件"
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
                : "写入原理图符号"
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
            placeholder="输入或粘贴立创编号，如 C2040"
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
                settings.ui.localLibraryPath === null
                  ? "导入立创EDA专业版导出的 .elibz2 库文件，无需立创编号"
                  : `再次读取：${settings.ui.localLibraryPath}`
              }
            >
              <FolderOpen size={16} />{localLoading ? "解析中…" : "导入本地库"}
            </button>
            {/* 默认复用上次记住的库文件；这个按钮强制重新挑一个 */}
            <button
              className="secondary-button icon-action"
              type="button"
              onClick={() => void importLocalLibrary(true)}
              disabled={localLoading}
              data-testid="import-local-pick"
              title="重新选择 .elibz2 库文件"
              aria-label="重新选择库文件"
            >
              <FolderSearch size={16} />
            </button>
          </div>
          {settings.ui.localLibraryPath === null ? null : (
            <p className="local-library-hint" title={settings.ui.localLibraryPath}>
              记住的本地库：{settings.ui.localLibraryPath.split(/[\\/]/).pop()}
            </p>
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
            <button
              type="button"
              key={item.id}
              className={`rail-item ${selected?.id === item.id ? "selected" : ""}`}
              onClick={() => setSelectedId(item.id)}
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
                <em>{item.footprint?.info.sourcePackageName ?? item.message}</em>
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
          ))}
        </div>
        {queue.length > 0 ? (
          <button className="clear-list" type="button" onClick={() => { setQueue([]); setSelectedId(null); }}>
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
              title={editedSymbol === null ? "该器件的源数据里没有原理图符号" : undefined}
              data-testid="tab-sch"
            >
              原理图符号
            </button>
          </div>
          {previewTab === "sch" && editedSymbol !== null && editedSymbol.sections.length > 1 ? (
            <div className="stage-sections" aria-label="符号分段">
              {editedSymbol.sections.map((section, index) => (
                <button
                  key={section.name}
                  type="button"
                  className={index === sectionIndex ? "active" : ""}
                  onClick={() => {
                    setSectionIndex(index);
                    setSelectedShapeKey(null);
                  }}
                  title={section.name}
                >
                  {String.fromCharCode(65 + (index % 26))}
                </button>
              ))}
            </div>
          ) : null}
        </header>
        <div className="engineering-canvas">
          {previewTab === "sch" && editedSymbol !== null && previewSection !== null ? (
            <PanZoom
              bounds={previewBounds!}
              resetKey={`sch:${selected?.id ?? ""}:${sectionIndex}:${editedSymbol.sections.length}`}
              ariaLabel="原理图符号预览"
            >
              {({ scale }) => (
                <SymbolPreview
                  symbol={editedSymbol}
                  sectionIndex={Math.min(sectionIndex, editedSymbol.sections.length - 1)}
                  scale={scale}
                  edits={selectedEdit.symbolEdits}
                  selectedKey={selectedShapeKey}
                  onSelect={setSelectedShapeKey}
                  onMoveShape={(key, dx, dy) => {
                    if (selected !== null) {
                      moveShape(selected.id, key, dx, dy);
                    }
                  }}
                />
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
            <div className="canvas-legend">
              <span><i className="legend-silk" />本体 / 图形</span>
              <span><i className="legend-pad" />引脚</span>
              <span>
                拖动文字或图形可手工调整
                {hasSymbolEdits(selectedEdit.symbolEdits) ? (
                  <button
                    type="button"
                    className="legend-reset"
                    onClick={() => {
                      if (selected !== null) {
                        setDeviceEdits((current) => ({
                          ...current,
                          [selected.id]: { ...selectedEdit, symbolEdits: EMPTY_SYMBOL_EDITS },
                        }));
                        setSelectedShapeKey(null);
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
              <label title="生成 OrCAD Capture 原理图符号并写入 .olb（仅本地库器件有符号数据）">
                <input
                  type="checkbox"
                  checked={targets.symbol}
                  onChange={(event) => setTargets((current) => ({ ...current, symbol: event.target.checked }))}
                  data-testid="target-symbol"
                />
                原理图符号
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
                    <span>原理图符号名 <em>.olb 内的器件名</em></span>
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
            <InspectorSection id="olb" title="原理图符号库" collapsed={collapsedSections.includes("olb")} onToggle={toggleSection}>
              {selectedOlb === null ? (
                <div className="model-row">
                  <span className="muted">
                    {symbols[selected.id] === undefined
                      ? "源数据不含原理图符号"
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
            <label htmlFor="olb-library">原理图符号库（.olb）</label>
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
