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

/** 本体四边（框线拖动改大小用；只对 rect 有意义）。 */
export type SymbolShapeBounds = {
  readonly min: { readonly x: number; readonly y: number };
  readonly max: { readonly x: number; readonly y: number };
};

/** 拖框线时抓住了哪几条边（决定最小边长夹持时顶回哪条边）。 */
export type RectEdges = {
  readonly left: boolean;
  readonly right: boolean;
  readonly top: boolean;
  readonly bottom: boolean;
};

/**
 * 一个元素的编辑记录 —— **各项可共存**。
 *
 * 早期版本是"一种编辑一个键"（`{kind:"offset"}` / `{kind:"rotate"}` …），
 * 于是"先挪再用空格转一下"会把位移丢掉、"改完大小再微调位置"会把大小丢掉。
 * 现在按项目分字段：只写用到的、全默认就把这个键删掉（`hasSymbolEdits` 依赖这点）。
 */
export type SymbolEdit = {
  readonly offset?: SymbolShapeOffset;
  /** 文本旋转，90° 的整数倍（叠加在源 rotation 上） */
  readonly rotate?: number;
  /** 文本字号缩放 */
  readonly fontSize?: number;
  /** 本体四边（仅 rect） */
  readonly bounds?: SymbolShapeBounds;
};

export type SymbolEdits = Readonly<Record<string, SymbolEdit>>;

export const EMPTY_SYMBOL_EDITS: SymbolEdits = {};

const MIN_TEXT_HEIGHT = 4;
/** 本体最小边长（拖动框线时不允许压成一条线或反向）。 */
export const MIN_RECT_SIDE = 10;

const isDefaultEdit = (edit: SymbolEdit): boolean =>
  (edit.offset === undefined || (edit.offset.dx === 0 && edit.offset.dy === 0)) &&
  (edit.rotate === undefined || edit.rotate === 0) &&
  (edit.fontSize === undefined || edit.fontSize === 1) &&
  edit.bounds === undefined;

/** 写入一个键的编辑；整条变成默认值就把键删掉（避免留下一堆空记录）。 */
const putEdit = (edits: SymbolEdits, key: string, edit: SymbolEdit): SymbolEdits => {
  if (isDefaultEdit(edit)) {
    const { [key]: _removed, ...rest } = edits;
    return rest;
  }
  return { ...edits, [key]: edit };
};

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
        const edit = shapeEdits.get(symbolShapeKey(sectionIndex, shapeIndex));
        let next = shape;
        // ① 本体四边（框线拖动改大小）
        if (edit?.bounds !== undefined && next.kind === "rect") {
          next = { ...next, min: edit.bounds.min, max: edit.bounds.max };
        }
        // ② 整体平移
        if (edit?.offset !== undefined && (edit.offset.dx !== 0 || edit.offset.dy !== 0)) {
          next = translateSymbolShape(next, edit.offset.dx, edit.offset.dy);
        }
        if (next.kind !== "text") {
          return next;
        }
        if (edit?.rotate !== undefined && edit.rotate !== 0) {
          next = { ...next, rotation: next.rotation + edit.rotate * 90 };
        }
        if (edit?.fontSize !== undefined && edit.fontSize !== 1) {
          next = {
            ...next,
            height: Math.max(Math.round(next.height * edit.fontSize * 10) / 10, MIN_TEXT_HEIGHT),
          };
        }
        return next;
      }),
      pins: section.pins.map((pin, pinIndex) => {
        const edit = pinEdits.get(symbolPinKey(sectionIndex, pinIndex));
        if (edit?.offset === undefined || (edit.offset.dx === 0 && edit.offset.dy === 0)) {
          return pin;
        }
        // 引脚文字锚点必须跟引脚一起平移，否则"拖引脚时标签不动、拖本体时标签乱跑"
        // （用户 2026-10-19 反馈的"标签与引脚分离/间距越拖越宽"）。
        const anchor = pin.labelAnchor;
        return {
          ...pin,
          connection: translateSymbolPoint(pin.connection, edit.offset.dx, edit.offset.dy),
          body: translateSymbolPoint(pin.body, edit.offset.dx, edit.offset.dy),
          ...(anchor === undefined
            ? {}
            : {
                labelAnchor: {
                  name: translateSymbolPoint(anchor.name, edit.offset.dx, edit.offset.dy),
                  number: translateSymbolPoint(anchor.number, edit.offset.dx, edit.offset.dy),
                },
              }),
        };
      }),
    })),
  };
};

export const hasSymbolEdits = (edits: SymbolEdits): boolean =>
  Object.keys(edits).length > 0;

/**
 * 里记一条位移（拖动 / 方向键都会走到这里）。
 * 与旋转、字号、本体四边**互不覆盖**（见 SymbolEdit 的说明）。
 */
export const accumulateOffset = (
  edits: SymbolEdits,
  key: string,
  dx: number,
  dy: number,
): SymbolEdits => {
  const previous = edits[key]?.offset;
  return putEdit(edits, key, {
    ...edits[key],
    offset: { dx: (previous?.dx ?? 0) + dx, dy: (previous?.dy ?? 0) + dy },
  });
};

/** 叠加一次 90° 旋转（文本）。 */
export const accumulateRotation = (edits: SymbolEdits, key: string): SymbolEdits => {
  const turns = (edits[key]?.rotate ?? 0) + 1;
  return putEdit(edits, key, { ...edits[key], rotate: ((turns % 4) + 4) % 4 });
};

/** 叠加一次字号缩放（文本）。 */
export const accumulateFontSize = (
  edits: SymbolEdits,
  key: string,
  factor: number,
): SymbolEdits => {
  const scale = Math.min(Math.max((edits[key]?.fontSize ?? 1) * factor, 0.4), 4);
  return putEdit(edits, key, { ...edits[key], fontSize: Math.round(scale * 100) / 100 });
};

/**
 * 直接设定本体四边（框线拖动改大小；绝对值，不是增量）。
 *
 * `dragged` 告诉这里是哪几条边在被拖 —— 拖过头时只把**被拖的边**按最小边长顶回去，
 * 没动的那条边保持不动（否则框会自己"长"到另一边去）。
 */
export const setRectBounds = (
  edits: SymbolEdits,
  key: string,
  bounds: SymbolShapeBounds,
  dragged?: RectEdges,
): SymbolEdits => {
  const min: { x: number; y: number } = {
    x: Math.min(bounds.min.x, bounds.max.x),
    y: Math.min(bounds.min.y, bounds.max.y),
  };
  const max: { x: number; y: number } = {
    x: Math.max(bounds.min.x, bounds.max.x),
    y: Math.max(bounds.min.y, bounds.max.y),
  };
  if (dragged !== undefined) {
    if (max.x - min.x < MIN_RECT_SIDE) {
      if (dragged.left) {
        min.x = max.x - MIN_RECT_SIDE;
      }
      if (dragged.right) {
        max.x = min.x + MIN_RECT_SIDE;
      }
    }
    if (max.y - min.y < MIN_RECT_SIDE) {
      if (dragged.top) {
        min.y = max.y - MIN_RECT_SIDE;
      }
      if (dragged.bottom) {
        max.y = min.y + MIN_RECT_SIDE;
      }
    }
  }
  return putEdit(edits, key, { ...edits[key], bounds: { min, max } });
};

