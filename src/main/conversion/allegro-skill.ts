import { basename, join } from "node:path";
import type {
  ConversionPlan,
  NormalizedCircle,
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

// 空 drawing 的 extents 为 nil：axlDBCreatePin 会报 "Pin is outside of the extents"
// 而失败（P9-P12 实测，与 SKILL 加载、坐标大小、对象顺序均无关；P12 证明
// axlDBChangeDesignExtents 后立刻可建 pin）。因此创建任何引脚前必须显式给出
// 绘制范围：按 footprint bounds 外扩 max(2mm, 20%) 以覆盖焊盘外沿与 1 脚标记。
const designExtentsCommand = (bounds: {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}): string => {
  const width = Math.abs(bounds.maxX - bounds.minX);
  const height = Math.abs(bounds.maxY - bounds.minY);
  const margin = Math.max(2, width * 0.2, height * 0.2);
  return `    axlDBChangeDesignExtents(list(${number(bounds.minX - margin)}:${number(bounds.minY - margin)} ${number(bounds.maxX + margin)}:${number(bounds.maxY + margin)}))`;
};
// axlDBCreateCircle(l_location [f_width] [t_layer] [o_parent]) —— Cadence SKILL
// Reference: l_location 为 (X:Y R)，即中心点与半径必须包进同一个 list；第二个
// 位置参数是圆边线宽。2026-10-15 实测（P15/E2E4）：把中心/半径拆成两个独立位置
// 参数时 Allegro 对首参做 caar 解包得到标量，报
// "car: argument #1 should be a list (type template = "l") - -3.05" 并中断
// e2a_build；此前把 radius/width 一起塞进首参、并省略线宽同样是错的。
const circleCommand = (circle: NormalizedCircle): string =>
  `  axlDBCreateCircle(list(${point(circle.center)} ${number(circle.radius)}) ${number(circle.width)} ${skillString(circleLayerName(circle))})`;

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
  const extents = designExtentsCommand(footprint.bounds);
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
    textOrientation = make_axlTextOrientation(
      ?textBlock "1"
      ?rotation 0.0
      ?justify "center"
      ?mirrored nil
    )
    ; REF DES 占位文本的取值规则（P17 实测, 2026-10-15）：
    ; "REF**" 在 REF DES 类层上非法 —— 触发 ERROR(SPMHUT-1) Illegal character(s)，
    ; 进而 create symbol 报 SPMHCS-1 "Symbol is missing a refdes" 并中止；
    ; 同一字符串在 PACKAGE GEOMETRY 层合法，说明限制来自 REF DES 类的取值校验。
    ; 纯文本 "REF" 与官方示例的 "XXXXX" 均可通过。
    axlDBCreateText("REF" 0:0 textOrientation "REF DES/SILKSCREEN_TOP")
    axlDBCreateText("REF" 0:0 textOrientation "REF DES/ASSEMBLY_TOP")
    axlDBCreateText(${skillString(footprint.info.targetPackageName)} 0:${number(footprint.bounds.minY - 1)} textOrientation "PACKAGE GEOMETRY/ASSEMBLY_TOP")
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
