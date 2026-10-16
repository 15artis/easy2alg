import type { NormalizedSymbol, NormalizedSymbolShape, Point } from "./schemas";

/**
 * 原理图符号的**手工调整**模型。
 *
 * 自动转换不可能对所有器件都排得好看，用户需要在预览里手动挪一下位置。
 * 目前只做「整体平移」：把某个图形元素（本体框 / 分隔线 / 文字标注）拖动到新位置，
 * 不改变引脚的电气连接点 —— 引脚一旦挪动就可能与本体框脱开，风险远大于收益。
 *
 * 标识用 `<段序号>:<图形序号>`：段序号是 NormalizedSymbol.sections 的下标，
 * 图形序号是该段 shapes 数组的下标。这样即使重跑转换，只要源数据不变，
 * 编辑记录就能稳定对应到同一个元素。
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

export type SymbolShapeOffset = { readonly dx: number; readonly dy: number };
export type SymbolEdits = Readonly<Record<string, SymbolShapeOffset>>;

export const EMPTY_SYMBOL_EDITS: SymbolEdits = {};

export const applySymbolEdits = (
  symbol: NormalizedSymbol,
  edits: SymbolEdits,
): NormalizedSymbol => {
  const keys = Object.keys(edits);
  if (keys.length === 0) {
    return symbol;
  }
  return {
    ...symbol,
    sections: symbol.sections.map((section, sectionIndex) => ({
      ...section,
      shapes: section.shapes.map((shape, shapeIndex) => {
        const offset = edits[symbolShapeKey(sectionIndex, shapeIndex)];
        return offset === undefined
          ? shape
          : translateSymbolShape(shape, offset.dx, offset.dy);
      }),
    })),
  };
};

export const hasSymbolEdits = (edits: SymbolEdits): boolean =>
  Object.keys(edits).length > 0;
