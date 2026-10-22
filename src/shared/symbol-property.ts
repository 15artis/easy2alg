import type { NormalizedSymbolSection } from "./schemas";
import {
  MIN_RECT_SIDE,
  isSymbolPinKey,
  parseSymbolEditKey,
  setFontSize,
  setOffset,
  setRectBounds,
  setRotationTurns,
  type SymbolEdits,
  type SymbolShapeBounds,
} from "./symbol-edit";

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

export type ElementProps =
  | {
      readonly kind: "rect";
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "text";
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly height: number;
      readonly rotation: number;
      readonly fontFactor: number;
    }
  | { readonly kind: "other"; readonly key: string; readonly x: number; readonly y: number };

export type ElementField = "x" | "y" | "width" | "height" | "textHeight" | "rotation";

const round2 = (value: number): number => Math.round(value * 100) / 100;

const normalizeTurns = (turns: number): number => ((Math.round(turns) % 4) + 4) % 4;

const normalizeRotation = (degrees: number): number => ((Math.round(degrees) % 360) + 360) % 360;

/** 取该元素的"原始锚点"（不含 edit）：引脚取连接端，rect 取 min，文本取 at，折线取点盒 min。 */
const sourceAnchor = (
  section: NormalizedSymbolSection,
  key: string,
): { readonly x: number; readonly y: number } | null => {
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

export const readElementProps = (
  section: NormalizedSymbolSection,
  edits: SymbolEdits,
  key: string,
): ElementProps | null => {
  const edit = edits[key];
  const offset = edit?.offset ?? { dx: 0, dy: 0 };
  const { index } = parseSymbolEditKey(key);

  if (isSymbolPinKey(key)) {
    const pin = section.pins[index];
    return pin === undefined
      ? null
      : {
          kind: "other",
          key,
          x: round2(pin.connection.x + offset.dx),
          y: round2(pin.connection.y + offset.dy),
        };
  }

  const shape = section.shapes[index];
  if (shape === undefined) {
    return null;
  }
  if (shape.kind === "rect") {
    const bounds = rawRectBounds(section, edits, key)!;
    return {
      kind: "rect",
      key,
      x: round2(bounds.min.x + offset.dx),
      y: round2(bounds.min.y + offset.dy),
      width: round2(bounds.max.x - bounds.min.x),
      height: round2(bounds.max.y - bounds.min.y),
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
