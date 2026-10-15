import { basename, join } from "node:path";
import type {
  ConversionPlan,
  NormalizedCircle,
  NormalizedFootprint,
  NormalizedLine,
  NormalizedPad,
  Point,
} from "../../shared/schemas";
import { derivePadstackName } from "./naming";

export type AllegroSourceFile = {
  readonly relativePath: string;
  readonly content: string;
};

export type AllegroSourceBundle = {
  readonly symbolName: string;
  readonly sources: readonly AllegroSourceFile[];
  readonly expectedOutputs: readonly string[];
};

const number = (value: number): string => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Allegro source generation received a non-finite number: ${String(value)}`);
  }
  return value.toFixed(5).replace(/\.?0+$/, "");
};

const skillString = (value: string): string =>
  `"${value.replaceAll("\\", "/").replaceAll("\"", "\\\"")}"`;

const point = (value: Point): string => `${number(value.x)}:${number(value.y)}`;

// 2026-10-15 Allegro 17.4 探测实验（P2-P5）结论：axlDBCreatePadStack 的
// make_axlPadStackPad ?figureSize 要求宽高与图形语义一致 —— 裸 'RECTANGLE 在
// w==h 时报 Illegal figure size（PEX8748 BGA 全失败、C2040 EP 首个 padstack 失败的根因），
// 方形必须用 'SQUARE；'CIRCLE/'OCTAGON 要求方形；'OBLONG_X/'OBLONG_Y/'ROUNDED_RECTANGLE
// 方形与非方形均可。判定按 number() 格式化后的文本比较，与实际写进 SKILL 的值一致。
const padFigure = (pad: NormalizedPad, width: number, height: number): string => {
  if (pad.shape === "circle") {
    return "'CIRCLE";
  }
  if (pad.shape === "oval") {
    return number(width) >= number(height) ? "'OBLONG_X" : "'OBLONG_Y";
  }
  if (pad.shape === "roundedRectangle") {
    return "'ROUNDED_RECTANGLE";
  }
  return number(width) === number(height) ? "'SQUARE" : "'RECTANGLE";
};

const padLayerPad = (
  pad: NormalizedPad,
  layer: string,
  scale: number,
  expansion: number,
): string => {
  const width = pad.width * scale + expansion * 2;
  const height = pad.height * scale + expansion * 2;
  return `make_axlPadStackPad(?layer ${skillString(layer)} ?type 'REGULAR ?figure ${padFigure(pad, width, height)} ?figureSize ${number(width)}:${number(height)}${corners(pad)})`;
};

const corners = (pad: NormalizedPad): string =>
  pad.shape === "roundedRectangle"
    ? ` ?corners "UR-UL-LR-LL" ?radius ${number(Math.min(pad.width, pad.height) * 0.2)}`
    : "";

const padDefinition = (
  pad: NormalizedPad,
  solderMaskExpansionMm: number,
  pasteAreaRatio: number,
): string => {
  const name = derivePadstackName(pad);
  const throughHole = pad.holeWidth > 0;
  const pasteScale = pad.width * pad.height > 16 ? Math.sqrt(pasteAreaRatio) : 1;
  const drillFigure =
    pad.holeHeight > pad.holeWidth + 0.001
      ? pad.rotation % 180 === 0
        ? "'OBLONG_Y"
        : "'OBLONG_X"
      : "'CIRCLE";
  const drill = throughHole
    ? `make_axlPadStackDrill(
      ?holeType ${pad.holeHeight > pad.holeWidth + 0.001 ? "'SLOT" : "'CIRCLE_DRILL"}
      ?plating ${pad.plated ? "'PLATED" : "'NON_PLATED"}
      ?drillDiameter ${number(pad.holeWidth)}
      ?figure ${drillFigure}
      ?figureSize ${number(pad.holeWidth)}:${number(Math.max(pad.holeHeight, pad.holeWidth))}
      ?drillChar "A"
    )`
    : "nil";
  const layerPads = throughHole
    ? `list(
      ${padLayerPad(pad, "TOP", 1, 0)}
      ${padLayerPad(pad, "DEFAULT INTERNAL", 1, 0)}
      ${padLayerPad(pad, "BOTTOM", 1, 0)}
      ${padLayerPad(pad, "SOLDERMASK_TOP", 1, solderMaskExpansionMm)}
      ${padLayerPad(pad, "SOLDERMASK_BOTTOM", 1, solderMaskExpansionMm)}
    )`
    : `list(
      ${padLayerPad(pad, "TOP", 1, 0)}
      ${padLayerPad(pad, "SOLDERMASK_TOP", 1, solderMaskExpansionMm)}
      ${padLayerPad(pad, "PASTEMASK_TOP", pasteScale, 0)}
    )`;
  return `
  padObj = axlDBCreatePadStack(
    ${skillString(name)}
    ${drill}
    ${layerPads}
    t
  )
  unless(padObj
    error("Unable to create padstack ${name}\\n")
  )
  ; axlPadstackToDisk 的参数是设计中的 padstack 名（P8 实测），不是文件路径；
  ; .pad 由 Allegro 写入当前作业目录且文件名强制小写，随后由 runner 复制进库目录。
  unless(axlPadstackToDisk(${skillString(name)})
    error("Unable to write padstack ${name}\\n")
  )`;
};

const layerName = (line: NormalizedLine): string => {
  if (line.layer === "silkscreen") {
    return "PACKAGE GEOMETRY/SILKSCREEN_TOP";
  }
  if (line.layer === "assembly") {
    return "PACKAGE GEOMETRY/ASSEMBLY_TOP";
  }
  if (line.layer === "courtyard") {
    return "PACKAGE GEOMETRY/PLACE_BOUND_TOP";
  }
  return "MANUFACTURING/DOCUMENTATION";
};

const circleLayerName = (circle: NormalizedCircle): string =>
  circle.layer === "silkscreen"
    ? "PACKAGE GEOMETRY/SILKSCREEN_TOP"
    : circle.layer === "assembly"
      ? "PACKAGE GEOMETRY/ASSEMBLY_TOP"
      : "MANUFACTURING/DOCUMENTATION";

const lineCommand = (line: NormalizedLine): string =>
  `  axlDBCreateLine(list(${point(line.start)} ${point(line.end)}) ${number(line.width)} ${skillString(layerName(line))})`;

// axlDBCreateCircle(l_location [f_width] [t_layer] [o_parent]) —— Cadence SKILL
// Reference: l_location 为 (X:Y R)，即中心点与半径必须包进同一个 list；第二个
// 位置参数是圆边线宽。2026-10-15 实测（P15/E2E4）：把中心/半径拆成两个独立位置
// 参数时 Allegro 对首参做 caar 解包得到标量，报
// "car: argument #1 should be a list (type template = "l") - -3.05" 并中断
// e2a_build；此前把 radius/width 一起塞进首参、并省略线宽同样是错的。
const circleCommand = (circle: NormalizedCircle): string =>
  `  axlDBCreateCircle(list(${point(circle.center)} ${number(circle.radius)}) ${number(circle.width)} ${skillString(circleLayerName(circle))})`;

// 空 drawing 的 extents 为 nil：axlDBCreatePin 会报 "Pin is outside of the extents"
// 而失败（P9-P12 实测，与 SKILL 加载、坐标大小、对象顺序均无关；P12 证明
// axlDBChangeDesignExtents 后立刻可建 pin）。因此创建任何引脚或文本前必须显式给出
// 绘制范围 —— 覆盖 footprint bounds 与全部标签包围盒，再外扩 max(2mm, 20%)。
// 见 designExtentsCommand。

const pinCommand = (pad: NormalizedPad): string => {
  const rotation = ((pad.rotation % 360) + 360) % 360;
  return `  e2a_create_pin(${skillString(derivePadstackName(pad))} ${point(pad.center)} ${skillString(pad.number)} ${number(rotation)})`;
};

const nonPlatedHoleCommand = (center: Point, diameter: number, index: number): string => {
  const pad: NormalizedPad = {
    number: `MH${index}`,
    center,
    width: diameter + 0.5,
    height: diameter + 0.5,
    rotation: 0,
    shape: "circle",
    polygon: [],
    plated: false,
    holeWidth: diameter,
    holeHeight: diameter,
    sourceLayerId: 11,
  };
  return pinCommand(pad);
};

const uniquePadstacks = (pads: readonly NormalizedPad[]): readonly NormalizedPad[] => [
  ...new Map(pads.map((pad) => [derivePadstackName(pad), pad])).values(),
];

// 文本尺寸实测（P19 真机探针，Allegro 17.4S032，textBlock "1" + ?justify "center"）：
//   1 字符 0.4064mm 宽 / 3 字符 "REF" 1.524 / 12 字符 "PEX8748_BACA" 6.5532 /
//   21 字符 "QFN50P500X500X100-33N" 11.5824 → 每字符步进 ≈0.5515mm；
//   纵向 bBox = (-0.2116 … +0.635)，即基线以下 0.21mm、以上 0.64mm。
// 取整到 0.6 / 0.3 / 0.7 留余量。这组常量用于把标签包围盒并进 extents —— 否则
// axlDBCreateText 会报 ERROR(SPMHA1-73): Text line is outside of the extents 并
// **静默丢弃该文本**（E2E9 实测：±4.9 的 extents 下，21 字符居中名字横向需 ±5.79，
// 两条 COMPONENT VALUE 文本全部缺失，而 build-status 依旧写 status=ok）。
const TEXT_ADVANCE_MM = 0.6;
const TEXT_ASCENT_MM = 0.7;
const TEXT_DESCENT_MM = 0.3;

type FootprintLabel = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly layer: string;
};

// 标签（label）合成 —— 2026-10-15 以用户手工封装
// E:\high_clouds\cadence\cadencelib\lib\PCB\r0603.dra 为基准做真机 dump 对比后确定：
//   参考件的文本元素 = REF DES/ASSEMBLY_TOP("REF")、
//   COMPONENT VALUE/SILKSCREEN_TOP、COMPONENT VALUE/ASSEMBLY_TOP，
//   另加随 pin 自动生成的 PACKAGE GEOMETRY/PIN_NUMBER（无需我们创建）。
// 两个数据源都不提供任何文本元素：elibz2 的 FOOTPRINT 块全块只有一条
//   {key:"Footprint", value:<封装名>, layerId:3, x:null, y:null, valueVisible:false}
//   的 ATTR（未摆位且隐藏），而立创 C 编号接口的 packageDetail.dataStr.shape 只含
//   PAD/TRACK/CIRCLE/SOLIDREGION/ARC/SVGNODE。因此标签必须由生成端合成，不能依赖源数据。
// 摆放：参考件把三个文本都压在原点 (0,0)，实际会与本体/焊盘重叠；此处改为摆到本体轮廓
//   正上/正下方并居中（位号在上、器件名在下），既避开焊盘又不侵入相邻器件。
//   横向中心取「焊盘包围盒」中点而非 bounds 中点 —— bounds 会被 1 脚圆点等丝印标记带偏
//   （PEX8748 的 bounds 因 pin1 圆点偏向 -0.385，而焊盘中心正是 0）；纵向位置按 bounds
//   外扩 1mm，以保证避开全部已绘制几何（丝印外框与标记）。
// 取值：REF DES 类层只接受纯文本，"REF**" 会触发 SPMHUT-1（P17 实测），故用 "REF"；
//   COMPONENT VALUE 类层放目标封装名（信息量最大，且与参考件的占位文本同语义）。
const footprintLabels = (footprint: NormalizedFootprint): readonly FootprintLabel[] => {
  const padCentersX = footprint.pads.flatMap((pad) => [
    pad.center.x - pad.width / 2,
    pad.center.x + pad.width / 2,
  ]);
  const centerX =
    padCentersX.length > 0
      ? (Math.min(...padCentersX) + Math.max(...padCentersX)) / 2
      : (footprint.bounds.minX + footprint.bounds.maxX) / 2;
  const topY = footprint.bounds.maxY + 1;
  const bottomY = footprint.bounds.minY - 1;
  const name = footprint.info.targetPackageName;
  return [
    { text: "REF", x: centerX, y: topY, layer: "REF DES/SILKSCREEN_TOP" },
    { text: "REF", x: centerX, y: topY, layer: "REF DES/ASSEMBLY_TOP" },
    { text: name, x: centerX, y: bottomY, layer: "COMPONENT VALUE/SILKSCREEN_TOP" },
    { text: name, x: centerX, y: bottomY, layer: "COMPONENT VALUE/ASSEMBLY_TOP" },
  ];
};

const labelCommands = (labels: readonly FootprintLabel[]): string =>
  labels
    .map(
      (label) =>
        `    axlDBCreateText(${skillString(label.text)} ${number(label.x)}:${number(label.y)} textOrientation ${skillString(label.layer)})`,
    )
    .join("\n");

// 绘制范围必须同时覆盖本体几何与标签包围盒（见 TEXT_ADVANCE_MM 注释）。
const designExtentsCommand = (
  bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  },
  labels: readonly FootprintLabel[],
): string => {
  const box = labels.reduce(
    (accumulated, label) => {
      const halfWidth = (label.text.length * TEXT_ADVANCE_MM) / 2;
      return {
        minX: Math.min(accumulated.minX, label.x - halfWidth),
        minY: Math.min(accumulated.minY, label.y - TEXT_DESCENT_MM),
        maxX: Math.max(accumulated.maxX, label.x + halfWidth),
        maxY: Math.max(accumulated.maxY, label.y + TEXT_ASCENT_MM),
      };
    },
    {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
    },
  );
  const width = Math.abs(box.maxX - box.minX);
  const height = Math.abs(box.maxY - box.minY);
  const margin = Math.max(2, width * 0.2, height * 0.2);
  return `    axlDBChangeDesignExtents(list(${number(box.minX - margin)}:${number(box.minY - margin)} ${number(box.maxX + margin)}:${number(box.maxY + margin)}))`;
};

// ASSEMBLY 层轮廓：参考件 r0603.dra 在 PACKAGE GEOMETRY/ASSEMBLY_TOP 上有两条本体轮廓线，
// 而两个数据源都只提供丝印几何（elibz2 的 POLY/FILL 全部 layerId=3）。装配图轮廓按业界惯例
// 与本体/丝印轮廓一致，故把丝印几何复制到 ASSEMBLY_TOP（线宽原样保留）。若源数据本身已带
// assembly 层几何，则不做复制，避免与其重复。
const assemblyOutlineCommands = (footprint: NormalizedFootprint): string => {
  const hasSourceAssembly =
    footprint.lines.some((line) => line.layer === "assembly") ||
    footprint.circles.some((circle) => circle.layer === "assembly");
  if (hasSourceAssembly) {
    return "";
  }
  return [
    ...footprint.lines
      .filter((line) => line.layer === "silkscreen")
      .map((line) => lineCommand({ ...line, layer: "assembly" })),
    ...footprint.circles
      .filter((circle) => circle.layer === "silkscreen")
      .map((circle) => circleCommand({ ...circle, layer: "assembly" })),
  ].join("\n");
};

const buildSkillSource = (
  plan: ConversionPlan,
  verificationPath: string,
  buildStatusPath: string,
): string => {
  const footprint = plan.footprint;
  const mechanicalPads = footprint.holes.map((hole, index) => ({
    number: `MH${index + 1}`,
    center: hole.center,
    width: hole.diameter + 0.5,
    height: hole.diameter + 0.5,
    rotation: 0,
    shape: "circle" as const,
    polygon: [],
    plated: false,
    holeWidth: hole.diameter,
    holeHeight: hole.diameter,
    sourceLayerId: 11,
  }));
  const allPads = [...footprint.pads, ...mechanicalPads];
  const definitions = uniquePadstacks(allPads)
    .map((pad) =>
      padDefinition(
        pad,
        plan.solderMaskExpansionMm,
        plan.pasteAreaRatio,
      ),
    )
    .join("\n");
  const pins = [
    ...footprint.pads.map(pinCommand),
    ...footprint.holes.map((hole, index) =>
      nonPlatedHoleCommand(hole.center, hole.diameter, index + 1),
    ),
  ].join("\n");
  const lines = footprint.lines.map(lineCommand).join("\n");
  const circles = footprint.circles.map(circleCommand).join("\n");
  const assemblyOutline = assemblyOutlineCommands(footprint);
  const labels = footprintLabels(footprint);
  const extents = designExtentsCommand(footprint.bounds, labels);
  return `; Generated by Easy2ALG. Do not edit manually.
procedure(e2a_create_pin(padName location pinNumber rotation)
  let((textOrientation textBlock pinText pinObject)
    textOrientation = make_axlTextOrientation(
      ?textBlock "1"
      ?rotation 0.0
      ?justify "center"
      ?mirrored nil
    )
    pinText = make_axlPinText(?number pinNumber ?offset 0:0 ?text textOrientation)
    pinObject = axlDBCreatePin(padName location pinText rotation)
    unless(pinObject
      error("Unable to create pin %s with padstack %s\\n" pinNumber padName)
    )
    pinObject
  )
)

procedure(e2a_build()
  let((padObj textOrientation statusPort)
    axlDBChangeDesignUnits("millimeters" 4)
${extents}
${definitions}
${pins}
${lines}
${circles}
${assemblyOutline}
    textOrientation = make_axlTextOrientation(
      ?textBlock "1"
      ?rotation 0.0
      ?justify "center"
      ?mirrored nil
    )
    ; 标签（REF DES / COMPONENT VALUE）与 ASSEMBLY 层轮廓的生成依据见
    ; footprintLabels / assemblyOutlineCommands 的注释（r0603.dra 真机 dump 对比）。
    ; REF DES 占位文本取值规则（P17 实测）："REF**" 在 REF DES 类层非法 —— 触发
    ; ERROR(SPMHUT-1) Illegal character(s)，进而 create symbol 报 SPMHCS-1
    ; "Symbol is missing a refdes" 并中止；纯文本 "REF" 与官方示例的 "XXXXX" 均可通过。
${labelCommands(labels)}
    ; axlDBRefresh 在 Allegro 17.4 中未定义（22.x 才有），批处理下报
    ; "eval: undefined function" 并中断 e2a_build，导致 build-status.txt 缺失；
    ; 加 isCallable 守卫后既兼容旧版又不依赖它。
    when(isCallable('axlDBRefresh) axlDBRefresh())
    statusPort = outfile(${skillString(buildStatusPath)})
    unless(statusPort
      error("Unable to open build status report\\n")
    )
    fprintf(statusPort "status=ok\\n")
    fprintf(statusPort "pins=${allPads.length}\\n")
    close(statusPort)
    t
  )
)

procedure(e2a_verify()
  let((port pins pin)
    port = outfile(${skillString(verificationPath)})
    unless(port
      error("Unable to open verification report\\n")
    )
    pins = nil
    axlExtractMap(
      "cpad_bv"
      lambda((dbid cpad)
        case(dbid->objType
          ("pin" push(dbid pins))
        )
      )
    )
    fprintf(port "symbol=${footprint.info.targetPackageName}\\n")
    fprintf(port "pins=%d\\n" length(pins))
    foreach(pin pins
      fprintf(port "pin=%s|%.5f|%.5f\\n" pin->number car(pin->xy) cadr(pin->xy))
    )
    close(port)
    t
  )
)
`;
};

const buildScriptSource = (
  symbolName: string,
  jobDirectory: string,
  skillPath: string,
): string => `setwindow pcb
new
newdrawfillin ${skillString(join(jobDirectory, `${symbolName}.dra`))} "Package Symbol" YES
skill load(${skillString(skillPath)})
skill e2a_build()
save_as ${skillString(join(jobDirectory, `${symbolName}.dra`))}
create symbol
fillin ${skillString(join(jobDirectory, `${symbolName}.psm`))}
exit
fillin no
`;

const verifyScriptSource = (
  skillPath: string,
): string => `setwindow pcb
skill load(${skillString(skillPath)})
skill e2a_verify()
exit
`;

export const createAllegroSourceBundle = (
  plan: ConversionPlan,
  jobDirectory: string,
): AllegroSourceBundle => {
  const symbolName = basename(plan.footprint.info.targetPackageName);
  const skillPath = join(jobDirectory, "build.il");
  const verificationPath = join(jobDirectory, "verification.txt");
  const buildStatusPath = join(jobDirectory, "build-status.txt");
  // axlPadstackToDisk 按 padstack 名写盘（P8 实测）：.pad 落在作业目录根且文件名强制小写。
  const padstackFiles = uniquePadstacks([
    ...plan.footprint.pads,
    ...plan.footprint.holes.map((hole, index) => ({
      number: `MH${index + 1}`,
      center: hole.center,
      width: hole.diameter + 0.5,
      height: hole.diameter + 0.5,
      rotation: 0,
      shape: "circle" as const,
      polygon: [],
      plated: false,
      holeWidth: hole.diameter,
      holeHeight: hole.diameter,
      sourceLayerId: 11,
    })),
  ]).map((pad) => `${derivePadstackName(pad).toLowerCase()}.pad`);
  return {
    symbolName,
    sources: [
      {
        relativePath: "build.il",
        content: buildSkillSource(
          plan,
          verificationPath,
          buildStatusPath,
        ),
      },
      {
        relativePath: "build.scr",
        content: buildScriptSource(symbolName, jobDirectory, skillPath),
      },
      {
        relativePath: "verify.scr",
        content: verifyScriptSource(skillPath),
      },
      {
        relativePath: "conversion-plan.json",
        content: `${JSON.stringify(plan, null, 2)}\n`,
      },
    ],
    expectedOutputs: [`${symbolName}.dra`, `${symbolName}.psm`, ...padstackFiles],
  };
};
