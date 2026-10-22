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
 * 已知限制：早期的结论"CommentText 没有 rotation 字段、旋转只能留在预览里"是**错的**
 * （2026-10-19 用 XMATIC 实验推翻）：旋转由 `<TextFont>` 的 `orientation` 承载，
 * 90 是合法值且能原样回读。现在 `capture-olb.ts` 会同时写 orientation 与旋转后的包围盒，
 * 预览里竖排的区域标注到了 Capture 仍是竖排。
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
/** 引脚两个端点的绝对坐标（连接端在外、body 端贴本体边）。 */
export type SymbolPinPoints = {
  readonly connection: { readonly x: number; readonly y: number };
  readonly body: { readonly x: number; readonly y: number };
  /**
   * 换边后按新边重新算好的标签锚点。**不能省**：上下引脚的名称/脚号在预览里
   * 是从锚点竖排的，缺了锚点会退回"从本体底边往上拉"，表现就是文字横跨整个符号
   * （用户 2026-10-21 反馈"放到上下侧就不正常"）。
   */
  readonly labelAnchor?: {
    readonly name: { readonly x: number; readonly y: number };
    readonly number: { readonly x: number; readonly y: number };
  };
};

export type SymbolEdit = {
  readonly offset?: SymbolShapeOffset;
  /** 文本旋转，90° 的整数倍（叠加在源 rotation 上） */
  readonly rotate?: number;
  /** 文本字号缩放 */
  readonly fontSize?: number;
  /** 本体四边（仅 rect） */
  readonly bounds?: SymbolShapeBounds;
  /**
   * 引脚重定向后的绝对端点（用户 2026-10-21：把右侧引脚拖到左侧后，
   * 引脚方向必须跟着翻过来）。设置它时 offset 会被清零 —— 两点已是最终坐标。
   */
  readonly points?: SymbolPinPoints;
  /** 文本内容替换（用户 2026-10-21：双击文本直接改字）。空串 = 清空显示 */
  readonly text?: string;
  /** 引脚名/脚号替换（用户 2026-10-22：双击引脚标签直接改字）。空串 = 清空显示 */
  readonly pinText?: {
    readonly name?: string;
    readonly number?: string;
  };
  /**
   * 删除这条注释文本（用户 2026-10-22）。**用隐藏而不是从数组里删**：
   * 形状下标是编辑键的一部分，一旦删除后续所有编辑都会错位。
   */
  readonly hidden?: boolean;
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
  edit.bounds === undefined &&
  edit.points === undefined &&
  edit.text === undefined &&
  edit.pinText === undefined &&
  edit.hidden !== true;

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
        if (edit?.text !== undefined) {
          next = { ...next, text: edit.text };
        }
        if (edit?.hidden === true) {
          next = { ...next, hidden: true };
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
        // ① 引脚名/脚号替换（双击标签改字）
        let next = pin;
        if (edit?.pinText?.name !== undefined) {
          next = { ...next, name: edit.pinText.name };
        }
        if (edit?.pinText?.number !== undefined) {
          next = { ...next, number: edit.pinText.number };
        }
        // ② 重定向：两点是绝对坐标，直接覆盖；标签锚点作废（换边后旧锚点全错），
        //    让预览回退到"按新边重新推导"。
        if (edit?.points !== undefined) {
          next = {
            ...pin,
            connection: edit.points.connection,
            body: edit.points.body,
            labelAnchor: edit.points.labelAnchor,
          };
        }
        if (edit?.offset === undefined || (edit.offset.dx === 0 && edit.offset.dy === 0)) {
          return next;
        }
        // ③ 平移。引脚文字锚点必须跟引脚一起平移，否则"拖引脚时标签不动、拖本体时标签乱跑"
        // （用户 2026-10-19 反馈的"标签与引脚分离/间距越拖越宽"）。
        const anchor = next.labelAnchor;
        return {
          ...next,
          connection: translateSymbolPoint(next.connection, edit.offset.dx, edit.offset.dy),
          body: translateSymbolPoint(next.body, edit.offset.dx, edit.offset.dy),
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
 * 用户新加的文本（用户 2026-10-21：支持添加文本）。追加在所在段 shapes 的**末尾**，
 * 顺序确定 → 编辑键（s:<section>:<index>）稳定，可拖动/双击改字/进属性面板。
 */
export type AddedTextShape = {
  readonly id: string;
  /** 放进哪一段 */
  readonly section: number;
  readonly text: string;
  readonly at: { readonly x: number; readonly y: number };
  readonly height: number;
};

export const appendAddedTexts = (
  symbol: NormalizedSymbol,
  added: readonly AddedTextShape[] | undefined,
): NormalizedSymbol => {
  if (added === undefined || added.length === 0) {
    return symbol;
  }
  const sections = symbol.sections.map((section, sectionIndex) => {
    const forSection = added.filter((item) => item.section === sectionIndex);
    if (forSection.length === 0) {
      return section;
    }
    return {
      ...section,
      shapes: [
        ...section.shapes,
        ...forSection.map((item) => ({
          kind: "text" as const,
          text: item.text,
          at: item.at,
          rotation: 0,
          height: item.height,
        })),
      ],
    };
  });
  return { ...symbol, sections };
};

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
 * 直接设定位移（绝对值，不是增量）—— 属性面板输入精确坐标时用。
 *
 * 与 `accumulateOffset` 的差别很重要：属性面板显示的是"原始坐标 + 当前 offset"，
 * 用户输入 100 时应该写 `100 - 原始坐标`，而不是在旧 offset 上再加 100。
 */
export const setOffset = (
  edits: SymbolEdits,
  key: string,
  offset: { readonly dx: number; readonly dy: number },
): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], offset: { dx: offset.dx, dy: offset.dy } });

/**
 * 直接设定引脚两端（绝对值）—— 拖过本体另一侧后重定向用。
 * offset 一并清掉：points 已经是最终坐标，再叠 offset 会二次位移。
 */
export const setPinPoints = (
  edits: SymbolEdits,
  key: string,
  points: SymbolPinPoints,
): SymbolEdits => putEdit(edits, key, { points });

/** 直接设定文本内容（双击编辑）。空串合法 = 清空显示。 */
export const setTextContent = (edits: SymbolEdits, key: string, text: string): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], text });

/** 删除 / 恢复一条注释文本（隐藏，不移动下标）。 */
export const setTextHidden = (edits: SymbolEdits, key: string, hidden: boolean): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], hidden });

/** 直接设定引脚名 / 脚号（双击引脚标签）。空串合法 = 清空显示。 */
export const setPinText = (
  edits: SymbolEdits,
  key: string,
  kind: "name" | "number",
  text: string,
): SymbolEdits =>
  putEdit(edits, key, {
    ...edits[key],
    pinText: { ...edits[key]?.pinText, [kind]: text },
  });

/** 直接设定字号倍数（0.4–4）。 */
export const setFontSize = (edits: SymbolEdits, key: string, factor: number): SymbolEdits => {
  const scale = Math.min(Math.max(factor, 0.4), 4);
  return putEdit(edits, key, { ...edits[key], fontSize: Math.round(scale * 100) / 100 });
};

/** 直接设定文本旋转（90° 的倍数，0..3 圈）。 */
export const setRotationTurns = (edits: SymbolEdits, key: string, turns: number): SymbolEdits => {
  const normalized = ((Math.round(turns) % 4) + 4) % 4;
  return putEdit(edits, key, { ...edits[key], rotate: normalized });
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

