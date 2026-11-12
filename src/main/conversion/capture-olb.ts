import type {
  NormalizedSymbol,
  NormalizedSymbolPin,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
  SymbolPinType,
  SymbolShapePrimitive,
} from "../../shared/schemas";
import {
  bodyBoxOf,
  estimateCommentWidth,
  pinLabelShown,
  pinLabelWidth,
  pinNamesSuppressed,
  pinSideOf,
  symbolFontHeight,
  symbolTextLines,
} from "../../shared/symbol-labels";
import {
  alignBodyToGrid,
  alignPinEndsToGrid,
  sortPinsByNumber,
} from "../../shared/symbol-layout";

/**
 * OrCAD Capture 库 XML（.olb 交换格式）生成器。
 *
 * 结构与取值全部来自**真实导出件**（用 XMATIC_OLB2XML 把用户现有 .olb 导出成
 * XML 反推），不是猜的。几处踩过的坑，改动前务必保留：
 *
 *  1. `<PhysicalPart>` 必须嵌在 `<LibPart>` 内、位于 `<NormalView>` 之后。
 *     挂成 `<Package>` 的子节点时 XMATIC_XML2OLB 报
 *     `ERROR(SPSMI-1): ... no declaration found for element 'PhysicalPart'`。
 *  2. `<DefaultValues>` 可选（实测有不带的可用导出件），本生成器不产出。
 *  3. 单段器件 `CellName = Package 名`、`alphabeticNumbering="2"`、
 *     `isHomogeneous="1"`；多段器件 `CellName = Package 名 + 段号字母`、
 *     `alphabeticNumbering="1"`、`isHomogeneous="0"`。均已用现网库对照确认。
 *  4. 坐标单位 1 = 10 mil，源库（立创EDA专业版 SYMBOL 文档）同单位，**不缩放**。
 */

/** Capture 引脚类型码（取自本机 OrCAD Pin Type 下拉顺序）。 */
const PIN_TYPE_CODE: Record<SymbolPinType, number> = {
  input: 0,
  bidirectional: 1,
  output: 2,
  openCollector: 3,
  passive: 4,
  tristate: 5,
  openEmitter: 6,
  power: 7,
  // Capture 只有上述 8 种，未指定的引脚落到最中性的无源。
  unspecified: 4,
};

const SHAPE_FILL_STYLE = "1";
const SHAPE_HATCH_STYLE = "-1";
const SHAPE_LINE_STYLE = "0";
const SHAPE_LINE_WIDTH = "0";

/**
 * 椭圆/圆弧的填充样式取自**真实库**（Gate.olb 里 305 处椭圆全是 `fillStyle=1 hatchStyle=0`，
 * 导出回来看都是空心轮廓）。矩形沿用历史上的 -1（同样画成空心，不动它以免改变现有出图）。
 */
const CURVE_HATCH_STYLE = "0";

/** 真实库中 CommentText 的通用字体（本机导出件里 685/697 处均为该值）。 */
const COMMENT_FONT_NAME = "Arial";
const COMMENT_FONT_WIDTH = 4;

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const tag = (name: string, attributes: Readonly<Record<string, string | number>>): string => {
  const rendered = Object.entries(attributes)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(" ");
  return `  <${name} ${rendered} />`;
};

const render = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, "");
};

/**
 * 坐标必须落在 Capture 的符号网格上（1 单位 = 10 mil），**XML 里只接受整数**：
 * `x1="6.449"` 会让 XMATIC_XML2OLB 直接报
 * `value '6.5' does not match regular expression facet '[+\-]?[0-9]+'` 并整库导入失败。
 *
 * 立创的图形允许半单位坐标（椭圆按 24 边形近似后必然出小数），所以写入前统一取整。
 * 实测案例：C2866150（LMK00301ARHST）带一个半径 1.5 的极性圆点，近似后 88 个坐标
 * 带小数 → 整个符号写不进去；取整后 49 脚全部正常入库。
 */
const grid = (value: number): string => render(Math.round(value));

const sectionSuffix = (index: number): string => {
  // 0→A、1→B … 25→Z，超过 26 段用 AA/AB（Cadence 自身也只到字母段）。
  let remaining = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(65 + (remaining % 26)) + suffix;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return suffix;
};

const fontHeightFor = (sourceHeight: number): number => {
  // 源 fontSize 是符号单位（10 mil）下的字高，实测 12 对应 OrCAD 的 -9。
  // 按 0.75 折算并夹到真实库常见区间，避免出现超大字号。
  return symbolFontHeight(sourceHeight);
};

/**
 * 文本方向：源 rotation（立创的 90° 整数倍，逆时针）→ Capture 的 TextFont 两个字段。
 *
 * **关键是 `escapement`（单位：0.1°），不是 `orientation`**（用户 2026-10-19 手改样本
 * 给出的铁证）：Capture 里手动把 JTAG 转 90° 之后，导出的 TextFont 是
 * `escapement="900" orientation="90"`；而我们把 orientation 写成 90、escapement 留 0，
 * 生成的文本在 Capture 里始终是横排。两者按同一份样本照抄：escapement = 10×角度。
 */
const textOrientation = (rotation: number): number => {
  const snapped = Math.round(rotation / 90) * 90;
  return ((snapped % 360) + 360) % 360;
};

/** escapement 用 0.1° 为单位（900 = 90°）。 */
const textEscapement = (rotation: number): number => textOrientation(rotation) * 10;

/**
 * 字墨在 CommentText 框里的落点（用户 2026-11-11 XUTS-2201-042 实机截图实测）。
 *
 * 逐条比对 `locY/y1/y2` 与截图像素（用 24 个引脚的锚点标定 `py = 67 + 1.5667×y`）：
 *   - 16 条标注全部满足 `墨迹上沿 ≈ y1`（偏差 ≤ 0.3 单位）；
 *   - 墨迹高 ≈ `0.64 × 字高`（h=8 实测 5.1、h=9 的引脚号实测 5.74）；
 *   - 框高恒为 `round(1.556 × 字高)`，多出来的部分在字下面空着。
 *
 * 也就是说 Capture **把整行字贴着框的最小角画**，基线在 `y1 + 0.64×字高`，
 * y2 只影响选择框、不影响画面。之前把 `at`（预览里的基线）直接当 y1 写，
 * 整行字就往下掉了半个字高（8 号字 5 单位），再叠上源数据本身 10/12 混合的行距，
 * 越往下偏得越多、相邻标注叠成「3V/GND」。
 */
const CAP_HEIGHT_RATIO = 0.64;

/** 字墨高度（字高 → 基线上方的实际墨迹高度）。 */
const capHeight = (height: number): number => Math.round(height * CAP_HEIGHT_RATIO);

/**
 * 注释文字的包围盒（x1/x2/y1/y2）。
 *
 * `at` 与预览里的 SVG `<text x y>` 同义：**文字基线的左端**。框以「字墨贴着最小角」
 * 的规则反推：横排基线在 `y1 + cap`，所以 `y1 = at.y - cap`；90° 时整个框绕锚点
 * 刚性旋转，"字墨方向"（基线→字顶）转到 -x，`x1 = at.x - cap`。
 * 180°/270° 的基线本来就落在最小角上，无需偏移。
 *
 * **loc 必须取框的最小角**（用户 2026-10-19 手改对照得出的结论）：Capture 自己保存
 * 竖排文本时 locX/locY 就是 x1/y1。XMATIC 导入时若 loc 不在最小角，会**按横排把包围盒
 * 重算一遍**，竖排就丢了（实测：喂 loc=(x1,y2)、框 14×20，回读成了 24×14 的横框；
 * 改成 loc=(x1,y1) 后同样的框原样回读）。
 */
const commentTextBox = (
  at: { readonly x: number; readonly y: number },
  width: number,
  boxHeight: number,
  orientation: number,
  height: number,
): { readonly x1: number; readonly x2: number; readonly y1: number; readonly y2: number } => {
  const cap = capHeight(height);
  switch (orientation) {
    case 90:
      return { x1: at.x - cap, x2: at.x - cap + boxHeight, y1: at.y - width, y2: at.y };
    case 180:
      return { x1: at.x - width, x2: at.x, y1: at.y, y2: at.y + boxHeight };
    case 270:
      return { x1: at.x, x2: at.x + boxHeight, y1: at.y, y2: at.y + width };
    default:
      return { x1: at.x, x2: at.x + width, y1: at.y - cap, y2: at.y - cap + boxHeight };
  }
};

/**
 * 多行注释文本的行起点（用户 2026-11-09）。
 *
 * Capture 的 CommentText 没有换行概念，一行就是一条独立文本对象；多行只能按行距
 * 逐条错开摆。行距用 `round(height × 1.556)`，与 `TextFont` 的行高口径一致。
 */
const lineAnchor = (
  at: { readonly x: number; readonly y: number },
  step: number,
  orientation: number,
  index: number,
): { readonly x: number; readonly y: number } => {
  if (index === 0) {
    return at;
  }
  switch (orientation) {
    case 90:
      return { x: at.x + step * index, y: at.y };
    case 180:
      return { x: at.x, y: at.y - step * index };
    case 270:
      return { x: at.x - step * index, y: at.y };
    default:
      return { x: at.x, y: at.y + step * index };
  }
};

/** 一条注释文本 → 每行一个 `<CommentText>`（空行只占位、不产出空对象）。 */
const commentTextCommands = (
  shape: Extract<NormalizedSymbolShape, { kind: "text" }>,
): readonly string[] => {
  const height = fontHeightFor(shape.height);
  const boxHeight = Math.round(height * 1.556);
  const orientation = textOrientation(shape.rotation);
  return symbolTextLines(shape.text).flatMap((line, index) => {
    if (line.length === 0) {
      return [];
    }
    const at = lineAnchor(shape.at, boxHeight, orientation, index);
    const width = estimateCommentWidth(line, height);
    const box = commentTextBox(at, width, boxHeight, orientation, height);
    const commands = [
      tag("Defn", {
        locX: grid(Math.min(box.x1, box.x2)),
        locY: grid(Math.min(box.y1, box.y2)),
        name: line,
        textJustification: 0,
        x1: grid(box.x1),
        x2: grid(box.x2),
        y1: grid(box.y1),
        y2: grid(box.y2),
      }),
    ];
    return [
      [
        "    <CommentText>",
        ...commands,
        "      <TextFont>",
        tag("Defn", {
          charset: 0,
          escapement: textEscapement(shape.rotation),
          height: -height,
          /**
           * 文本字形（用户 2026-11-11 的属性编辑）。真实库里 400 = 常规、700 = 粗体，
           * italic 0/1 —— CommentText 只有这两个可写的字形位，没有颜色。
           */
          italic: shape.italic === true ? 1 : 0,
          name: COMMENT_FONT_NAME,
          orientation,
          weight: shape.bold === true ? 700 : 400,
          width: COMMENT_FONT_WIDTH,
        }),
        "      </TextFont>",
        "    </CommentText>",
      ].join("\n"),
    ];
  });
};

/**
 * 原生曲线图元 → `<Ellipse>` / `<Arc>`。
 *
 * 用户 2026-11-10：「预览与实际生成有差异，这个圆生成有问题」—— DSUB 的 9 个装饰圆在源里
 * 是半径 3 的 `E` 椭圆，以前按 24 边形逐点写 `<Line>`，而 XML 坐标只收整数：
 * r=3 的 24 个顶点取整后大量重合，出图成了"带台阶的八边形"。四角圆弧同理，
 * 取整后变成斜面。Capture 本身有椭圆与圆弧图元，直接写就能保持曲线。
 *
 * `<Arc>` 的语义（用 Gate.olb 的与门本体核对）：`x1..y2` 是**整条椭圆**的包围盒，
 * `startX/startY → endX/endY` 是弧的两个端点，没有 large-arc 标志 —— Capture 固定
 * 从 start 沿"屏幕上逆时针"画到 end。所以：
 *  - 我们的 `deltaAngle` 为负（屏幕上逆时针）时首尾原样用，为正时交换首尾；
 *  - 超过 180° 的弧无论怎么排序都会被画成补角，必须拆成两段（每段 ≤ 180°）。
 */
const arcPointOf = (
  arc: Extract<SymbolShapePrimitive, { type: "arc" }>,
  angle: number,
): { readonly x: number; readonly y: number } => ({
  x: arc.center.x + arc.rx * Math.cos(angle),
  y: arc.center.y + arc.ry * Math.sin(angle),
});

/** 描边属性（用户 2026-11-11）：改过就用 shape 上的枚举值，否则保持默认 0/0。 */
const strokeAttributes = (shape: {
  readonly lineStyle?: number;
  readonly lineWidth?: number;
}): { readonly lineStyle: string; readonly lineWidth: string } => ({
  lineStyle: shape.lineStyle === undefined ? SHAPE_LINE_STYLE : String(shape.lineStyle),
  lineWidth: shape.lineWidth === undefined ? SHAPE_LINE_WIDTH : String(shape.lineWidth),
});

const arcCommands = (
  arc: Extract<SymbolShapePrimitive, { type: "arc" }>,
  stroke: { readonly lineStyle: string; readonly lineWidth: string },
): readonly string[] | null => {
  const x1 = Math.round(arc.center.x - arc.rx);
  const x2 = Math.round(arc.center.x + arc.rx);
  const y1 = Math.round(arc.center.y - arc.ry);
  const y2 = Math.round(arc.center.y + arc.ry);
  // 半径不到半格时取整会把包围盒压成一条线 —— 那种退化图元宁可不写，退回折线
  if (x1 === x2 || y1 === y2) {
    return null;
  }
  const pieces = Math.max(1, Math.ceil(Math.abs(arc.deltaAngle) / Math.PI - 1e-9));
  const commands: string[] = [];
  for (let index = 0; index < pieces; index += 1) {
    const from = arc.startAngle + (arc.deltaAngle * index) / pieces;
    const delta = arc.deltaAngle / pieces;
    const head = arcPointOf(arc, from);
    const tail = arcPointOf(arc, from + delta);
    // delta > 0 = 屏幕顺时针，与 Capture 的固定画向相反 → 首尾互换
    const start = delta > 0 ? tail : head;
    const end = delta > 0 ? head : tail;
    commands.push(
      "    <Arc>",
      tag("Defn", {
        endX: grid(end.x),
        endY: grid(end.y),
        ...stroke,
        startX: grid(start.x),
        startY: grid(start.y),
        x1: grid(x1),
        x2: grid(x2),
        y1: grid(y1),
        y2: grid(y2),
      }),
      "    </Arc>",
    );
  }
  return commands;
};

const primitiveCommands = (
  primitive: SymbolShapePrimitive,
  stroke: { readonly lineStyle: string; readonly lineWidth: string },
): readonly string[] | null => {
  if (primitive.type === "arc") {
    return arcCommands(primitive, stroke);
  }
  const x1 = Math.round(primitive.center.x - primitive.rx);
  const x2 = Math.round(primitive.center.x + primitive.rx);
  const y1 = Math.round(primitive.center.y - primitive.ry);
  const y2 = Math.round(primitive.center.y + primitive.ry);
  if (x1 === x2 || y1 === y2) {
    return null;
  }
  return [
    "    <Ellipse>",
    tag("Defn", {
      fillStyle: SHAPE_FILL_STYLE,
      hatchStyle: CURVE_HATCH_STYLE,
      ...stroke,
      x1: grid(x1),
      x2: grid(x2),
      y1: grid(y1),
      y2: grid(y2),
    }),
    "    </Ellipse>",
  ];
};

const shapeCommands = (shape: NormalizedSymbolShape): readonly string[] => {
  const stroke = strokeAttributes(shape.kind === "text" ? {} : shape);
  if (shape.kind === "rect") {
    return [
      "    <Rect>",
      tag("Defn", {
        fillStyle: SHAPE_FILL_STYLE,
        hatchStyle: SHAPE_HATCH_STYLE,
        ...stroke,
        x1: grid(shape.min.x),
        x2: grid(shape.max.x),
        y1: grid(shape.min.y),
        y2: grid(shape.max.y),
      }),
      "    </Rect>",
    ];
  }
  if (shape.kind === "polyline") {
    // 折线只是椭圆/圆弧的采样近似 → 有原生参数就写真曲线，避免整数取整把圆画成多边形
    if (shape.primitive !== undefined) {
      const native = primitiveCommands(shape.primitive, stroke);
      if (native !== null) {
        return native;
      }
    }
    const points = shape.closed ? [...shape.points, shape.points[0]] : shape.points;
    const commands: string[] = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      commands.push(
        "    <Line>",
        tag("Defn", {
          ...stroke,
          x1: grid(start.x),
          x2: grid(end.x),
          y1: grid(start.y),
          y2: grid(end.y),
        }),
        "    </Line>",
      );
    }
    return commands;
  }
  return commentTextCommands(shape);
};

/** 引脚名离引脚轴线的横向偏移（复刻 Capture 自己保存下来的坐标）。 */
const PIN_NAME_AXIS_GAP = 5;
/** 引脚名与本体边缘之间的留白。 */
const PIN_NAME_EDGE_GAP = 2;
/** 引脚名的字高（Capture 符号默认字号）。 */
const PIN_NAME_FONT_HEIGHT = -9;

/**
 * 引脚名在 Capture 里的落点 —— 显式写 `<PinDisplayProp name="Name">`。
 *
 * 不写这一条时 Capture 会自己"估价"每个脚的名字位置：在本体只有 20 单位高的
 * 小符号里，上、下两排引脚名会被摆到本体正中叠成一团（用户 2026-11-10 报的
 * "41 / 32 / 35" 就是这个）。坐标复刻用户手绘、Capture 自己保存的
 * `LIBRARY1.OLB` 里的 `RF` 单元：
 *   上边脚 = (脚 x − 5, 本体上边 + 1)，竖排从锚点往下生长；
 *   下边脚 = (脚 x − 5, 本体下边 − 2 − 文字长)，同样竖排往下生长。
 * 左右脚不写 —— 实测 Capture 默认就摆在本体内侧，位置正常。
 *
 * 名字被 `pinLabelShown` 关掉时写 `val=0`：整段的 `<IsPinNamesVisible>` 在部分
 * Capture 上不生效，逐脚这一条是第二道保险（tclsh 往返确认 val 会被原样保留）。
 */
const pinNamePropCommands = (
  section: NormalizedSymbolSection,
  pin: NormalizedSymbolPin,
  position: number,
): readonly string[] => {
  const name = pin.name.trim();
  if (name === "") {
    return [];
  }
  const side = pinSideOf(pin);
  if (side !== "top" && side !== "bottom") {
    return [];
  }
  const body = bodyBoxOf(section);
  const length = pinLabelWidth(name);
  const locY =
    side === "top"
      ? body.minY + 1
      : Math.max(body.minY + 1, body.maxY - PIN_NAME_EDGE_GAP - length);
  return [
    "      <PinDisplayProp>",
    tag("Defn", {
      locX: grid(pin.body.x - PIN_NAME_AXIS_GAP),
      locY: grid(locY),
      name: "Name",
      rotation: 1,
      textJustification: 0,
    }),
    "        <PropFont>",
    tag("Defn", {
      charset: 0,
      escapement: 0,
      height: PIN_NAME_FONT_HEIGHT,
      italic: 0,
      name: "",
      orientation: 0,
      weight: 400,
      width: 4,
    }),
    "        </PropFont>",
    "        <PropColor>",
    '          <Defn val="48" />',
    "        </PropColor>",
    "        <PropDispType>",
    tag("Defn", {
      ValueIfValueExist: 0,
      val: pinLabelShown(section, position, "name") ? 1 : 0,
    }),
    "        </PropDispType>",
    "      </PinDisplayProp>",
  ];
};

const pinCommands = (
  section: NormalizedSymbolSection,
  pin: NormalizedSymbolPin,
  position: number,
): readonly string[] => [
  "    <SymbolPinScalar>",
  tag("Defn", {
    hotptX: grid(pin.connection.x),
    hotptY: grid(pin.connection.y),
    name: pin.name,
    position,
    startX: grid(pin.body.x),
    startY: grid(pin.body.y),
    type: PIN_TYPE_CODE[pin.type],
    visible: pin.visible ? 1 : 0,
  }),
  ...(
    [
      ["IsLong", 0],
      ["IsClock", 0],
      ["IsDot", 0],
      ["IsLeftPointing", 0],
      ["IsRightPointing", 0],
      ["IsNetStyle", 0],
      ["IsNoConnect", 0],
      ["IsGlobal", 0],
      // 名字与脚号相同时只留一份，**由 `pinLabelShown` 统一裁决**：
      // 整段名字被关掉时改由脚号顶上，两个开关不能各判各的（否则两边都关 = 什么都不画）。
      ["IsNumberVisible", pinLabelShown(section, position, "number") ? 1 : 0],
    ] as const
  ).flatMap(([name, value]) => [
    `      <${name}>`,
    `        <Defn val="${value}" />`,
    `      </${name}>`,
  ]),
  ...pinNamePropCommands(section, pin, position),
  "    </SymbolPinScalar>",
];

const displayPropCommands = (
  name: string,
  locX: number,
  locY: number,
): readonly string[] => [
  "      <SymbolDisplayProp>",
  tag("Defn", {
    locX: grid(locX),
    locY: grid(locY),
    name,
    rotation: 0,
    textJustification: 0,
  }),
  "        <PropFont>",
  tag("Defn", {
    charset: 0,
    escapement: 0,
    height: -9,
    italic: 0,
    name: "",
    orientation: 0,
    weight: 400,
    width: 4,
  }),
  "        </PropFont>",
  "        <PropColor>",
  '          <Defn val="48" />',
  "        </PropColor>",
  "        <PropDispType>",
  tag("Defn", { ValueIfValueExist: 0, val: 1 }),
  "        </PropDispType>",
  "      </SymbolDisplayProp>",
];

const hasVerticalPins = (section: NormalizedSymbolSection): boolean =>
  section.pins.some((pin) => {
    const side = pinSideOf(pin);
    return side === "top" || side === "bottom";
  });

const normalViewCommands = (
  symbol: NormalizedSymbol,
  section: NormalizedSymbolSection,
): readonly string[] => {
  const body = bodyBoxOf(section);
  // 全局旋转规则：**有上下边引脚时必须置 1**，否则它们的名字会被水平画出、
  // 和相邻横排标签糊在一起。逐脚落点见 `pinNamePropCommands`，左右两侧的重叠
  // 交给 shared/symbol-layout.ts 的几何避让。
  const commands: string[] = ["      <NormalView>", '        <Defn suffix=".Normal" />'];
  // "Part Reference" 贴在本体上方、"Value" 贴在本体下方 —— 坐标与现网库一致
  // （y 轴在编辑器里向下，所以 minY-14 在屏幕上位于本体上侧）。
  commands.push(...displayPropCommands("Part Reference", body.minX + 7, body.minY - 14));
  commands.push(...displayPropCommands("Value", body.minX + 7, body.maxY + 4));
  commands.push(
    "        <SymbolColor>",
    '          <Defn val="48" />',
    "        </SymbolColor>",
    "        <SymbolBBox>",
    tag("Defn", {
      x1: grid(body.minX),
      x2: grid(body.maxX),
      y1: grid(body.minY),
      y2: grid(body.maxY),
    }),
    "        </SymbolBBox>",
    "        <IsPinNumbersVisible>",
    '          <Defn val="1" />',
    "        </IsPinNumbersVisible>",
    "        <IsPinNamesRotated>",
    `          <Defn val="${hasVerticalPins(section) ? 1 : 0}" />`,
    "        </IsPinNamesRotated>",
    "        <IsPinNamesVisible>",
    // 逐脚 `IsNumberVisible=0` 在这台 Capture 上不生效（照样画脚号），只有整段的
    // 这个开关能真正关掉那排名字。name 全等于 number 时名字没有信息量，关掉后
    // 每个脚只剩一个脚号，不再出现「本体内侧一个数字、引脚旁又一个」的叠字。
    `          <Defn val="${pinNamesSuppressed(section) ? 0 : 1}" />`,
    "        </IsPinNamesVisible>",
    "        <ContentsLibName>",
    '          <Defn name="" />',
    "        </ContentsLibName>",
    "        <ContentsViewName>",
    '          <Defn name="" />',
    "        </ContentsViewName>",
    "        <ContentsViewType>",
    '          <Defn type="0" />',
    "        </ContentsViewType>",
    "        <PartValue>",
    '          <Defn name="" />',
    "        </PartValue>",
    "        <Reference>",
    tag("Defn", { name: symbol.refdesPrefix }),
    "        </Reference>",
  );
  for (const shape of section.shapes) {
    // 用户在预览里删掉的东西（注释文本 / 自己画的图形）：留位（下标稳定）但不写进库
    if (shape.hidden === true) {
      continue;
    }
    commands.push(...shapeCommands(shape));
  }
  section.pins.forEach((pin, index) => {
    commands.push(...pinCommands(section, pin, index));
  });
  commands.push("      </NormalView>");
  return commands;
};

/**
 * 生成可直接交给 XMATIC_XML2OLB 的 Capture 库 XML。
 *
 * `libraryPath` 会写进根 `<Defn name=...>`：实测必须与目标 .olb 的实际路径一致
 * （导入器按它定位要写入的库），务必传绝对路径。
 */
export const buildCaptureLibraryXml = (
  symbol: NormalizedSymbol,
  libraryPath: string,
  options: { readonly fillPcbFootprint?: boolean; readonly snapPins?: boolean } = {},
): string => {
  // 写库出口统一吸附：解析阶段已对齐过一次，但用户可能在预览里手动拖过元素
  // （offset 是任意小数）。不吸附的话生成出来的引脚在 Capture 里接不上线。
  // 用户 2026-10-20 定：**跟随界面吸附开关** —— 关掉后按实际坐标写（仍取整）。
  // 用 alignPinEndsToGrid 而不是只钉连接端：要求是**两端**都在 100 mil 格点上，
  // 只钉连接端会留下 15 这种非整数倍长度（用户 2026-11-10 报"实物不正常"）。
  // 本体矩形随后再落一次格（alignBodyToGrid）：预览里拖过的框也要和引脚一样对齐。
  // 排序放最后：position 是数组下标，Capture 按它对齐名字与脚号。
  // 解析阶段已排过一次，这里再兜一次（历史器件 / 拖动过的）。
  const aligned =
    options.snapPins === false
      ? symbol.sections
      : symbol.sections.map((section) => alignBodyToGrid(alignPinEndsToGrid(section)));
  const sections = aligned.map(sortPinsByNumber);
  const multiSection = sections.length > 1;
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<Lib xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="olb.xsd">',
    "",
    tag("Defn", { name: libraryPath }),
    "",
    "  <Package>",
    tag("Defn", {
      alphabeticNumbering: multiSection ? 1 : 2,
      isHomogeneous: multiSection ? 0 : 1,
      name: symbol.name,
      // 用户 2026-10-19 要求可选：关掉时留空，Capture 里就是空字段
      pcbFootprint: options.fillPcbFootprint === false ? "" : symbol.pcbFootprint,
      pcbLib: "",
      refdesPrefix: symbol.refdesPrefix,
      timestamp: now,
      timezone: "0800",
    }),
  ];
  sections.forEach((section, index) => {
    lines.push(
      "    <LibPart>",
      tag("Defn", {
        CellName: multiSection ? `${symbol.name}${sectionSuffix(index)}` : symbol.name,
      }),
      ...normalViewCommands({ ...symbol, sections }, section),
      "      <PhysicalPart>",
      "        <Defn />",
      ...section.pins.map((pin, pinIndex) =>
        [
          "        <PinNumber>",
          tag("Defn", { number: pin.number, position: pinIndex }),
          "        </PinNumber>",
        ].join("\n"),
      ),
      "      </PhysicalPart>",
      "    </LibPart>",
    );
  });
  lines.push("  </Package>", "</Lib>", "");
  return lines.join("\n");
};
