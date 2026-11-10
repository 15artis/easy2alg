import type {
  NormalizedSymbolPin,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
} from "./schemas";
import {
  isSymbolPinKey,
  isSymbolPinLabelKey,
  parseSymbolEditKey,
  parseSymbolPinLabelKey,
  symbolPinKey,
  symbolShapeKey,
  type PinLabelKind,
} from "./symbol-edit";

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

/**
 * 符号文本的**默认/最小字号**（符号单位，1 单位 = 10 mil）。
 *
 * 源数据给不出可用字号（缺失、太小）时兜底用这个值 —— 两条链路
 * （立创在线 easyeda-symbol / 本地库 elibz2）共用，避免各写一个魔数。
 * 用户 2026-10-16 要求：7（原先在线链路写死 6）。
 */
export const DEFAULT_SYMBOL_TEXT_HEIGHT = 7;

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
 * 引脚标签的**等宽**字宽（符号单位）。
 *
 * Capture 画引脚名/脚号用的是内部 stroke 字体，数字与字母同宽，实测 height=9 时
 * 每字符约 4.5 单位。不能复用 `estimateLabelWidth`：那里把 "1" 当窄字符（宽 2），
 * 而 Capture 里 "1" 和 "7" 一样宽 —— 预览直接按浏览器字体排，一个 "MH1" 就比估算
 * 宽出 4 单位，向左压到隔壁 7 号脚的 name 上（用户 2026-11-10 报的 "7MH1" 叠字）。
 */
export const SYMBOL_PIN_CHAR_WIDTH = 4.5;

export const pinLabelWidth = (text: string): number =>
  [...text].length * SYMBOL_PIN_CHAR_WIDTH;

/**
 * 注释文本按行拆开（用户 2026-11-09 要求支持换行编辑）。
 *
 * 统一 CRLF/CR → LF；**空行保留**，行号要和用户看到的行号一致（写 OLB 时一行
 * 一条 CommentText，空行就只是一条空文本）。
 */
export const symbolTextLines = (text: string): readonly string[] =>
  text.replace(/\r\n?/g, "\n").split("\n");

/** 多行文本里最长一行的宽度（单行时与 `estimateLabelWidth` 等价）。 */
export const estimateMultilineWidth = (text: string): number =>
  symbolTextLines(text).reduce((max, line) => Math.max(max, estimateLabelWidth(line)), 0);

/**
 * 注释文本的行距（倍数，乘字号）。
 *
 * 与写库用的行高 `round(height × 1.556)` 对不齐也没关系 —— 预览按字形密度取
 * 1.25 更好看；真正影响对齐的是 `commentTextBox` 里的 1.556（Capture 的行距）。
 */
export const SYMBOL_TEXT_LINE_STEP = 1.25;

/**
 * 源 `fontSize`（符号单位）→ Capture 的 CommentText 字号。
 *
 * **不再打折**（2026-10-19，用户第三次反馈"生成的尺寸和预览有差异"）：原先按 0.75
 * 折算（源 12 → Capture 9），预览却按源字号画，于是 Capture 里每一条标注都比预览
 * 小一号。.olb 的字高和符号坐标是同一个单位（10 mil），直接用源字号才是所见即所得；
 * 手改样本也对得上：height=-9 的 "JTAG" 框高 14 = round(9×1.556)。
 *
 * 上下限只防退化（源数据缺失时兜底 8，超长标题不让它盖住整个符号）。
 */
export const symbolFontHeight = (sourceHeight: number): number =>
  Math.min(Math.max(Math.round(sourceHeight), 8), 40);

/**
 * CommentText 的横向占宽。
 *
 * 实机标定：源 height=12（→ Capture 9）的 "Configuration Strap pins"（23 字符）
 * 实际占 ≈97 单位 → 4.2 单位/字符；源 height=20（→ Capture 15）的 "PEX8748"
 * 明显更大。字宽随字号等比放大，取 0.55 这个中间比例（两处实测分别为 0.47 / 0.61）。
 */
const COMMENT_WIDTH_RATIO = 0.55;

export const estimateCommentWidth = (text: string, height: number): number => {
  // 多行文本按最长一行算宽度（用户 2026-11-09 起支持换行，不能把 \n 也算成字符）
  const longest = symbolTextLines(text).reduce((max, line) => Math.max(max, line.length), 0);
  return Math.max(Math.round(longest * height * COMMENT_WIDTH_RATIO), height);
};

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

/** 一组点的包围盒（点数组 → SymbolBox）。 */
const boxOfPoints = (points: readonly { readonly x: number; readonly y: number }[]): SymbolBox => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

export const boxesOverlap = (a: SymbolBox, b: SymbolBox, slack = 0): boolean =>
  a.minX < b.maxX - slack &&
  b.minX < a.maxX - slack &&
  a.minY < b.maxY - slack &&
  b.minY < a.maxY - slack;

/**
 * 图形包围盒：只算 RECT / 折线，**不含引脚桩**，也不算文字标注。
 *
 * 三极管、MOSFET、二极管、连接器这类符号没有矩形本体，本体就是这堆折线。
 * 若拿整段 bounds（含 10 单位引脚桩）当本体，引脚名会被摆到引脚末端、脚号跑到框外
 * —— 用户 2026-10-23 截图里的 C18221391 就是这样（预览和导出的 OLB 同时错）。
 */
const drawingBoxOf = (section: NormalizedSymbolSection): SymbolBox | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const shape of section.shapes) {
    if (shape.kind === "rect") {
      xs.push(shape.min.x, shape.max.x);
      ys.push(shape.min.y, shape.max.y);
    } else if (shape.kind === "polyline") {
      for (const point of shape.points) {
        xs.push(point.x);
        ys.push(point.y);
      }
    }
  }
  if (xs.length === 0) {
    return null;
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

/**
 * 本体包围盒：优先 RECT；没有 RECT 时用**图元包围盒**（不是整段 bounds）；
 * 连图元都没有才退到整段 bounds。
 */
export const bodyBoxOf = (section: NormalizedSymbolSection): SymbolBox => {
  const rect = bodyRectOf(section);
  if (rect !== undefined) {
    return normalize({ minX: rect.min.x, minY: rect.min.y, maxX: rect.max.x, maxY: rect.max.y });
  }
  return normalize(drawingBoxOf(section) ?? section.bounds);
};

/** 判定「引脚本体端压在这只矩形的边上」的容差（源数据有 .5 抖动与浮点误差）。 */
export const SYMBOL_BODY_EDGE_TOLERANCE = 1;

/**
 * 本体矩形：一只 RECT 就是它；多只时挑**引脚本体端压在上面最多**的那只。
 *
 * 立创把装饰图形也画成 `R`（SMA-KWE 的接头外壳就是第二只矩形），
 * `find(rect)` 拿到的不一定是本体 —— 全库抽查里 SMA-KWE 恰好本体在前，
 * 但顺序不能靠运气。见 `keepSingleBodyRect`（只有本体保留 RECT，其余转线段）。
 */
export const bodyRectOf = (
  section: NormalizedSymbolSection,
): Extract<NormalizedSymbolShape, { kind: "rect" }> | undefined => {
  const rects = section.shapes.filter(
    (shape): shape is Extract<NormalizedSymbolShape, { kind: "rect" }> => shape.kind === "rect",
  );
  if (rects.length <= 1) {
    return rects[0];
  }
  let best = rects[0];
  let bestCount = -1;
  for (const rect of rects) {
    const count = section.pins.filter((pin) => pinBodyOnRect(pin, rect)).length;
    if (count > bestCount) {
      best = rect;
      bestCount = count;
    }
  }
  return best;
};

/** 引脚的本体端是不是压在这只矩形的四条边上。 */
const pinBodyOnRect = (
  pin: NormalizedSymbolPin,
  rect: Extract<NormalizedSymbolShape, { kind: "rect" }>,
): boolean => {
  const minX = Math.min(rect.min.x, rect.max.x);
  const maxX = Math.max(rect.min.x, rect.max.x);
  const minY = Math.min(rect.min.y, rect.max.y);
  const maxY = Math.max(rect.min.y, rect.max.y);
  const tolerance = SYMBOL_BODY_EDGE_TOLERANCE;
  const nearX =
    Math.abs(pin.body.x - minX) <= tolerance || Math.abs(pin.body.x - maxX) <= tolerance;
  const nearY =
    Math.abs(pin.body.y - minY) <= tolerance || Math.abs(pin.body.y - maxY) <= tolerance;
  const insideX = pin.body.x >= minX - tolerance && pin.body.x <= maxX + tolerance;
  const insideY = pin.body.y >= minY - tolerance && pin.body.y <= maxY + tolerance;
  return (nearX && insideY) || (nearY && insideX);
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
  const width = pinLabelWidth(pin.name);
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
export const pinNumberBox = (pin: NormalizedSymbolPin, body: SymbolBox): SymbolBox => {  const box = normalize(body);
  const width = pinLabelWidth(pin.number);
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

/** 预览里引脚名/脚号用的字号（世界单位）。Capture 两侧同为 height≈9。 */
export const SYMBOL_PIN_FONT = 9;

/**
 * 这个标签要不要画。
 *
 * EasyEDA 的符号里 name 与 number 常常就是同一个值（DSUB、排针、端子几乎都是
 * "1~9" 对 "1~9"）。Capture 会把 name 画在本体内侧、number 画在引脚上方，
 * 于是每个脚看上去写了两遍同样的数字，本体窄的时候内侧的 name 还会撞上隔壁
 * 引脚（DMR-9S 的 MH1 压在 7 上）。
 *
 * 约定：两者相同时只留 **name**。理由是从 OLB 侧倒推出来的 ——
 * `SymbolPinScalar` 只有一个 `name` 字符串，没有独立脚号字段；name 写空会被
 * Capture 换成 `$PIN0`。真正能逐脚关掉的只有 `IsNumberVisible`。
 */
export const pinLabelVisible = (pin: NormalizedSymbolPin, kind: PinLabelKind): boolean => {
  if (pin.name.trim() === "") {
    return kind === "number";
  }
  return kind === "name" || pin.name.trim() !== pin.number.trim();
};

/**
 * 整段的引脚名要不要让位给脚号。
 *
 * 依据（2026-11-10 用户第二次报障的复盘）：`IsNumberVisible` 是**逐脚**开关，
 * 在这台 Capture 上写了 0 也照旧画脚号 → 每个脚都画两遍（name 在本体内侧沿引脚
 * 竖排、number 贴在引脚旁）。真正有效的是**整段**的 `<IsPinNamesVisible>`。
 *
 * 何时可以关：所有脚的 name 都等于自己的 number（排针、端子、DSUB、二极管这类
 * 立创符号几乎都是 "1~9" 对 "1~9"）—— 名字里没有额外信息，关掉只留脚号。
 * 名字带语义的（GND / VCC / GPIO7）一律保留。
 */
export const pinNamesSuppressed = (section: NormalizedSymbolSection): boolean =>
  section.pins.length > 0 &&
  section.pins.every((pin) => {
    const name = pin.name.trim();
    return name !== "" && name === pin.number.trim();
  });

/**
 * 某个标签最终画不画 —— 只认这一处，预览 / 命中盒 / 框选共用。
 *
 * 与写库的 `<IsPinNamesVisible>` 严格对应：被整段关掉名字时，改用脚号顶上
 * （两者的文字本来就相同），保证「预览画几条 = Capture 画几条」。
 */
export const pinLabelShown = (
  section: NormalizedSymbolSection,
  pinIndex: number,
  kind: PinLabelKind,
): boolean => {
  const pin = section.pins[pinIndex];
  if (pin === undefined) {
    return false;
  }
  if (!pinNamesSuppressed(section)) {
    return pinLabelVisible(pin, kind);
  }
  return kind === "number" && pin.number.trim() !== "";
};

/**
 * 引脚标签的绘制锚点 / 书写方向 —— **预览与命中盒的唯一来源**。
 *
 * 与 `SymbolPreview` 里的 `placeLabel` 完全一致（原来各写一份，加独立标签后
 * 命中盒必须跟着锚点走，否则挪过的标签点不到）。
 * 上下引脚竖排（rotate -90、从锚点向上长）。
 */
export const pinLabelPlacement = (
  pin: NormalizedSymbolPin,
  kind: PinLabelKind,
  body: SymbolBox,
): { readonly x: number; readonly y: number; readonly rotate: number; readonly anchor: "start" | "end" } => {
  const anchor = pin.labelAnchor?.[kind];
  const box = kind === "name" ? pinNameBox(pin, body) : pinNumberBox(pin, body);
  switch (pinSideOf(pin)) {
    case "left":
      return { x: anchor?.x ?? box.minX, y: anchor?.y ?? pin.body.y, rotate: 0, anchor: "start" };
    case "right":
      return { x: anchor?.x ?? box.maxX, y: anchor?.y ?? pin.body.y, rotate: 0, anchor: "end" };
    default:
      return { x: anchor?.x ?? pin.body.x, y: anchor?.y ?? box.maxY, rotate: -90, anchor: "start" };
  }
};

/**
 * 引脚标签的占位盒（命中区 / 框选 / 属性面板共用）。
 *
 * 基线在 `y`、字形向上长（与 `<text>` 不设 dominant-baseline 的默认行为一致），
 * 所以纵向范围取 `y - 0.75·字号 … y + 0.25·字号`；竖排时宽高互换、沿 y 负方向铺开。
 */
export const pinLabelBoxOf = (
  pin: NormalizedSymbolPin,
  kind: PinLabelKind,
  body: SymbolBox,
): SymbolBox => {
  const placement = pinLabelPlacement(pin, kind, body);
  const width = pinLabelWidth(kind === "name" ? pin.name : pin.number);
  if (placement.rotate === 0) {
    const baseline = SYMBOL_PIN_FONT * 0.25;
    return {
      minX: placement.anchor === "end" ? placement.x - width : placement.x,
      maxX: placement.anchor === "end" ? placement.x : placement.x + width,
      minY: placement.y - (SYMBOL_PIN_FONT - baseline),
      maxY: placement.y + baseline,
    };
  }
  const half = SYMBOL_PIN_FONT / 2;
  return {
    minX: placement.x - half,
    maxX: placement.x + half,
    minY: placement.y - width,
    maxY: placement.y,
  };
};

/**
 * 段内引脚标签（名字 / 脚号）是否互相压住。
 *
 * 用途：Capture 的引脚字号固定 9 单位、不随符号大小变；本体只有 20 单位高的
 * 三极管/MOSFET，名字从上下两边往中间长，必然撞在一起。解析阶段据此决定
 * 要不要把整段放大（见 easyeda-symbol.ts 的 buildSection）。
 */
export const sectionLabelsCollide = (section: NormalizedSymbolSection): boolean => {
  const body = bodyBoxOf(section);
  const boxes = section.pins.flatMap((pin, index) => [
    ...(pinLabelShown(section, index, "name") ? [pinNameBox(pin, body)] : []),
    ...(pinLabelShown(section, index, "number") ? [pinNumberBox(pin, body)] : []),
  ]);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxesOverlap(boxes[i], boxes[j])) {
        return true;
      }
    }
  }
  return false;
};

/** 引脚文字锚点：名字/编号各一个定位点（预览的 `placeLabel` 用）。 */
export type PinLabelAnchor = {
  readonly name: { readonly x: number; readonly y: number };
  readonly number: { readonly x: number; readonly y: number };
};

/**
 * 从当前本体盒推导出这个引脚两个文字的定位点。
 *
 * 与预览的 `placeLabel` 一一对应（左/右引脚取名字盒的内侧边，上下引脚取名字盒的外端、
 * x 用引脚自己的 x）；解析时调用一次后**冻结**到引脚上（见 schemas 里的 labelAnchor）。
 */
export const pinLabelAnchors = (pin: NormalizedSymbolPin, body: SymbolBox): PinLabelAnchor => {
  const nameBox = pinNameBox(pin, body);
  const numberBox = pinNumberBox(pin, body);
  switch (pinSideOf(pin)) {
    case "left":
      return {
        name: { x: nameBox.minX, y: pin.body.y },
        number: { x: numberBox.maxX, y: pin.body.y },
      };
    case "right":
      return {
        name: { x: nameBox.maxX, y: pin.body.y },
        number: { x: numberBox.minX, y: pin.body.y },
      };
    default:
      return {
        name: { x: pin.body.x, y: nameBox.maxY },
        number: { x: pin.body.x, y: numberBox.maxY },
      };
  }
};

/**
 * 把锚点冻结到段里每个引脚上。放在**去重与避让之后**调用：避让会挪引脚/加宽本体，
 * 锚点必须反映最终几何。
 */
export const attachPinLabelAnchors = (
  section: NormalizedSymbolSection,
): NormalizedSymbolSection => {
  const body = bodyBoxOf(section);
  return {
    ...section,
    pins: section.pins.map((pin) => ({ ...pin, labelAnchor: pinLabelAnchors(pin, body) })),
  };
};

/**
 * 文字锚点 → 占位盒（框选命中用）。
 *
 * `endAnchored` = 文字从锚点往左延伸（右侧引脚的名字、左侧引脚的脚号），
 * 竖排（rotated）= 往上方延伸。宽度按 `pinLabelWidth`、高度按 `SYMBOL_PIN_FONT`。
 * 与预览画出来的东西对齐，不要求像素级精确 —— 框选碰到就算选中。
 */
export const anchorLabelBox = (
  anchor: { readonly x: number; readonly y: number },
  text: string,
  rotated: boolean,
  endAnchored: boolean,
): SymbolBox => {
  const width = pinLabelWidth(text);
  const half = SYMBOL_PIN_FONT / 2;
  if (rotated) {
    return { minX: anchor.x - half, maxX: anchor.x + half, minY: anchor.y - width, maxY: anchor.y };
  }
  const baseline = SYMBOL_PIN_FONT * 0.25;
  return {
    minX: endAnchored ? anchor.x - width : anchor.x,
    maxX: endAnchored ? anchor.x : anchor.x + width,
    minY: anchor.y - (SYMBOL_PIN_FONT - baseline),
    maxY: anchor.y + baseline,
  };
};

/**
 * 注释文字（CommentText）的占位矩形。
 *
 * 说明：Capture 把它按 `locX/locY + 字号` 排，纵向基准与 x1/x2/y1/y2 的语义
 * 没有官方文档，这里取"左上角起算、高度 = 字号"的保守近似 —— 只用来判断
 * "挪一下会不会压到引脚标签"，宁大勿小。
 */
/**
 * CommentText 的占位盒（含旋转）。
 *
 * 竖排（rotation 90/270）时**不能按横排算** —— 宽 = 字高、高 = 文本长度，否则
 * 避让会拿一条横着扫过去的长条去判冲突（实测会误报"Hot Plug/Multfunction pins
 * 压在引脚名上"）。锚点约定与写库一致：`at` 是文字起点，框沿阅读方向铺开。
 */
export const commentTextBox = (shape: {
  readonly at: { readonly x: number; readonly y: number };
  readonly height: number;
  readonly text: string;
  readonly rotation?: number;
}): SymbolBox => {
  const height = symbolFontHeight(shape.height);
  const width = estimateCommentWidth(shape.text, height);
  const quarter = Math.round((shape.rotation ?? 0) / 90) % 4;
  /**
   * 多行文本沿"阅读方向的垂直方向"叠行（用户 2026-11-09）。Capture 里一行占
   * `round(height × 1.556)`，与写入 OLB 时逐行下移的步长保持同一份口径。
   */
  const lineStep = Math.round(height * 1.556);
  const lines = symbolTextLines(shape.text).length;
  const depth = height + lineStep * (lines - 1);
  if (quarter === 1 || quarter === 3) {
    // 90°：文字自下而上，框向上铺；270°：自上而下，框向下铺
    return quarter === 1
      ? { minX: shape.at.x, maxX: shape.at.x + depth, minY: shape.at.y - width, maxY: shape.at.y }
      : { minX: shape.at.x, maxX: shape.at.x + depth, minY: shape.at.y, maxY: shape.at.y + width };
  }
  return {
    minX: shape.at.x,
    minY: shape.at.y,
    maxX: shape.at.x + width,
    maxY: shape.at.y + depth,
  };
};

/**
 * 预览/「适应窗口」用的包围盒：在本体包围盒上并入伸到本体外面的引脚号
 * （竖排的引脚号可以比特意加长的引脚还长），否则会被裁掉。
 */
export const sectionPreviewBounds = (section: NormalizedSymbolSection): SymbolBox => {
  const body = normalize(section.bounds);
  let { minX, minY, maxX, maxY } = body;
  // 图元（本体被拖大、折线/文字被拖出界）也要并进来 —— 只取 section.bounds 是
  // 解析阶段的静态值，"缩放到选中/适应窗口"会把编辑后的内容裁掉（用户 2026-10-20）。
  section.shapes.forEach((_shape, index) => {
    const box = symbolElementBox(section, symbolShapeKey(0, index));
    if (box === null) {
      return;
    }
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  });
  const rect = bodyBoxOf(section);
  for (const pin of section.pins) {
    const box = pinNumberBox(pin, rect);
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
    // 引脚线本身也要算（尤其是被拖到本体外的引脚）
    minX = Math.min(minX, pin.connection.x, pin.body.x);
    minY = Math.min(minY, pin.connection.y, pin.body.y);
    maxX = Math.max(maxX, pin.connection.x, pin.body.x);
    maxY = Math.max(maxY, pin.connection.y, pin.body.y);
  }
  return { minX, minY, maxX, maxY };
};

/** 一组编辑键的并集包围盒（"缩放到选中"用）；没有可命中的元素返回 null。 */
export const selectionBox = (
  section: NormalizedSymbolSection,
  keys: readonly string[],
): SymbolBox | null => {
  let result: SymbolBox | null = null;
  for (const key of keys) {
    const box = symbolElementBox(section, key);
    if (box === null) {
      continue;
    }
    result =
      result === null
        ? box
        : {
            minX: Math.min(result.minX, box.minX),
            minY: Math.min(result.minY, box.minY),
            maxX: Math.max(result.maxX, box.maxX),
            maxY: Math.max(result.maxY, box.maxY),
          };
  }
  return result;
};

/**
 * 一个可编辑元素在符号里的**近似占位盒** —— 框选（橡皮筋选择）用它命中判断。
 *
 * 与预览画出来的东西一一对应：
 *  - rect      → 本体四边；
 *  - polyline  → 折线各点的包围盒；
 *  - text      → `commentTextBox`（与写库同一份模型）；
 *  - 引脚      → 引脚线 + 名字盒 + 号盒三者并集。
 *
 * 用近似盒而不是精确几何：框选本来就允许"框到就算选中"，
 * 而对带透明命中区的元素（引脚/文字）近似盒反而更符合手感。
 */
export const symbolElementBox = (
  section: NormalizedSymbolSection,
  key: string,
): SymbolBox | null => {
  // 单个引脚标签（用户 2026-11-10）：盒跟着锚点走，挪到哪就命中到哪
  if (isSymbolPinLabelKey(key)) {
    const parsed = parseSymbolPinLabelKey(key);
    const labelPin = parsed === null ? undefined : section.pins[parsed.pinIndex];
    if (parsed === null || labelPin === undefined || !pinLabelShown(section, parsed.pinIndex, parsed.kind)) {
      return null;
    }
    return pinLabelBoxOf(labelPin, parsed.kind, bodyBoxOf(section));
  }
  const { index } = parseSymbolEditKey(key);
  if (isSymbolPinKey(key)) {
    const pin = section.pins[index];
    if (pin === undefined) {
      return null;
    }
    const side = pinSideOf(pin);
    const rotated = side === "top" || side === "bottom";
    const anchored = pin.labelAnchor;
    const boxOf = (kind: PinLabelKind): SymbolBox => {
      if (anchored !== undefined) {
        // 有冻结锚点就按锚点算（跟屏幕上看到的一致）
        return kind === "name"
          ? anchorLabelBox(anchored.name, pin.name, rotated, side === "right")
          : anchorLabelBox(anchored.number, pin.number, rotated, side === "left");
      }
      // 老数据没有锚点：退化到本体盒推导
      const body = bodyBoxOf(section);
      return kind === "name" ? pinNameBox(pin, body) : pinNumberBox(pin, body);
    };
    // 不画的标签不进盒 —— 否则点本体内部空白会选中看不见的引脚名。
    const labelBoxes = (["name", "number"] as const)
      .filter((kind) => pinLabelShown(section, index, kind))
      .map(boxOf);
    return [...labelBoxes, boxOfPoints([pin.connection, pin.body])].reduce(
      (acc, box) => ({
        minX: Math.min(acc.minX, box.minX),
        minY: Math.min(acc.minY, box.minY),
        maxX: Math.max(acc.maxX, box.maxX),
        maxY: Math.max(acc.maxY, box.maxY),
      }),
    );
  }
  const shape = section.shapes[index];
  if (shape === undefined) {
    return null;
  }
  switch (shape.kind) {
    case "rect":
      return normalize({ minX: shape.min.x, minY: shape.min.y, maxX: shape.max.x, maxY: shape.max.y });
    case "polyline":
      return boxOfPoints(shape.points);
    default:
      // 已删除（隐藏）的文本不参与框选/命中
      if (shape.hidden === true) {
        return null;
      }
      // 文字用**预览画出来的占位**（基线在 at.y，字形向上长），而不是写库模型的
      // commentTextBox（基线向下）—— 框选要跟着眼睛看到的走，两者差整整一个字高。
      // 多行时按最长一行取宽、按行数往下加高（用户 2026-11-09）。
      return normalize({
        minX: shape.at.x,
        minY: shape.at.y - shape.height,
        maxX: shape.at.x + estimateMultilineWidth(shape.text) * (shape.height / 9) * 1.15,
        maxY:
          shape.at.y +
          shape.height * 0.25 +
          shape.height * SYMBOL_TEXT_LINE_STEP * (symbolTextLines(shape.text).length - 1),
      });
  }
};

/** 两个盒是否相交（框选命中判据：碰到就算选中）。 */
export const boxesIntersect = (a: SymbolBox, b: SymbolBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/**
 * 框选：返回本段里落在 `box` 内的所有元素键（图形 + 引脚）。
 * 键要带上真实的段序号，才能直接喂给选中态与编辑记录。
 */
/**
 * 框选（橡皮筋）命中：返回与 `box` 相交的所有元素键。
 *
 * **本体框（rect）不参与框选** —— 用户 2026-10-19 反馈："框选引脚和引脚标签，
 * 结果本体也被带上、拖动时多出一堆东西跟着动"。框的包围盒覆盖整个符号，
 * 无论按"碰到就算"还是"越过描边"，只要框选贴着边缘就会把本体捎上，手感不可预测。
 * 所以：框选只选**内容**（引脚 / 文字 / 分隔线），本体框要用鼠标点它的线来选中
 * （选中后可用方向键移动，拖它的线则是改大小）。
 */
export const symbolKeysInBox = (
  section: NormalizedSymbolSection,
  sectionIndex: number,
  box: SymbolBox,
): readonly string[] => {
  const keys: string[] = [];
  section.shapes.forEach((shape, index) => {
    if (shape.kind === "rect") {
      return;
    }
    const key = symbolShapeKey(sectionIndex, index);
    const element = symbolElementBox(section, key);
    if (element !== null && boxesIntersect(element, box)) {
      keys.push(key);
    }
  });
  section.pins.forEach((_pin, index) => {
    const element = symbolElementBox(section, symbolPinKey(sectionIndex, index));
    if (element !== null && boxesIntersect(element, box)) {
      keys.push(symbolPinKey(sectionIndex, index));
    }
  });
  return keys;
};

/**
 * 全选（Ctrl+A）的键集合 —— **语义与框选一致**：所有引脚 + 非 rect 图形。
 *
 * 本体（rect）不参与：它的包围盒覆盖整个符号，一旦进选择集，"整体移动"就会把
 * 整个符号挪走（0.1.27 的框选也是同样取舍）。
 */
export const symbolSelectableKeys = (
  section: NormalizedSymbolSection,
  sectionIndex: number,
): readonly string[] => [
  ...section.shapes.flatMap((shape, index) =>
    shape.kind === "rect" ? [] : [symbolShapeKey(sectionIndex, index)],
  ),
  ...section.pins.map((_pin, index) => symbolPinKey(sectionIndex, index)),
];
