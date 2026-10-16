import type { NormalizedSymbol, NormalizedSymbolShape, Point } from "./schemas";

/**
 * 原理图符号的**手工编辑**模型（用户 2026-10-16 要求"所有元素可手动编辑"）。
 *
 * 三类编辑，键都指向"段序号 + 元素序号"：
 *  - `offset`   整体平移 —— 图形元素（本体框 / 分隔线 / 文字标注）与**引脚**都支持；
 *  - `rotate`   文本旋转，叠加在源 rotation 上（90° 的整数倍）；
 *  - `fontSize` 文本字号缩放。
 *
 * 键格式：
 *  - 图形：`<段序号>:<图形序号>`（symbolShapeKey）
 *  - 引脚：`p<段序号>:<引脚序号>`（symbolPinKey）
 *
 * 段/元素序号是数组下标，源数据不变时编辑记录就能稳定对应到同一个元素。
 *
 * 已知限制：.olb 的 CommentText 没有 rotation 字段（实测现网库导出件的 Defn 只有
 * locX/locY/name/textJustification/x1/x2/y1/y2），所以**旋转只在预览生效**，
 * 写库时只带位置与字号。
 */

export const translateSymbolPoint = (point: Point, dx: number, dy: number): Point => ({
  x: point.x + dx,
  y: point.y + dy,
});

export const translateSymbolShape = (
  shape: NormalizedSymbolShape,
  dx: number,
  dy: number,
): NormalizedSymbolShape => {
  switch (shape.kind) {
    case "rect":
      return {
        ...shape,
        min: translateSymbolPoint(shape.min, dx, dy),
        max: translateSymbolPoint(shape.max, dx, dy),
      };
    case "polyline":
      return {
        ...shape,
        points: shape.points.map((point) => translateSymbolPoint(point, dx, dy)),
      };
    default:
      return { ...shape, at: translateSymbolPoint(shape.at, dx, dy) };
  }
};

export const symbolShapeKey = (sectionIndex: number, shapeIndex: number): string =>
  `${sectionIndex}:${shapeIndex}`;

/**
 * 把屏幕像素位移换算成符号世界单位。
 *
 * 预览的内容整体挂在 `scale(s)` 的 `<g>` 上，所以鼠标移动 N 像素 = 世界坐标移动
 * N/s 单位。**拖动必须除这个 scale**，否则非 100% 缩放下"鼠标走 1 厘米、元素跑 2 厘米"。
 * （曾漏除：图形对了、引脚忘了除 → 缩放后引脚拖动速度与图形不一致。）
 */
export const dragDelta = (
  dxPx: number,
  dyPx: number,
  scale: number,
): SymbolShapeOffset => {
  const safe = scale > 0 ? scale : 1;
  return { dx: dxPx / safe, dy: dyPx / safe };
};

export const symbolPinKey = (sectionIndex: number, pinIndex: number): string =>
  `p${sectionIndex}:${pinIndex}`;

export const isSymbolPinKey = (key: string): boolean => key.startsWith("p");

/** 把编辑键拆回 (段序号, 元素序号)。 */
export const parseSymbolEditKey = (key: string): { readonly section: number; readonly index: number } => {
  const body = isSymbolPinKey(key) ? key.slice(1) : key;
  const [section, index] = body.split(":");
  return { section: Number(section), index: Number(index) };
};

export type SymbolShapeOffset = { readonly dx: number; readonly dy: number };

export type SymbolEdit =
  | ({ readonly kind: "offset" } & SymbolShapeOffset)
  | { readonly kind: "rotate"; readonly quarterTurns: number }
  | { readonly kind: "fontSize"; readonly scale: number };

export type SymbolEdits = Readonly<Record<string, SymbolEdit>>;

export const EMPTY_SYMBOL_EDITS: SymbolEdits = {};

const MIN_TEXT_HEIGHT = 4;

export const applySymbolEdits = (
  symbol: NormalizedSymbol,
  edits: SymbolEdits,
): NormalizedSymbol => {
  const keys = Object.keys(edits);
  if (keys.length === 0) {
    return symbol;
  }
  const shapeEdits = new Map<string, SymbolEdit>();
  const pinEdits = new Map<string, SymbolEdit>();
  for (const key of keys) {
    (isSymbolPinKey(key) ? pinEdits : shapeEdits).set(key, edits[key]);
  }

  return {
    ...symbol,
    sections: symbol.sections.map((section, sectionIndex) => ({
      ...section,
      shapes: section.shapes.map((shape, shapeIndex) => {
        let next = shape;
        const offset = shapeEdits.get(symbolShapeKey(sectionIndex, shapeIndex));
        if (offset?.kind === "offset" && (offset.dx !== 0 || offset.dy !== 0)) {
          next = translateSymbolShape(next, offset.dx, offset.dy);
        }
        if (next.kind !== "text") {
          return next;
        }
        const extra = shapeEdits.get(symbolShapeKey(sectionIndex, shapeIndex));
        if (extra?.kind === "rotate" && extra.quarterTurns !== 0) {
          next = { ...next, rotation: next.rotation + extra.quarterTurns * 90 };
        }
        if (extra?.kind === "fontSize" && extra.scale !== 1) {
          next = {
            ...next,
            height: Math.max(Math.round(next.height * extra.scale * 10) / 10, MIN_TEXT_HEIGHT),
          };
        }
        return next;
      }),
      pins: section.pins.map((pin, pinIndex) => {
        const offset = pinEdits.get(symbolPinKey(sectionIndex, pinIndex));
        if (offset?.kind !== "offset" || (offset.dx === 0 && offset.dy === 0)) {
          return pin;
        }
        return {
          ...pin,
          connection: translateSymbolPoint(pin.connection, offset.dx, offset.dy),
          body: translateSymbolPoint(pin.body, offset.dx, offset.dy),
        };
      }),
    })),
  };
};

export const hasSymbolEdits = (edits: SymbolEdits): boolean =>
  Object.keys(edits).length > 0;

/** 累加一条位移编辑（拖动 / 方向键都会走到这里）。 */
export const accumulateOffset = (
  edits: SymbolEdits,
  key: string,
  dx: number,
  dy: number,
): SymbolEdits => {
  const previous = edits[key];
  const base =
    previous?.kind === "offset"
      ? { dx: previous.dx + dx, dy: previous.dy + dy }
      : { dx, dy };
  if (base.dx === 0 && base.dy === 0) {
    const { [key]: _removed, ...rest } = edits;
    return rest;
  }
  return { ...edits, [key]: { kind: "offset", ...base } };
};

/** 叠加一次 90° 旋转（文本）。 */
export const accumulateRotation = (edits: SymbolEdits, key: string): SymbolEdits => {
  const previous = edits[key];
  const turns = previous?.kind === "rotate" ? previous.quarterTurns + 1 : 1;
  return { ...edits, [key]: { kind: "rotate", quarterTurns: ((turns % 4) + 4) % 4 } };
};

/** 叠加一次字号缩放（文本）。 */
export const accumulateFontSize = (
  edits: SymbolEdits,
  key: string,
  factor: number,
): SymbolEdits => {
  const previous = edits[key];
  const scale = Math.min(Math.max((previous?.kind === "fontSize" ? previous.scale : 1) * factor, 0.4), 4);
  return { ...edits, [key]: { kind: "fontSize", scale: Math.round(scale * 100) / 100 } };
};
