import type {
  NormalizedSymbol,
  NormalizedSymbolPin,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
  SymbolPinType,
} from "../../shared/schemas";

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
  const mapped = Math.round(sourceHeight * 0.75);
  return Math.min(Math.max(mapped, 8), 18);
};

const commentTextCommands = (shape: Extract<NormalizedSymbolShape, { kind: "text" }>): string => {
  const height = fontHeightFor(shape.height);
  const width = Math.max(Math.ceil(shape.text.length * height * 0.667), height);
  const boxHeight = Math.round(height * 1.556);
  const lines = [
    tag("Defn", {
      locX: render(shape.at.x),
      locY: render(shape.at.y),
      name: shape.text,
      textJustification: 0,
      x1: render(shape.at.x),
      x2: render(shape.at.x + width),
      y1: render(shape.at.y),
      y2: render(shape.at.y + boxHeight),
    }),
  ];
  return [
    "    <CommentText>",
    ...lines,
    "      <TextFont>",
    tag("Defn", {
      charset: 0,
      escapement: 0,
      height: -height,
      italic: 0,
      name: COMMENT_FONT_NAME,
      orientation: 0,
      weight: 400,
      width: COMMENT_FONT_WIDTH,
    }),
    "      </TextFont>",
    "    </CommentText>",
  ].join("\n");
};

const shapeCommands = (shape: NormalizedSymbolShape): readonly string[] => {
  if (shape.kind === "rect") {
    return [
      "    <Rect>",
      tag("Defn", {
        fillStyle: SHAPE_FILL_STYLE,
        hatchStyle: SHAPE_HATCH_STYLE,
        lineStyle: SHAPE_LINE_STYLE,
        lineWidth: SHAPE_LINE_WIDTH,
        x1: render(shape.min.x),
        x2: render(shape.max.x),
        y1: render(shape.min.y),
        y2: render(shape.max.y),
      }),
      "    </Rect>",
    ];
  }
  if (shape.kind === "polyline") {
    const points = shape.closed ? [...shape.points, shape.points[0]] : shape.points;
    const commands: string[] = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      commands.push(
        "    <Line>",
        tag("Defn", {
          lineStyle: SHAPE_LINE_STYLE,
          lineWidth: SHAPE_LINE_WIDTH,
          x1: render(start.x),
          x2: render(end.x),
          y1: render(start.y),
          y2: render(end.y),
        }),
        "    </Line>",
      );
    }
    return commands;
  }
  return [commentTextCommands(shape)];
};

const pinCommands = (pin: NormalizedSymbolPin, position: number): readonly string[] => [
  "    <SymbolPinScalar>",
  tag("Defn", {
    hotptX: render(pin.connection.x),
    hotptY: render(pin.connection.y),
    name: pin.name,
    position,
    startX: render(pin.body.x),
    startY: render(pin.body.y),
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
      ["IsNumberVisible", 1],
    ] as const
  ).flatMap(([name, value]) => [
    `      <${name}>`,
    `        <Defn val="${value}" />`,
    `      </${name}>`,
  ]),
  "    </SymbolPinScalar>",
];

const displayPropCommands = (
  name: string,
  locX: number,
  locY: number,
): readonly string[] => [
  "      <SymbolDisplayProp>",
  tag("Defn", {
    locX: render(locX),
    locY: render(locY),
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

const normalViewCommands = (
  symbol: NormalizedSymbol,
  section: NormalizedSymbolSection,
): readonly string[] => {
  const commands: string[] = ["      <NormalView>", '        <Defn suffix=".Normal" />'];
  // "Part Reference" 贴在本体下方、"Value" 贴在本体上方 —— 与用户库里的
  // r0603.dra / STM32G431CB 的摆放习惯一致。
  commands.push(...displayPropCommands("Part Reference", section.bounds.minX + 7, section.bounds.minY - 14));
  commands.push(...displayPropCommands("Value", section.bounds.minX + 7, section.bounds.maxY + 4));
  commands.push(
    "        <SymbolColor>",
    '          <Defn val="48" />',
    "        </SymbolColor>",
    "        <SymbolBBox>",
    tag("Defn", {
      x1: render(section.bounds.minX),
      x2: render(section.bounds.maxX),
      y1: render(section.bounds.minY),
      y2: render(section.bounds.maxY),
    }),
    "        </SymbolBBox>",
    "        <IsPinNumbersVisible>",
    '          <Defn val="1" />',
    "        </IsPinNumbersVisible>",
    "        <IsPinNamesRotated>",
    '          <Defn val="0" />',
    "        </IsPinNamesRotated>",
    "        <IsPinNamesVisible>",
    '          <Defn val="1" />',
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
    commands.push(...shapeCommands(shape));
  }
  section.pins.forEach((pin, index) => {
    commands.push(...pinCommands(pin, index));
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
): string => {
  const multiSection = symbol.sections.length > 1;
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
      pcbFootprint: symbol.pcbFootprint,
      pcbLib: "",
      refdesPrefix: symbol.refdesPrefix,
      timestamp: now,
      timezone: "0800",
    }),
  ];
  symbol.sections.forEach((section, index) => {
    lines.push(
      "    <LibPart>",
      tag("Defn", {
        CellName: multiSection ? `${symbol.name}${sectionSuffix(index)}` : symbol.name,
      }),
      ...normalViewCommands(symbol, section),
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
