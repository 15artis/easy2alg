import type {
  NormalizedSymbol,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
  Point,
  SymbolPinType,
  SymbolShapePrimitive,
} from "./schemas";

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

/**
 * 平移（可选等比缩放）折线背后的原生曲线图元。
 *
 * 折线同时带着 `points` 与 `primitive`，任何移动都必须**两边一起动** ——
 * 只改 points 的话，写库时仍按旧参数的椭圆出图，位置就对不上了。
 * 缩放只来自解析阶段"整段放大"（比例是均匀的正整数），角度不变。
 */
export const transformSymbolPrimitive = (
  primitive: SymbolShapePrimitive,
  dx: number,
  dy: number,
  scale = 1,
): SymbolShapePrimitive => ({
  ...primitive,
  center: { x: (primitive.center.x + dx) * scale, y: (primitive.center.y + dy) * scale },
  rx: primitive.rx * scale,
  ry: primitive.ry * scale,
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
        primitive:
          shape.primitive === undefined
            ? undefined
            : transformSymbolPrimitive(shape.primitive, dx, dy),
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

/**
 * 引脚标签（名 / 脚号）的**独立**编辑键：`t<段序号>:<引脚序号>:<name|number>`。
 *
 * 用户 2026-11-10 要求「单击引脚标签时不要和引脚一起激活，文本要能单独移动」。
 * 标签不再只是引脚的附属高亮项 —— 它有独立的选中态与位移，拖动它不会带动引脚线。
 * 前缀用 `t` 是为了不落进 `isSymbolPinKey`（`p`）的判定，否则会被当成整条引脚。
 */
export type PinLabelKind = "name" | "number";

export const symbolPinLabelKey = (
  sectionIndex: number,
  pinIndex: number,
  kind: PinLabelKind,
): string => `t${sectionIndex}:${pinIndex}:${kind}`;

export const isSymbolPinLabelKey = (key: string): boolean => key.startsWith("t");

export const parseSymbolPinLabelKey = (
  key: string,
): { readonly section: number; readonly pinIndex: number; readonly kind: PinLabelKind } | null => {
  if (!isSymbolPinLabelKey(key)) {
    return null;
  }
  const [section, pinIndex, kind] = key.slice(1).split(":");
  const kindValue = kind === "name" || kind === "number" ? kind : null;
  if (kindValue === null) {
    return null;
  }
  return { section: Number(section), pinIndex: Number(pinIndex), kind: kindValue };
};

/**
 * 把编辑键拆回 (段序号, 元素序号)。
 * 标签键的"元素序号"就是**它所属引脚**的序号 —— 属性面板、命中盒都按引脚取。
 */
export const parseSymbolEditKey = (key: string): { readonly section: number; readonly index: number } => {
  const label = parseSymbolPinLabelKey(key);
  if (label !== null) {
    return { section: label.section, index: label.pinIndex };
  }
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
  /**
   * 只挪引脚标签（名/脚号），**引脚本体留在边框上**（用户 2026-10-22）。
   * 对齐/分布用在引脚上时走这里 —— 直接挪引脚会让它离开边框。
   */
  readonly labelShift?: { readonly dx: number; readonly dy: number };
  /**
   * 描边样式（用户 2026-11-11）：Capture 的 Line Width / Line Style 枚举。
   * 只用于 rect / polyline；文本忽略。
   */
  readonly lineWidth?: number;
  readonly lineStyle?: number;
  /** 文本粗体 / 斜体（写 TextFont 的 weight / italic） */
  readonly bold?: boolean;
  readonly italic?: boolean;
  /**
   * 圆半径（绝对，世界单位）。只对"用户画的圆"有效 —— 它同时有采样点与
   * `primitive.type === "ellipse"`，改半径必须两边一起改，否则写库仍按旧半径出图。
   */
  readonly radius?: number;
  /**
   * 线段两端（绝对坐标）。只对**无 primitive** 的两点折线有效：
   * 圆弧/椭圆是多点采样，单独挪首末点会把曲线拉歪，那种情况请改半径或整体平移。
   */
  readonly endpoints?: {
    readonly from: { readonly x: number; readonly y: number };
    readonly to: { readonly x: number; readonly y: number };
  };
  /** 引脚电气类型（Capture 的 Pin Type 下拉） */
  readonly pinType?: SymbolPinType;
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
  edit.hidden !== true &&
  (edit.labelShift === undefined || (edit.labelShift.dx === 0 && edit.labelShift.dy === 0)) &&
  edit.lineWidth === undefined &&
  edit.lineStyle === undefined &&
  edit.bold === undefined &&
  edit.italic === undefined &&
  edit.radius === undefined &&
  edit.endpoints === undefined &&
  edit.pinType === undefined;

/** 写入一个键的编辑；整条变成默认值就把键删掉（避免留下一堆空记录）。 */
const putEdit = (edits: SymbolEdits, key: string, edit: SymbolEdit): SymbolEdits => {
  if (isDefaultEdit(edit)) {
    const { [key]: _removed, ...rest } = edits;
    return rest;
  }
  return { ...edits, [key]: edit };
};

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.round(value), min), max);

/**
 * 描边样式（用户 2026-11-11）。只对图形生效，文本忽略 —— CommentText 没有线宽概念。
 * 取值是 Capture 的枚举而不是 mil：0/1/2/3 档与 0..5 线型，写库原样透传。
 */
const withStroke = (
  shape: NormalizedSymbolShape,
  edit: SymbolEdit | undefined,
): NormalizedSymbolShape => {
  if (shape.kind === "text" || edit === undefined) {
    return shape;
  }
  if (edit.lineWidth === undefined && edit.lineStyle === undefined) {
    return shape;
  }
  return {
    ...shape,
    lineWidth: edit.lineWidth === undefined ? shape.lineWidth : clampInt(edit.lineWidth, 0, 3),
    lineStyle: edit.lineStyle === undefined ? shape.lineStyle : clampInt(edit.lineStyle, 0, 5),
  };
};

/**
 * 圆的半径（用户 2026-11-11）：`points` 是采样近似、`primitive` 才是写库依据，
 * **必须两边一起改** —— 只改 points 的话写库仍按旧半径出 `<Ellipse>`，
 * 表现是"预览放大了、Capture 里没变"。
 */
const withRadius = (
  shape: NormalizedSymbolShape,
  edit: SymbolEdit | undefined,
): NormalizedSymbolShape => {
  if (edit?.radius === undefined || !(edit.radius > 0)) {
    return shape;
  }
  if (shape.kind !== "polyline" || shape.primitive?.type !== "ellipse") {
    return shape;
  }
  const center = shape.primitive.center;
  return {
    ...shape,
    primitive: { type: "ellipse", center, rx: edit.radius, ry: edit.radius },
    points: circlePoints(center, edit.radius),
  };
};

/**
 * 线段两端（用户 2026-11-11）。只接受两点直线：圆弧/椭圆是多点采样，
 * 单独挪首末点会把曲线拉歪 —— 那种图元的面板不给端点输入。
 */
const withEndpoints = (
  shape: NormalizedSymbolShape,
  edit: SymbolEdit | undefined,
): NormalizedSymbolShape => {
  if (edit?.endpoints === undefined) {
    return shape;
  }
  if (shape.kind !== "polyline" || shape.primitive !== undefined || shape.points.length !== 2) {
    return shape;
  }
  return { ...shape, points: [edit.endpoints.from, edit.endpoints.to] };
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
  /** `段:引脚` → 该引脚两个标签各自的独立位移（用户 2026-11-10） */
  const labelEdits = new Map<string, { name?: SymbolShapeOffset; number?: SymbolShapeOffset }>();
  for (const key of keys) {
    const edit = edits[key];
    if (isSymbolPinLabelKey(key)) {
      const parsed = parseSymbolPinLabelKey(key);
      const offset = edit.offset;
      if (parsed === null || offset === undefined || (offset.dx === 0 && offset.dy === 0)) {
        continue;
      }
      const bucketKey = `${parsed.section}:${parsed.pinIndex}`;
      const bucket = labelEdits.get(bucketKey) ?? {};
      labelEdits.set(bucketKey, { ...bucket, [parsed.kind]: offset });
      continue;
    }
    (isSymbolPinKey(key) ? pinEdits : shapeEdits).set(key, edit);
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
        /**
         * ③ 软删除（用户 2026-11-11：手画的图形也要能删）。对**所有**图形生效：
         * 保留下标（编辑键是段内下标），只是不画、不写库。
         */
        if (edit?.hidden === true) {
          next = { ...next, hidden: true };
        }
        // ④ 描边样式（线宽/线型）与"用户图元"的几何（圆半径、线段端点）
        next = withStroke(next, edit);
        next = withRadius(next, edit);
        next = withEndpoints(next, edit);
        if (next.kind !== "text") {
          return next;
        }
        // ⑤ 文本字形：粗体 / 斜体（写 TextFont 的 weight / italic）
        if (edit?.bold !== undefined) {
          next = { ...next, bold: edit.bold };
        }
        if (edit?.italic !== undefined) {
          next = { ...next, italic: edit.italic };
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
        // ①-b 电气类型（属性面板的「引脚类型」下拉，写库映射成 Capture 的 Pin Type 码）
        if (edit?.pinType !== undefined) {
          next = { ...next, type: edit.pinType };
        }
        // ② 重定向：两点是绝对坐标，直接覆盖；标签锚点作废（换边后旧锚点全错），
        //    让预览回退到"按新边重新推导"。
        if (edit?.points !== undefined) {
          next = {
            ...next,
            connection: edit.points.connection,
            body: edit.points.body,
            labelAnchor: edit.points.labelAnchor,
          };
        }
        // ③ 整体平移。引脚文字锚点必须跟引脚一起平移，否则"拖引脚时标签不动、拖本体时标签乱跑"
        // （用户 2026-10-19 反馈的"标签与引脚分离/间距越拖越宽"）。
        if (edit?.offset !== undefined && (edit.offset.dx !== 0 || edit.offset.dy !== 0)) {
          const anchor = next.labelAnchor;
          next = {
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
        }
        // ④ 只挪标签：对齐/分布用在引脚上时走这里，引脚本体留在边框上
        if (
          edit?.labelShift !== undefined &&
          (edit.labelShift.dx !== 0 || edit.labelShift.dy !== 0) &&
          next.labelAnchor !== undefined
        ) {
          const anchor = next.labelAnchor;
          next = {
            ...next,
            labelAnchor: {
              name: translateSymbolPoint(anchor.name, edit.labelShift.dx, edit.labelShift.dy),
              number: translateSymbolPoint(anchor.number, edit.labelShift.dx, edit.labelShift.dy),
            },
          };
        }
        // ⑤ 单个标签的独立位移（用户 2026-11-10）：名字与脚号各挪各的，引脚线不动。
        //    放在 labelShift 之后 —— "整条引脚对齐"与"某个标签微调"可以叠加。
        const labelOffset = labelEdits.get(`${sectionIndex}:${pinIndex}`);
        if (labelOffset !== undefined && next.labelAnchor !== undefined) {
          const anchor = next.labelAnchor;
          const nameShift = labelOffset.name;
          const numberShift = labelOffset.number;
          next = {
            ...next,
            labelAnchor: {
              name:
                nameShift === undefined
                  ? anchor.name
                  : translateSymbolPoint(anchor.name, nameShift.dx, nameShift.dy),
              number:
                numberShift === undefined
                  ? anchor.number
                  : translateSymbolPoint(anchor.number, numberShift.dx, numberShift.dy),
            },
          };
        }
        return next;
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
  readonly kind: "text";
  readonly id: string;
  /** 放进哪一段 */
  readonly section: number;
  readonly text: string;
  readonly at: { readonly x: number; readonly y: number };
  readonly height: number;
  /** 源文本被复制过来时保留旋转（用户 2026-11-11：复制粘贴要原样复制） */
  readonly rotation?: number;
};

/** 用户新画的图形（用户 2026-11-11：支持线段 / 圆 / 矩形任意画线）。 */
export type AddedShapeKind = "line" | "rect" | "circle";

/** 画布上的绘图工具（工具栏按钮与预览的绘制层共用）。 */
export type SymbolDrawTool = AddedShapeKind;

/**
 * 新画的图形。
 *
 * 三种图形共用 `from` / `to` 两个点，语义按 `kind` 解释：
 *  - `line`   两端点；
 *  - `rect`   一对对角（哪两个角都行，展开时归一化）；
 *  - `circle` `from` = 圆心、`to` = 圆上一点（半径 = 两点距离），
 *             这样"拖动鼠标画圆"的手感和 Capture 一致，缩放时也不会丢圆心。
 */
export type AddedShape = {
  readonly kind: AddedShapeKind;
  readonly id: string;
  readonly section: number;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  /** 矩形的圆角半径（世界单位），省略 = 直角 */
  readonly cornerRadius?: number;
};

/**
 * 用户新增的一件东西（文本或图形）。
 *
 * **必须放在同一个数组里按加入顺序追加**：编辑键是"段内下标"，
 * 文本和图形分成两个数组各追加在末尾的话，先加文本再加图形会把文本的下标顶掉，
 * 之前所有针对它的位移/改字全落到别的元素上。
 */
export type AddedSymbolItem = AddedTextShape | AddedShape;

/** 圆的采样段数：写库走原生 `<Ellipse>`，采样点只给预览/框选做近似。 */
const CIRCLE_SEGMENTS = 64;

const circlePoints = (
  center: { readonly x: number; readonly y: number },
  radius: number,
): { readonly x: number; readonly y: number }[] =>
  Array.from({ length: CIRCLE_SEGMENTS }, (_unused, index) => {
    const angle = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    };
  });

/**
 * 画图时按住 Shift 的约束（OrCAD 手感）：线段锁水平/竖直/45°，矩形锁正方形。
 * 圆不受影响（半径本来就只有一个自由度）。
 */
export const constrainDrawPoint = (
  kind: AddedShapeKind,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  shift: boolean,
): { readonly x: number; readonly y: number } => {
  if (!shift) {
    return to;
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (kind === "line") {
    if (Math.abs(dx) >= Math.abs(dy) * 2) {
      return { x: to.x, y: from.y };
    }
    if (Math.abs(dy) >= Math.abs(dx) * 2) {
      return { x: from.x, y: to.y };
    }
    const size = (Math.abs(dx) + Math.abs(dy)) / 2;
    return {
      x: from.x + Math.sign(dx) * size,
      y: from.y + Math.sign(dy) * size,
    };
  }
  if (kind === "rect") {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: from.x + (dx === 0 ? 0 : Math.sign(dx) * size),
      y: from.y + (dy === 0 ? 0 : Math.sign(dy) * size),
    };
  }
  return to;
};

/** 把一件"用户新增"展开成写库/预览用的普通图形。 */
export const addedItemToShape = (item: AddedSymbolItem): NormalizedSymbolShape => {
  if (item.kind === "text") {
    return {
      kind: "text",
      text: item.text,
      at: item.at,
      rotation: item.rotation ?? 0,
      height: item.height,
      added: true,
    };
  }
  if (item.kind === "line") {
    return {
      kind: "polyline",
      points: [item.from, item.to],
      closed: false,
      added: true,
    };
  }
  if (item.kind === "rect") {
    return {
      kind: "rect",
      min: { x: Math.min(item.from.x, item.to.x), y: Math.min(item.from.y, item.to.y) },
      max: { x: Math.max(item.from.x, item.to.x), y: Math.max(item.from.y, item.to.y) },
      cornerRadius: item.cornerRadius ?? 0,
      filled: false,
      added: true,
    };
  }
  const radius = Math.hypot(item.to.x - item.from.x, item.to.y - item.from.y);
  return {
    kind: "polyline",
    points: circlePoints(item.from, radius),
    closed: true,
    // 写库时靠这份参数出真正的 <Ellipse>（圆取值近似会让小圆变成八边形）
    primitive: { type: "ellipse", center: item.from, rx: radius, ry: radius },
    added: true,
  };
};

export const appendAddedItems = (
  symbol: NormalizedSymbol,
  added: readonly AddedSymbolItem[] | undefined,
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
      shapes: [...section.shapes, ...forSection.map(addedItemToShape)],
    };
  });
  return { ...symbol, sections };
};

/**
 * 把一段里选中的元素转成"可粘贴项"（复制 / 再制共用）。
 *
 * 只收文本和用户自己画的图形：
 *  - 引脚复制出来会凭空多出一堆脚，网表直接乱；
 *  - 源库图形是多段折线 / 圆弧采样点，压成"线段 + 圆"会失真 —— 要改就直接改原件。
 *
 * 坐标取的是**传进来的这一份**（调用方应当传"套完编辑"的段），这样复制出来的是
 * 屏幕上看到的位置。
 */
export const selectionToAddedItems = (
  section: NormalizedSymbolSection,
  sectionIndex: number,
  keys: readonly string[],
  makeId: (prefix: string) => string,
): readonly AddedSymbolItem[] => {
  const items: AddedSymbolItem[] = [];
  for (const key of keys) {
    if (isSymbolPinKey(key) || isSymbolPinLabelKey(key)) {
      continue;
    }
    const shape = section.shapes[parseSymbolEditKey(key).index];
    if (shape === undefined || shape.hidden === true) {
      continue;
    }
    if (shape.kind === "text") {
      items.push({
        kind: "text",
        id: makeId("c"),
        section: sectionIndex,
        text: shape.text,
        at: shape.at,
        height: shape.height,
        rotation: shape.rotation,
      });
      continue;
    }
    if (shape.added !== true) {
      continue;
    }
    if (shape.kind === "rect") {
      items.push({
        kind: "rect",
        id: makeId("c"),
        section: sectionIndex,
        from: { x: Math.min(shape.min.x, shape.max.x), y: Math.min(shape.min.y, shape.max.y) },
        to: { x: Math.max(shape.min.x, shape.max.x), y: Math.max(shape.min.y, shape.max.y) },
      });
      continue;
    }
    const ellipse = shape.primitive?.type === "ellipse" ? shape.primitive : null;
    if (ellipse !== null) {
      items.push({
        kind: "circle",
        id: makeId("c"),
        section: sectionIndex,
        from: ellipse.center,
        to: { x: ellipse.center.x + ellipse.rx, y: ellipse.center.y },
      });
      continue;
    }
    const first = shape.points[0];
    const last = shape.points[shape.points.length - 1];
    if (first !== undefined && last !== undefined) {
      items.push({
        kind: "line",
        id: makeId("c"),
        section: sectionIndex,
        from: first,
        to: last,
      });
    }
  }
  return items;
};

/** 平移一件新增元素（复制粘贴错开位置用）。 */export const translateAddedItem = (
  item: AddedSymbolItem,
  dx: number,
  dy: number,
): AddedSymbolItem =>
  item.kind === "text"
    ? { ...item, at: { x: item.at.x + dx, y: item.at.y + dy } }
    : { ...item, from: { x: item.from.x + dx, y: item.from.y + dy }, to: { x: item.to.x + dx, y: item.to.y + dy } };

/** 兼容旧调用点：只追加文本。 */
export const appendAddedTexts = (
  symbol: NormalizedSymbol,
  added: readonly AddedTextShape[] | undefined,
): NormalizedSymbol => appendAddedItems(symbol, added);

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
): SymbolEdits => putEdit(edits, key, { ...edits[key], offset: undefined, points });

/** 直接设定文本内容（双击编辑）。空串合法 = 清空显示。 */
export const setTextContent = (edits: SymbolEdits, key: string, text: string): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], text });

/** 只挪引脚标签（对齐用）：引脚本体不动，保持贴边。 */
export const accumulateLabelShift = (
  edits: SymbolEdits,
  key: string,
  dx: number,
  dy: number,
): SymbolEdits => {
  const previous = edits[key]?.labelShift;
  return putEdit(edits, key, {
    ...edits[key],
    labelShift: { dx: (previous?.dx ?? 0) + dx, dy: (previous?.dy ?? 0) + dy },
  });
};

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
 * 设置描边线宽档位（Capture Line Width，0..3）。
 *
 * 注意 `0` 是"显式设为默认细线"，不是"没改" —— `isDefaultEdit` 只在字段为
 * `undefined` 时才算默认，所以 0 能被存下来（源图元本来是 2 的，改回 0 才有效）。
 */
export const setLineWidth = (edits: SymbolEdits, key: string, value: number): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], lineWidth: clampInt(value, 0, 3) });

/** 设置描边线型（Capture Line Style，0..5，0 = 实线）。 */
export const setLineStyle = (edits: SymbolEdits, key: string, value: number): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], lineStyle: clampInt(value, 0, 5) });

/** 文本粗体（写 TextFont.weight：700 / 400）。 */
export const setTextBold = (edits: SymbolEdits, key: string, bold: boolean): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], bold });

/** 文本斜体（写 TextFont.italic：1 / 0）。 */
export const setTextItalic = (edits: SymbolEdits, key: string, italic: boolean): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], italic });

/**
 * 设置圆半径（绝对值）。
 *
 * 只存半径、不存圆心 —— 圆心仍由 `offset` 负责，两者互不覆盖：
 * "先挪圆心再改半径"与"先改半径再挪圆心"得到同一个结果。
 */
export const setCircleRadius = (edits: SymbolEdits, key: string, radius: number): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], radius: Math.max(radius, 1) });

/** 设置线段两端（绝对坐标，只对两点直线有效）。offset 折进端点后清零，避免二次位移。 */
export const setLineEndpoints = (
  edits: SymbolEdits,
  key: string,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], offset: undefined, endpoints: { from, to } });

/** 设置引脚电气类型。 */
export const setPinType = (edits: SymbolEdits, key: string, type: SymbolPinType): SymbolEdits =>
  putEdit(edits, key, { ...edits[key], pinType: type });

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

