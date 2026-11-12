import type { NormalizedSymbolSection, SymbolPinType } from "./schemas";
import {
  MIN_RECT_SIDE,
  isSymbolPinKey,
  isSymbolPinLabelKey,
  parseSymbolEditKey,
  parseSymbolPinLabelKey,
  setCircleRadius,
  setFontSize,
  setLineEndpoints,
  setLineStyle,
  setLineWidth,
  setOffset,
  setPinPoints,
  setPinType,
  setRectBounds,
  setRotationTurns,
  setTextBold,
  setTextItalic,
  type SymbolEdits,
  type SymbolShapeBounds,
} from "./symbol-edit";
import { bodyBoxOf, pinLabelAnchors, pinLabelBoxOf } from "./symbol-labels";

/**
 * 属性面板的读 / 写换算（纯函数，用户 2026-10-20）。
 *
 * 关键不变式：**读的是"原始值 + 当前编辑"，写回时用绝对值覆盖对应字段**。
 * 例如本体已经有 `offset.dx=7`，面板显示 X=107；用户输入 100 时应写
 * `offset.dx = 100 - 原始 minX`，而不是在 7 上再叠 100。
 *
 * rect 的 X/Y 只改 `offset`、宽高只改 `bounds` —— 两者永不同时写，
 * 从公式上杜绝"改宽顺带把位置挪走"。
 */

export type PinSide = "left" | "right" | "top" | "bottom";

/**
 * 属性面板要显示的一份"当前值"（原始数据 + 已套编辑）。
 *
 * 用户 2026-11-11 要求右侧「属性编辑」tab 覆盖文本/线段/圆/矩形等内容、线宽、尺寸，
 * 所以这里从原来只认 rect/text 扩展到 6 种：line（两点直线）、circle（原生椭圆参数
 * 且 rx≈ry）、polyline（其余折线）、pin（引脚）。`kind` 决定面板显示哪组字段。
 */
export type ElementProps =
  | {
      readonly kind: "rect";
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      /** Capture Line Width / Line Style 档位（0 = 默认） */
      readonly lineWidth: number;
      readonly lineStyle: number;
      readonly added: boolean;
    }
  | {
      readonly kind: "text";
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly height: number;
      readonly rotation: number;
      readonly fontFactor: number;
      readonly text: string;
      readonly bold: boolean;
      readonly italic: boolean;
      readonly added: boolean;
    }
  | {
      readonly kind: "line";
      readonly key: string;
      /** 起点（与 `from` 同值）—— 所有类型都带 x/y，面板的位置字段才能统一渲染 */
      readonly x: number;
      readonly y: number;
      readonly from: { readonly x: number; readonly y: number };
      readonly to: { readonly x: number; readonly y: number };
      /** 长度与角度都是派生值（只读），角度单位度、0 = 向右、屏幕 y 向下 */
      readonly length: number;
      readonly angle: number;
      readonly lineWidth: number;
      readonly lineStyle: number;
      readonly added: boolean;
    }
  | {
      readonly kind: "circle";
      readonly key: string;
      /** 圆心（与 `center` 同值） */
      readonly x: number;
      readonly y: number;
      readonly center: { readonly x: number; readonly y: number };
      readonly radius: number;
      readonly lineWidth: number;
      readonly lineStyle: number;
      readonly added: boolean;
    }
  | {
      readonly kind: "polyline";
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly points: number;
      readonly closed: boolean;
      readonly lineWidth: number;
      readonly lineStyle: number;
    }
  | {
      readonly kind: "pin";
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly name: string;
      readonly number: string;
      readonly length: number;
      readonly side: PinSide;
      readonly type: SymbolPinType;
    }
  | { readonly kind: "other"; readonly key: string; readonly x: number; readonly y: number };

export type ElementField =
  | "x"
  | "y"
  | "width"
  | "height"
  | "textHeight"
  | "rotation"
  | "radius"
  | "lineX1"
  | "lineY1"
  | "lineX2"
  | "lineY2"
  | "pinLength";

const round2 = (value: number): number => Math.round(value * 100) / 100;

const normalizeTurns = (turns: number): number => ((Math.round(turns) % 4) + 4) % 4;

const normalizeRotation = (degrees: number): number => ((Math.round(degrees) % 360) + 360) % 360;

/** 取该元素的"原始锚点"（不含 edit）：引脚取连接端，rect 取 min，文本取 at，折线取点盒 min。 */
const sourceAnchor = (
  section: NormalizedSymbolSection,
  key: string,
): { readonly x: number; readonly y: number } | null => {
  // 单个引脚标签（用户 2026-11-10）：锚点取它**当前占位盒的左上角**，
  // 属性面板显示的 X/Y 即盒角；写回时 offset 增量与盒位移一致，自洽。
  const label = parseSymbolPinLabelKey(key);
  if (label !== null) {
    const pin = section.pins[label.pinIndex];
    if (pin === undefined) {
      return null;
    }
    const box = pinLabelBoxOf(pin, label.kind, bodyBoxOf(section));
    return { x: box.minX, y: box.minY };
  }
  const { index } = parseSymbolEditKey(key);
  if (isSymbolPinKey(key)) {
    const pin = section.pins[index];
    return pin === undefined ? null : pin.connection;
  }
  const shape = section.shapes[index];
  if (shape === undefined) {
    return null;
  }
  switch (shape.kind) {
    case "rect":
      return { x: Math.min(shape.min.x, shape.max.x), y: Math.min(shape.min.y, shape.max.y) };
    case "polyline": {
      /**
       * 参考点必须与属性面板显示的那个点一致，否则"改 X"会以另一个基准写回，
       * 表现为输入 100 后元素跳到别处（用户 2026-11-11 的圆/线段）：
       *  圆 → 圆心；两点直线 → 起点；其余折线 → 点盒最小角。
       */
      if (shape.primitive?.type === "ellipse" && Math.abs(shape.primitive.rx - shape.primitive.ry) < 1e-6) {
        return shape.primitive.center;
      }
      if (shape.primitive === undefined && shape.points.length === 2) {
        return shape.points[0];
      }
      if (shape.points.length === 0) {
        return { x: 0, y: 0 };
      }
      return {
        x: Math.min(...shape.points.map((point) => point.x)),
        y: Math.min(...shape.points.map((point) => point.y)),
      };
    }
    default:
      return shape.at;
  }
};

const rawRectBounds = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
): SymbolShapeBounds | null => {
  const { index } = parseSymbolEditKey(key);
  const shape = section.shapes[index];
  if (shape === undefined || shape.kind !== "rect") {
    return null;
  }
  const edited = edits[key]?.bounds;
  const min = edited?.min ?? shape.min;
  const max = edited?.max ?? shape.max;
  return {
    min: { x: Math.min(min.x, max.x), y: Math.min(min.y, max.y) },
    max: { x: Math.max(min.x, max.x), y: Math.max(min.y, max.y) },
  };
};

/** 引脚朝向：连接端相对**本体端**在哪个方向（Capture 的引脚只有这四个朝向）。 */
const pinSideOfVector = (dx: number, dy: number): PinSide => {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "bottom" : "top";
};

const boxOfPoints = (
  points: readonly { readonly x: number; readonly y: number }[],
): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

export const readElementProps = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
): ElementProps | null => {
  const edit = edits[key];
  const offset = edit?.offset ?? { dx: 0, dy: 0 };
  const { index } = parseSymbolEditKey(key);

  // 单个引脚标签：面板只给位置（文本内容走双击行内编辑）
  if (isSymbolPinLabelKey(key)) {
    const anchor = sourceAnchor(section, key);
    return anchor === null
      ? null
      : {
          kind: "other",
          key,
          x: round2(anchor.x + offset.dx),
          y: round2(anchor.y + offset.dy),
        };
  }

  if (isSymbolPinKey(key)) {
    const pin = section.pins[index];
    if (pin === undefined) {
      return null;
    }
    // 端点优先取重定向后的值，再叠加整体位移（与 applySymbolEdits 同序）
    const points = edit?.points ?? { connection: pin.connection, body: pin.body };
    const connection = {
      x: points.connection.x + offset.dx,
      y: points.connection.y + offset.dy,
    };
    const body = { x: points.body.x + offset.dx, y: points.body.y + offset.dy };
    const dx = connection.x - body.x;
    const dy = connection.y - body.y;
    return {
      kind: "pin",
      key,
      x: round2(connection.x),
      y: round2(connection.y),
      name: edit?.pinText?.name ?? pin.name,
      number: edit?.pinText?.number ?? pin.number,
      length: round2(Math.hypot(dx, dy)),
      side: pinSideOfVector(dx, dy),
      type: edit?.pinType ?? pin.type,
    };
  }

  const shape = section.shapes[index];
  if (shape === undefined) {
    return null;
  }
  /**
   * 描边样式**必须优先读编辑值**（用户 2026-11-11 反馈「一直显示实线」）：
   * 写库走的是 `shape + edit`（`applySymbolEdits` 里的 `withStroke`），只读原始 shape
   * 会让面板永远显示改之前的值 —— 改了线型下拉弹回去，预览却已经变了。
   */
  if (shape.kind === "rect") {
    const bounds = rawRectBounds(section, edits, key)!;
    return {
      kind: "rect",
      key,
      x: round2(bounds.min.x + offset.dx),
      y: round2(bounds.min.y + offset.dy),
      width: round2(bounds.max.x - bounds.min.x),
      height: round2(bounds.max.y - bounds.min.y),
      lineWidth: edit?.lineWidth ?? shape.lineWidth ?? 0,
      lineStyle: edit?.lineStyle ?? shape.lineStyle ?? 0,
      added: shape.added === true,
    };
  }
  if (shape.kind === "text") {
    const factor = edit?.fontSize ?? 1;
    return {
      kind: "text",
      key,
      x: round2(shape.at.x + offset.dx),
      y: round2(shape.at.y + offset.dy),
      height: round2(shape.height * factor),
      rotation: normalizeRotation(shape.rotation + 90 * (edit?.rotate ?? 0)),
      fontFactor: factor,
      text: shape.text,
      bold: edit?.bold ?? shape.bold === true,
      italic: edit?.italic ?? shape.italic === true,
      added: shape.added === true,
    };
  }
  // 折线：用户画的圆/线段单独识别，其余按包围盒只读展示
  if (shape.kind === "polyline") {
    // 与 rect 同理：先读编辑值，否则改过线型/线宽后下拉会弹回原始值
    const stroke = {
      lineWidth: edit?.lineWidth ?? shape.lineWidth ?? 0,
      lineStyle: edit?.lineStyle ?? shape.lineStyle ?? 0,
      added: shape.added === true,
    };
    const ellipse = shape.primitive?.type === "ellipse" ? shape.primitive : null;
    if (ellipse !== null && Math.abs(ellipse.rx - ellipse.ry) < 1e-6) {
      const center = {
        x: round2(ellipse.center.x + offset.dx),
        y: round2(ellipse.center.y + offset.dy),
      };
      return {
        kind: "circle",
        key,
        x: center.x,
        y: center.y,
        center,
        // 半径由编辑值决定；`primitive` 已在别处保证点集同步，这里只读参数
        radius: round2(edit?.radius ?? ellipse.rx),
        ...stroke,
      };
    }
    const first = shape.points[0];
    const last = shape.points[shape.points.length - 1];
    if (
      shape.primitive === undefined &&
      shape.points.length === 2 &&
      first !== undefined &&
      last !== undefined
    ) {
      const from = { x: (edit?.endpoints?.from.x ?? first.x) + offset.dx, y: (edit?.endpoints?.from.y ?? first.y) + offset.dy };
      const to = { x: (edit?.endpoints?.to.x ?? last.x) + offset.dx, y: (edit?.endpoints?.to.y ?? last.y) + offset.dy };
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      return {
        kind: "line",
        key,
        x: round2(from.x),
        y: round2(from.y),
        from: { x: round2(from.x), y: round2(from.y) },
        to: { x: round2(to.x), y: round2(to.y) },
        length: round2(Math.hypot(dx, dy)),
        angle: round2((Math.atan2(dy, dx) * 180) / Math.PI),
        ...stroke,
      };
    }
    const box = boxOfPoints(shape.points);
    return {
      kind: "polyline",
      key,
      x: round2(box.minX + offset.dx),
      y: round2(box.minY + offset.dy),
      width: round2(box.maxX - box.minX),
      height: round2(box.maxY - box.minY),
      points: shape.points.length,
      closed: shape.closed,
      ...stroke,
    };
  }
  const anchor = sourceAnchor(section, key)!;
  return {
    kind: "other",
    key,
    x: round2(anchor.x + offset.dx),
    y: round2(anchor.y + offset.dy),
  };
};

/** 设置 X（绝对坐标）。rect 只改 offset，bounds 不动。 */
export const writeElementX = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  value: number,
): SymbolEdits => {
  const anchor = sourceAnchor(section, key);
  if (anchor === null || !Number.isFinite(value)) {
    return edits;
  }
  const dy = edits[key]?.offset?.dy ?? 0;
  return setOffset(edits, key, { dx: value - anchor.x, dy });
};

/** 设置 Y（绝对坐标）。 */
export const writeElementY = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  value: number,
): SymbolEdits => {
  const anchor = sourceAnchor(section, key);
  if (anchor === null || !Number.isFinite(value)) {
    return edits;
  }
  const dx = edits[key]?.offset?.dx ?? 0;
  return setOffset(edits, key, { dx, dy: value - anchor.y });
};

/** 设置本体宽度（rect）。只改 bounds.max.x，offset 不动。 */
export const writeElementWidth = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  value: number,
): SymbolEdits => {
  const bounds = rawRectBounds(section, edits, key);
  if (bounds === null || !Number.isFinite(value)) {
    return edits;
  }
  const width = Math.max(value, MIN_RECT_SIDE);
  return setRectBounds(edits, key, {
    min: bounds.min,
    max: { x: bounds.min.x + width, y: bounds.max.y },
  });
};

/** 设置本体高度（rect）。只改 bounds.max.y。 */
export const writeElementHeight = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  value: number,
): SymbolEdits => {
  const bounds = rawRectBounds(section, edits, key);
  if (bounds === null || !Number.isFinite(value)) {
    return edits;
  }
  const height = Math.max(value, MIN_RECT_SIDE);
  return setRectBounds(edits, key, {
    min: bounds.min,
    max: { x: bounds.max.x, y: bounds.min.y + height },
  });
};

/** 设置文本字号（世界单位，写库同单位）。 */
export const writeTextHeight = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  value: number,
): SymbolEdits => {
  const { index } = parseSymbolEditKey(key);
  const shape = section.shapes[index];
  if (shape === undefined || shape.kind !== "text" || !(value > 0)) {
    return edits;
  }
  return setFontSize(edits, key, value / shape.height);
};

/** 设置文本旋转（0/90/180/270 绝对角度）。 */
export const writeTextRotation = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  degrees: number,
): SymbolEdits => {
  const { index } = parseSymbolEditKey(key);
  const shape = section.shapes[index];
  if (shape === undefined || shape.kind !== "text" || !Number.isFinite(degrees)) {
    return edits;
  }
  const baseTurns = normalizeTurns(shape.rotation / 90);
  const targetTurns = normalizeTurns(degrees / 90);
  return setRotationTurns(edits, key, targetTurns - baseTurns);
};

/**
 * 设置圆半径（用户 2026-11-11）。
 *
 * 只接受"真的是圆"的图元（`primitive.type === "ellipse"` 且 rx≈ry）——
 * 源库的椭圆（如 DSUB 的机壳圆弧）不是圆，改半径会把形状拉成另一种东西，
 * 那种图元面板只给位置。
 */
export const writeCircleRadius = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  value: number,
): SymbolEdits => {
  const { index } = parseSymbolEditKey(key);
  const shape = section.shapes[index];
  if (shape === undefined || shape.kind !== "polyline" || shape.primitive?.type !== "ellipse") {
    return edits;
  }
  if (!(value > 0)) {
    return edits;
  }
  return setCircleRadius(edits, key, value);
};

/**
 * 设置线段端点（绝对坐标）。
 *
 * 写入前把当前的 `offset` 折进端点：面板显示的是"原始点 + 位移"，
 * 用户看到的坐标就是目标坐标，不能写回后再叠一次位移。
 */
export const writeLineEndpoint = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  field: "lineX1" | "lineY1" | "lineX2" | "lineY2",
  value: number,
): SymbolEdits => {
  if (!Number.isFinite(value)) {
    return edits;
  }
  const props = readElementProps(section, edits, key);
  if (props === null || props.kind !== "line") {
    return edits;
  }
  const from = { x: props.from.x, y: props.from.y };
  const to = { x: props.to.x, y: props.to.y };
  switch (field) {
    case "lineX1":
      from.x = value;
      break;
    case "lineY1":
      from.y = value;
      break;
    case "lineX2":
      to.x = value;
      break;
    default:
      to.y = value;
  }
  return setLineEndpoints(edits, key, from, to);
};

/**
 * 设置引脚长度：**连接端不动**，本体端沿当前轴线伸缩。
 *
 * 与 Capture 一致 —— 引脚外端是电气连接点（网表靠它），改长度只能动贴本体的那一端。
 */
export const writePinLength = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  value: number,
): SymbolEdits => {
  if (!isSymbolPinKey(key) || !(value > 0)) {
    return edits;
  }
  const props = readElementProps(section, edits, key);
  const { index } = parseSymbolEditKey(key);
  const pin = section.pins[index];
  if (props === null || props.kind !== "pin" || pin === undefined) {
    return edits;
  }
  const points = edits[key]?.points ?? { connection: pin.connection, body: pin.body };
  const offset = edits[key]?.offset ?? { dx: 0, dy: 0 };
  const connection = {
    x: points.connection.x + offset.dx,
    y: points.connection.y + offset.dy,
  };
  const body = { x: points.body.x + offset.dx, y: points.body.y + offset.dy };
  const dx = body.x - connection.x;
  const dy = body.y - connection.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return edits;
  }
  const nextBody = {
    x: connection.x + (dx / length) * value,
    y: connection.y + (dy / length) * value,
  };
  return setPinPoints(edits, key, {
    connection,
    body: nextBody,
    /**
     * 长度变了，标签要跟着本体端一起挪 —— **不能省**：
     * 上下引脚的名称/脚号是按锚点竖排的，缺锚点会退回"从本体底边往上拉"，
     * 文字直接横跨整个符号（用户 2026-10-21 踩过）。
     */
    labelAnchor: pinLabelAnchors(
      { ...pin, connection, body: nextBody },
      bodyBoxOf(section),
    ),
  });
};

/**
 * 设置引脚朝向：**连接端与长度都不变**，把本体端转到指定一侧。
 *
 * 这是"把右侧引脚翻到左侧"的等价操作，也是 Capture 里改引脚方向的唯一途径
 * （OLB 没有单独的 orientation 字段，方向由 hotpt/start 的相对位置决定）。
 */
export const writePinSide = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  side: PinSide,
): SymbolEdits => {
  if (!isSymbolPinKey(key)) {
    return edits;
  }
  const props = readElementProps(section, edits, key);
  const { index } = parseSymbolEditKey(key);
  const pin = section.pins[index];
  if (props === null || props.kind !== "pin" || pin === undefined) {
    return edits;
  }
  const points = edits[key]?.points ?? { connection: pin.connection, body: pin.body };
  const offset = edits[key]?.offset ?? { dx: 0, dy: 0 };
  const connection = {
    x: points.connection.x + offset.dx,
    y: points.connection.y + offset.dy,
  };
  const length = Math.max(props.length, 1);
  // 单位向量指向"本体该在哪一侧"
  const unit =
    side === "right"
      ? { x: -1, y: 0 }
      : side === "left"
        ? { x: 1, y: 0 }
        : side === "top"
          ? { x: 0, y: 1 }
          : { x: 0, y: -1 };
  const nextBody = { x: connection.x + unit.x * length, y: connection.y + unit.y * length };
  return setPinPoints(edits, key, {
    connection,
    body: nextBody,
    // 换边后按新边重算锚点：缺锚点会让上下引脚的名称竖排横跨整个符号
    labelAnchor: pinLabelAnchors({ ...pin, connection, body: nextBody }, bodyBoxOf(section)),
  });
};

/** 多选批量改描边：只作用于图形（文本没有线宽概念）。 */
export const writeSelectionStroke = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  keys: readonly string[],
  patch: { readonly lineWidth?: number; readonly lineStyle?: number },
): SymbolEdits => {
  let next = edits;
  for (const key of keys) {
    if (isSymbolPinKey(key) || isSymbolPinLabelKey(key)) {
      continue;
    }
    const shape = section.shapes[parseSymbolEditKey(key).index];
    if (shape === undefined || shape.kind === "text") {
      continue;
    }
    if (patch.lineWidth !== undefined) {
      next = setLineWidth(next, key, patch.lineWidth);
    }
    if (patch.lineStyle !== undefined) {
      next = setLineStyle(next, key, patch.lineStyle);
    }
  }
  return next;
};

/** 文本样式（粗体/斜体）—— 单选时由面板直接调用。 */
export const writeTextStyle = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  patch: { readonly bold?: boolean; readonly italic?: boolean },
): SymbolEdits => {
  const shape = section.shapes[parseSymbolEditKey(key).index];
  if (shape === undefined || shape.kind !== "text") {
    return edits;
  }
  let next = edits;
  if (patch.bold !== undefined) {
    next = setTextBold(next, key, patch.bold);
  }
  if (patch.italic !== undefined) {
    next = setTextItalic(next, key, patch.italic);
  }
  return next;
};

/** 引脚电气类型。 */
export const writePinType = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
  type: SymbolPinType,
): SymbolEdits => {
  const pin = section.pins[parseSymbolEditKey(key).index];
  if (pin === undefined || !isSymbolPinKey(key)) {
    return edits;
  }
  return setPinType(edits, key, type);
};
