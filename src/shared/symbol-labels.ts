import type { NormalizedSymbolPin, NormalizedSymbolSection } from "./schemas";

/**
 * Capture 画引脚名/引脚号的规则 —— 预览、避让计算、写 OLB、验收测试共用同一份。
 *
 * 规则来自实机截图的像素测量（用户 2026-10-16 截图 + 标定过的 px/单位）：
 *
 *  1. **引脚名在**本体**内侧**、沿引脚方向排：左右引脚横排，上下引脚竖排。
 *     名字首端离本体边缘约 5 单位（`SYMBOL_LABEL_OFFSET`）。
 *  2. **引脚号在本体外侧**、紧贴本体边缘，同样沿引脚方向排。
 *  3. 字宽实测 ≈ 4.9 单位/字符（height=-9 的 Arial），下行取 5；
 *     窄字符（i/l/1/./:）约 2。字高约 7~8 单位，故文字半宽取 4。
 *
 * 重叠就是这么来的：竖排名字从本体的上/下边**往本体内部**长，横排名字从
 * 左/右边**往本体内部**长，两者在**四角**必然相交 —— 立创EDA 的本体是按比
 * Capture 小得多的字宽设计的。避让算法见 shared/symbol-layout.ts。
 */

/** 文字离本体边缘的留白。 */
export const SYMBOL_LABEL_OFFSET = 5;
/** 文字半高；竖排时它就是文字在水平方向占的半宽。 */
export const SYMBOL_LABEL_HALF = 4;
/** 两组标签之间要求的最小间隙。 */
export const SYMBOL_LABEL_CLEARANCE = 4;

const NARROW_CHARACTERS = "ilI1|!.,:;'` ";
const NARROW_WIDTH = 2;
/** 实测：`PEX_NT_PERST#`(13 字符) 占 64 单位 → 4.9/字符。取 5 留余量。 */
const NORMAL_WIDTH = 5;

export const estimateLabelWidth = (text: string): number =>
  [...text].reduce(
    (total, character) => total + (NARROW_CHARACTERS.includes(character) ? NARROW_WIDTH : NORMAL_WIDTH),
    0,
  );

/**
 * 源 `fontSize`（符号单位）→ Capture 的 CommentText 字号。
 * 实测源 12 对应 OrCAD 的 -9，按 0.75 折算并夹到真实库常见区间。
 * 预览、避让、写 OLB 共用这一份，避免三处各算一套。
 */
export const symbolFontHeight = (sourceHeight: number): number =>
  Math.min(Math.max(Math.round(sourceHeight * 0.75), 8), 18);

/**
 * CommentText 的横向占宽。
 *
 * 实机标定：源 height=12（→ Capture 9）的 "Configuration Strap pins"（23 字符）
 * 实际占 ≈97 单位 → 4.2 单位/字符；源 height=20（→ Capture 15）的 "PEX8748"
 * 明显更大。字宽随字号等比放大，取 0.55 这个中间比例（两处实测分别为 0.47 / 0.61）。
 */
const COMMENT_WIDTH_RATIO = 0.55;

export const estimateCommentWidth = (text: string, height: number): number =>
  Math.max(Math.round(text.length * height * COMMENT_WIDTH_RATIO), height);

export type SymbolBox = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

const normalize = (box: SymbolBox): SymbolBox => ({
  minX: Math.min(box.minX, box.maxX),
  minY: Math.min(box.minY, box.maxY),
  maxX: Math.max(box.minX, box.maxX),
  maxY: Math.max(box.minY, box.maxY),
});

export const boxesOverlap = (a: SymbolBox, b: SymbolBox, slack = 0): boolean =>
  a.minX < b.maxX - slack &&
  b.minX < a.maxX - slack &&
  a.minY < b.maxY - slack &&
  b.minY < a.maxY - slack;

/** 本体矩形（取 RECT 图元；没有 RECT 时退化为整段包围盒）。 */
export const bodyBoxOf = (section: NormalizedSymbolSection): SymbolBox => {
  const rect = section.shapes.find((shape) => shape.kind === "rect");
  if (rect === undefined || rect.kind !== "rect") {
    return normalize(section.bounds);
  }
  return normalize({ minX: rect.min.x, minY: rect.min.y, maxX: rect.max.x, maxY: rect.max.y });
};

export type PinSide = "left" | "right" | "top" | "bottom";

/** 引脚朝向：比较连接端与本体端，取位移较大的那一轴。 */
export const pinSideOf = (pin: NormalizedSymbolPin): PinSide => {
  const dx = pin.body.x - pin.connection.x;
  const dy = pin.body.y - pin.connection.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "left" : "right";
  }
  return dy >= 0 ? "top" : "bottom";
};

export const pinIsVertical = (pin: NormalizedSymbolPin): boolean => {
  const side = pinSideOf(pin);
  return side === "top" || side === "bottom";
};

/** 引脚名占位（本体内侧）。 */
export const pinNameBox = (pin: NormalizedSymbolPin, body: SymbolBox): SymbolBox => {
  const box = normalize(body);
  const width = estimateLabelWidth(pin.name);
  switch (pinSideOf(pin)) {
    case "left":
      return {
        minX: box.minX + SYMBOL_LABEL_OFFSET,
        maxX: box.minX + SYMBOL_LABEL_OFFSET + width,
        minY: pin.body.y - SYMBOL_LABEL_HALF,
        maxY: pin.body.y + SYMBOL_LABEL_HALF,
      };
    case "right":
      return {
        minX: box.maxX - SYMBOL_LABEL_OFFSET - width,
        maxX: box.maxX - SYMBOL_LABEL_OFFSET,
        minY: pin.body.y - SYMBOL_LABEL_HALF,
        maxY: pin.body.y + SYMBOL_LABEL_HALF,
      };
    case "top":
      // 竖排：从本体上边往下长
      return {
        minX: pin.body.x - SYMBOL_LABEL_HALF,
        maxX: pin.body.x + SYMBOL_LABEL_HALF,
        minY: box.minY + SYMBOL_LABEL_OFFSET,
        maxY: box.minY + SYMBOL_LABEL_OFFSET + width,
      };
    default:
      // 竖排：从本体下边往上长
      return {
        minX: pin.body.x - SYMBOL_LABEL_HALF,
        maxX: pin.body.x + SYMBOL_LABEL_HALF,
        minY: box.maxY - SYMBOL_LABEL_OFFSET - width,
        maxY: box.maxY - SYMBOL_LABEL_OFFSET,
      };
  }
};

/** 引脚号占位（本体外侧，紧贴本体边缘）。 */
export const pinNumberBox = (pin: NormalizedSymbolPin, body: SymbolBox): SymbolBox => {
  const box = normalize(body);
  const width = estimateLabelWidth(pin.number);
  switch (pinSideOf(pin)) {
    case "left":
      return {
        minX: box.minX - SYMBOL_LABEL_OFFSET - width,
        maxX: box.minX - SYMBOL_LABEL_OFFSET,
        minY: pin.body.y - SYMBOL_LABEL_HALF,
        maxY: pin.body.y + SYMBOL_LABEL_HALF,
      };
    case "right":
      return {
        minX: box.maxX + SYMBOL_LABEL_OFFSET,
        maxX: box.maxX + SYMBOL_LABEL_OFFSET + width,
        minY: pin.body.y - SYMBOL_LABEL_HALF,
        maxY: pin.body.y + SYMBOL_LABEL_HALF,
      };
    case "top":
      return {
        minX: pin.body.x - SYMBOL_LABEL_HALF,
        maxX: pin.body.x + SYMBOL_LABEL_HALF,
        minY: box.minY - SYMBOL_LABEL_OFFSET - width,
        maxY: box.minY - SYMBOL_LABEL_OFFSET,
      };
    default:
      return {
        minX: pin.body.x - SYMBOL_LABEL_HALF,
        maxX: pin.body.x + SYMBOL_LABEL_HALF,
        minY: box.maxY + SYMBOL_LABEL_OFFSET,
        maxY: box.maxY + SYMBOL_LABEL_OFFSET + width,
      };
  }
};

/**
 * 注释文字（CommentText）的占位矩形。
 *
 * 说明：Capture 把它按 `locX/locY + 字号` 排，纵向基准与 x1/x2/y1/y2 的语义
 * 没有官方文档，这里取"左上角起算、高度 = 字号"的保守近似 —— 只用来判断
 * "挪一下会不会压到引脚标签"，宁大勿小。
 */
export const commentTextBox = (shape: {
  readonly at: { readonly x: number; readonly y: number };
  readonly height: number;
  readonly text: string;
}): SymbolBox => {
  const height = symbolFontHeight(shape.height);
  return {
    minX: shape.at.x,
    minY: shape.at.y,
    maxX: shape.at.x + estimateCommentWidth(shape.text, height),
    maxY: shape.at.y + height,
  };
};

/**
 * 预览/「适应窗口」用的包围盒：在本体包围盒上并入伸到本体外面的引脚号
 * （竖排的引脚号可以比特意加长的引脚还长），否则会被裁掉。
 */
export const sectionPreviewBounds = (section: NormalizedSymbolSection): SymbolBox => {
  const body = normalize(section.bounds);
  let { minX, minY, maxX, maxY } = body;
  const rect = bodyBoxOf(section);
  for (const pin of section.pins) {
    const box = pinNumberBox(pin, rect);
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  return { minX, minY, maxX, maxY };
};
