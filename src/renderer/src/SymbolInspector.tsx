import { useEffect, useState, type ReactElement } from "react";
import type { NormalizedSymbolSection, SymbolPinType } from "../../shared/schemas";
import type { SymbolEdits } from "../../shared/symbol-edit";
import {
  readElementProps,
  type ElementField,
  type ElementProps,
  type PinSide,
} from "../../shared/symbol-property";
import { snapValue, type SnapState } from "../../shared/symbol-snap";

/**
 * 右侧「属性编辑」tab（用户 2026-11-11）。
 *
 * 取代画布上那块浮动面板：编辑符号时属性固定在右栏，不挡画布、也不跟着缩放跑。
 * 读写换算全部在 `shared/symbol-property.ts`（纯函数、可单测），这里只负责
 * **按选中类型显示哪组字段** + 提交时机。
 *
 * 能改的字段都是**真的会写进 .olb** 的：
 *  - 位置/尺寸 → 坐标（1 单位 = 10 mil）；
 *  - 线宽/线型 → Capture 的 Line Width / Line Style 枚举；
 *  - 文本内容/字号/旋转/粗体/斜体 → CommentText 与 TextFont；
 *  - 引脚编号/名称/长度/方向/类型 → hotpt/start 与 Pin Type。
 *
 * 颜色不在这里：`.olb` 的 XSD 里 Rect/Line/Ellipse 只有 lineStyle/lineWidth/
 * fillStyle/hatchStyle，写 color 会被 XMATIC 直接拒绝（实测报
 * `attribute 'color' is not declared for element 'Defn'`）。Capture 的颜色来自
 * 设计主题调色板，面板底部有说明。
 */

const KIND_TITLE: Record<ElementProps["kind"], string> = {
  rect: "矩形",
  text: "文本",
  line: "线段",
  circle: "圆",
  polyline: "折线",
  pin: "引脚",
  other: "元素",
};

const LINE_WIDTHS = [
  { value: 0, label: "默认" },
  { value: 1, label: "细" },
  { value: 2, label: "中" },
  { value: 3, label: "粗" },
];

/**
 * 线型只保留 Capture 常规的 5 种（用户 2026-11-11：保留最少即可）。
 * 之前多出来的"5 长虚线"是臆造的，已删；源库里若真有表外的值，
 * `lineStyleOptions` 会临时补一条"线型 N"，不改这张表。
 */
const LINE_STYLES = [
  { value: 0, label: "实线" },
  { value: 1, label: "虚线" },
  { value: 2, label: "点线" },
  { value: 3, label: "点划线" },
  { value: 4, label: "双点划线" },
];

/** 表外取值（含多选的 -1"不同"）不能让下拉变成空白，补一条只读的兜底项。 */
const lineStyleOptions = (
  value: number,
): readonly { readonly value: number; readonly label: string }[] =>
  value < 0 || LINE_STYLES.some((option) => option.value === value)
    ? LINE_STYLES
    : [...LINE_STYLES, { value, label: `线型 ${value}` }];

const PIN_SIDES: readonly { readonly value: PinSide; readonly label: string }[] = [
  { value: "left", label: "左" },
  { value: "right", label: "右" },
  { value: "top", label: "上" },
  { value: "bottom", label: "下" },
];

const PIN_TYPES: readonly { readonly value: SymbolPinType; readonly label: string }[] = [
  { value: "input", label: "输入" },
  { value: "output", label: "输出" },
  { value: "bidirectional", label: "双向" },
  { value: "passive", label: "无源" },
  { value: "tristate", label: "三态" },
  { value: "openCollector", label: "开集" },
  { value: "openEmitter", label: "开射" },
  { value: "power", label: "电源" },
  { value: "unspecified", label: "未指定" },
];

const NumberField = ({
  label,
  value,
  step,
  onCommit,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly step: number;
  readonly onCommit: (value: number) => void;
  readonly testId: string;
}): ReactElement => {
  const display = String(Math.round(value * 100) / 100);
  /**
   * 输入框只在"正在打字"时用本地草稿，其余时候直接显示 props 换算出来的值。
   *
   * 早先的写法是 `useState(display)` + `useEffect` 回写：用户输入 103、吸附成 100 之后
   * `display` 没变（还是 100），effect 不触发，输入框就一直显示 103 —— 面板写着 103、
   * 实际是 100（用户 2026-11-11 反馈的"值不跟着变"就是这一类）。
   */
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    setDraft(null);
  }, [display]);
  const shown = draft ?? display;

  const commit = (): void => {
    const parsed = Number(shown);
    setDraft(null);
    if (!Number.isFinite(parsed)) {
      return;
    }
    onCommit(parsed);
  };

  return (
    <label className="symbol-prop">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={shown}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        data-testid={testId}
      />
    </label>
  );
};

const SelectField = <T extends string | number>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly testId: string;
}): ReactElement => (
  <label className="symbol-prop">
    <span>{label}</span>
    <select
      value={String(value)}
      onChange={(event) => {
        const hit = options.find((option) => String(option.value) === event.target.value);
        if (hit !== undefined) {
          onChange(hit.value);
        }
      }}
      data-testid={testId}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

/** 文本内容：多行。失焦或 Ctrl+Enter 才提交 —— 逐键提交会攒出一堆撤销点。 */
const TextContentField = ({
  value,
  onCommit,
}: {
  readonly value: string;
  readonly onCommit: (text: string) => void;
}): ReactElement => {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <label className="symbol-prop symbol-prop-wide">
      <span>内容</span>
      <textarea
        rows={3}
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onCommit(text)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onCommit(text);
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setText(value);
            event.currentTarget.blur();
          }
        }}
        data-testid="prop-text"
      />
    </label>
  );
};

/** 多选时读共同样式：返回共同值、是否"不同"、以及可设置描边的元素个数。 */
const strokeSummary = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  keys: readonly string[],
): { readonly width: number | null; readonly style: number | null; readonly count: number } => {
  let width: number | null = null;
  let style: number | null = null;
  let widthMixed = false;
  let styleMixed = false;
  let count = 0;
  for (const key of keys) {
    const props = readElementProps(section, edits, key);
    if (props === null || !("lineWidth" in props)) {
      continue; // 文本/引脚没有描边
    }
    count += 1;
    if (width === null) {
      width = props.lineWidth;
    } else if (width !== props.lineWidth) {
      widthMixed = true;
    }
    if (style === null) {
      style = props.lineStyle;
    } else if (style !== props.lineStyle) {
      styleMixed = true;
    }
  }
  return {
    width: widthMixed ? null : width,
    style: styleMixed ? null : style,
    count,
  };
};

export const SymbolInspector = ({
  section,
  edits,
  selectedKeys,
  snap,
  onField,
  onStroke,
  onTextStyle,
  onPinType,
  onPinSide,
  onTextContent,
  onDelete,
  editable = true,
}: {
  readonly section: NormalizedSymbolSection;
  readonly edits: SymbolEdits;
  readonly selectedKeys: readonly string[];
  readonly snap: SnapState;
  readonly onField: (field: ElementField, value: number) => void;
  readonly onStroke: (patch: { readonly lineWidth?: number; readonly lineStyle?: number }) => void;
  readonly onTextStyle: (patch: { readonly bold?: boolean; readonly italic?: boolean }) => void;
  readonly onPinType: (type: SymbolPinType) => void;
  readonly onPinSide: (side: PinSide) => void;
  readonly onTextContent: (text: string) => void;
  readonly onDelete: () => void;
  /** 没进编辑模式时只读展示（避免"没打算改却改了"） */
  readonly editable?: boolean;
}): ReactElement => {
  const single = selectedKeys.length === 1 ? readElementProps(section, edits, selectedKeys[0]) : null;
  const step = snap.enabled ? snap.grid : 1;
  const snapOr = (value: number): number => (snap.enabled ? snapValue(value, snap.grid) : value);

  if (selectedKeys.length === 0) {
    return (
      <div
        className={`symbol-inspector${editable ? "" : " is-readonly"}`}
        data-testid="symbol-inspector"
      >
        <p className="inspector-hint">选中一个元素即可编辑。</p>
      </div>
    );
  }

  if (single === null) {
    // 多选：只给"整组一起改"的描边，位置/尺寸各元素不同，逐项改没有意义
    const summary = strokeSummary(section, edits, selectedKeys);
    return (
      <div
        className={`symbol-inspector${editable ? "" : " is-readonly"}`}
        data-testid="symbol-inspector"
      >
        <div className="symbol-prop-head">
          <strong>已选 {selectedKeys.length} 项</strong>
          <em>{summary.count === 0 ? "无描边" : "批量描边"}</em>
        </div>
        {summary.count === 0 ? (
          <p className="inspector-hint">所选元素没有描边。</p>
        ) : (
          <div className="symbol-props-grid">
            <SelectField
              label="线宽"
              value={summary.width ?? -1}
              options={[{ value: -1, label: "不同" }, ...LINE_WIDTHS]}
              onChange={(value) => {
                if (value >= 0) {
                  onStroke({ lineWidth: value });
                }
              }}
              testId="prop-line-width"
            />
            <SelectField
              label="线型"
              value={summary.style ?? -1}
              options={[{ value: -1, label: "不同" }, ...lineStyleOptions(summary.style ?? -1)]}
              onChange={(value) => {
                if (value >= 0) {
                  onStroke({ lineStyle: value });
                }
              }}
              testId="prop-line-style"
            />
          </div>
        )}
        <p className="inspector-hint">
          位置与尺寸选中单个再改。
          {summary.count < selectedKeys.length
            ? ` 其余 ${selectedKeys.length - summary.count} 项无描边，已跳过。`
            : ""}
        </p>
      </div>
    );
  }

  /**
   * 可设描边的图元。这里单独留一个变量，是为了让 TS 收窄到"有 lineWidth"的那几种
   * —— 用 boolean 变量（`const canStyle = …`）在后面的分支里不会触发类型收窄。
   */
  const strokeProps =
    single.kind === "rect" ||
    single.kind === "line" ||
    single.kind === "circle" ||
    single.kind === "polyline"
      ? single
      : null;
  // 文本谁都能删；图形只删用户自己画的那部分（源库本体的几何是别人的）
  const removable =
    single.kind === "text" ||
    ((single.kind === "rect" || single.kind === "line" || single.kind === "circle") &&
      single.added === true);

  return (
    <div
      className={`symbol-inspector${editable ? "" : " is-readonly"}`}
      data-testid="symbol-inspector"
    >
      <div className="symbol-prop-head">
        <strong>{KIND_TITLE[single.kind]}</strong>
        <em>{single.key}</em>
      </div>

      <div className="symbol-props-grid">
        {/* 线段的位置就是起点，下面已经有 X1/Y1 —— 再给一份 X/Y 只会让人猜"改哪个" */}
        {single.kind === "line" ? null : (
          <>
            <NumberField label="X" value={single.x} step={step} onCommit={(value) => onField("x", snapOr(value))} testId="prop-x" />
            <NumberField label="Y" value={single.y} step={step} onCommit={(value) => onField("y", snapOr(value))} testId="prop-y" />
          </>
        )}

        {single.kind === "rect" ? (
          <>
            <NumberField
              label="宽"
              value={single.width}
              step={step}
              onCommit={(value) => onField("width", snapOr(value))}
              testId="prop-width"
            />
            <NumberField
              label="高"
              value={single.height}
              step={step}
              onCommit={(value) => onField("height", snapOr(value))}
              testId="prop-height"
            />
          </>
        ) : null}

        {single.kind === "circle" ? (
          <NumberField
            label="半径"
            value={single.radius}
            step={step}
            /* 半径不吸附：12、7 这种值很常见，凑成 10 的倍数反而画不出想要的圆 */
            onCommit={(value) => onField("radius", value)}
            testId="prop-radius"
          />
        ) : null}

        {single.kind === "line" ? (
          <>
            <NumberField
              label="X1"
              value={single.from.x}
              step={step}
              onCommit={(value) => onField("lineX1", snapOr(value))}
              testId="prop-line-x1"
            />
            <NumberField
              label="Y1"
              value={single.from.y}
              step={step}
              onCommit={(value) => onField("lineY1", snapOr(value))}
              testId="prop-line-y1"
            />
            <NumberField
              label="X2"
              value={single.to.x}
              step={step}
              onCommit={(value) => onField("lineX2", snapOr(value))}
              testId="prop-line-x2"
            />
            <NumberField
              label="Y2"
              value={single.to.y}
              step={step}
              onCommit={(value) => onField("lineY2", snapOr(value))}
              testId="prop-line-y2"
            />
            <div className="symbol-prop symbol-prop-readonly">
              <span>长度</span>
              <b>{single.length}</b>
            </div>
            <div className="symbol-prop symbol-prop-readonly">
              <span>角度</span>
              <b>{single.angle}°</b>
            </div>
          </>
        ) : null}

        {single.kind === "polyline" ? (
          <>
            <div className="symbol-prop symbol-prop-readonly">
              <span>点数</span>
              <b>{single.points}</b>
            </div>
            <div className="symbol-prop symbol-prop-readonly">
              <span>闭合</span>
              <b>{single.closed ? "是" : "否"}</b>
            </div>
          </>
        ) : null}
      </div>

      {single.kind === "text" ? (
        <>
          <div className="symbol-props-grid">
            <NumberField
              label="字号"
              value={single.height}
              step={1}
              onCommit={(value) => onField("textHeight", value)}
              testId="prop-text-height"
            />
            <SelectField
              label="旋转"
              value={single.rotation}
              options={[
                { value: 0, label: "0°" },
                { value: 90, label: "90°" },
                { value: 180, label: "180°" },
                { value: 270, label: "270°" },
              ]}
              onChange={(value) => onField("rotation", value)}
              testId="prop-rotation"
            />
          </div>
          <div className="symbol-prop-row">
            <button
              type="button"
              className={`symbol-chip${single.bold ? " is-on" : ""}`}
              aria-pressed={single.bold}
              onClick={() => onTextStyle({ bold: !single.bold })}
              data-testid="prop-bold"
            >
              B
            </button>
            <button
              type="button"
              className={`symbol-chip symbol-chip-italic${single.italic ? " is-on" : ""}`}
              aria-pressed={single.italic}
              onClick={() => onTextStyle({ italic: !single.italic })}
              data-testid="prop-italic"
            >
              I
            </button>
          </div>
          <TextContentField value={single.text} onCommit={onTextContent} />
        </>
      ) : null}

      {single.kind === "pin" ? (
        <>
          <div className="symbol-props-grid">
            <NumberField
              label="长度"
              value={single.length}
              step={step}
              /* 引脚长度也不吸附：源库常见 15、25 这种非整十长度 */
              onCommit={(value) => onField("pinLength", value)}
              testId="prop-pin-length"
            />
            <SelectField
              label="方向"
              value={single.side}
              options={PIN_SIDES}
              onChange={onPinSide}
              testId="prop-pin-side"
            />
            <SelectField
              label="类型"
              value={single.type}
              options={PIN_TYPES}
              onChange={onPinType}
              testId="prop-pin-type"
            />
          </div>
        </>
      ) : null}

      {strokeProps !== null ? (
        <div className="symbol-props-grid">
          <SelectField
            label="线宽"
            value={strokeProps.lineWidth}
            options={LINE_WIDTHS}
            onChange={(value) => onStroke({ lineWidth: value })}
            testId="prop-line-width"
          />
          <SelectField
            label="线型"
            value={strokeProps.lineStyle}
            options={lineStyleOptions(strokeProps.lineStyle)}
            onChange={(value) => onStroke({ lineStyle: value })}
            testId="prop-line-style"
          />
        </div>
      ) : null}

      <p className="inspector-hint">
        单位 10 mil，吸附{snap.enabled ? ` ${snap.grid}` : "关闭"}；颜色由 Capture 主题决定。
        {editable ? null : " 先点「编辑」才能改。"}
      </p>

      {removable ? (
        <button
          type="button"
          className="symbol-props-delete"
          onClick={onDelete}
          title="删除这个元素（Ctrl+Z 可撤回）"
          data-testid="prop-delete"
        >
          删除元素
        </button>
      ) : null}
    </div>
  );
};
