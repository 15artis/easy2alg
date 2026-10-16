import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import type {
  LocalLibraryDeviceSummary,
  NormalizedCircle,
  NormalizedFootprint,
  NormalizedLine,
  NormalizedPad,
  NormalizedSymbol,
  NormalizedSymbolPin,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
  PadShape,
  Point,
  SymbolPinType,
} from "../../shared/schemas";
import {
  LocalLibraryDeviceSummarySchema,
  NormalizedFootprintSchema,
  NormalizedSymbolSchema,
} from "../../shared/schemas";
import { computeBounds, enlargePin1Markers, roundMm } from "../conversion/geometry";
import { deriveTargetPackageName } from "../conversion/naming";
import {
  translateSymbolShape,
  translateSymbolPoint,
} from "../../shared/symbol-edit";
import { writeLog } from "../logging";

/**
 * 立创EDA专业版本地库（.elibz2）连接器：不经过在线 C 编号接口，
 * 直接把库归档内的封装文档映射为 NormalizedFootprint，复用既有转换管线。
 *
 * .elibz2 是 zip 归档，内部包含：
 *  - device2.json：器件索引（devices/symbols/footprints 三个表）
 *  - *.elibu：EasyEDA Pro V3 行式日志文档，每行 = `META||DATA|`，
 *    行首 META 为 {"type":...,"ticket":...,"id":...}，行尾可能带一个多余的 `|`。
 *
 * 坐标约定（重要，勿"统一"掉）：
 *  - Pro 库文档坐标单位是 mil（39.3701 mil = 1 mm，已用 FCBGA-676 1.0mm 间距实测确认）；
 *  - Pro 库文档 **Y 轴向上**：BGA 行号 A→B→C 自上而下递增时 y 递减
 *    （实测 A1 y=+492.13 > B1 y=+452.76 > C1 y=+413.39），与 Allegro 一致，
 *    因此映射时 **Y 不取反**。
 *    注意：这与标准版链路（normalize.ts 的 normalizePoint，Y 取反）方向相反。
 */

const PRO_MIL_MM = 0.0254;
const MIL_ROUNDING_TOLERANCE = 0.001;

const mil2mm = (value: number): number => roundMm(value * PRO_MIL_MM);

type ElibuHead = { type: string; ticket?: number; id?: unknown };
type ElibuLine = { head: ElibuHead; data: Record<string, unknown> | null };
type ElibuDoc = { head: ElibuHead; meta: Record<string, unknown> | null; lines: ElibuLine[] };

type DeviceEntry = {
  uuid: string;
  attributes?: Record<string, string>;
  title?: string;
  description?: string;
  display_title?: string;
};

const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseElibuLines = (text: string): readonly ElibuLine[] => {
  const lines: ElibuLine[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const separatorIndex = line.indexOf("||");
    if (separatorIndex < 0) {
      continue;
    }
    let dataText = line.slice(separatorIndex + 2);
    while (dataText.endsWith("|")) {
      dataText = dataText.slice(0, -1);
    }
    const data =
      dataText.length > 0 ? (JSON.parse(dataText) as Record<string, unknown>) : null;
    lines.push({ head: JSON.parse(line.slice(0, separatorIndex)) as ElibuHead, data });
  }
  return lines;
};

const splitElibuDocs = (lines: readonly ElibuLine[]): readonly ElibuDoc[] => {
  const docs: ElibuDoc[] = [];
  let current: ElibuDoc | null = null;
  for (const line of lines) {
    if (line.head.type === "DOCHEAD") {
      current = { head: line.head, meta: null, lines: [] };
      docs.push(current);
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.head.type === "META") {
      current.meta = line.data;
    }
    current.lines.push(line);
  }
  return docs;
};

// Pro 封装文档图层 id（由库文档 LAYER 行实测，PEX8748 样例）：
// 1=TOP 2=BOTTOM 3=TOP_SILK 4=BOT_SILK 5/6=SOLDER_MASK 7/8=PASTE_MASK
// 9/10=ASSEMBLY 11=OUTLINE 12=MULTI
const proLayerKind = (
  layerId: number,
): "silkscreen" | "assembly" | "documentation" => {
  if (layerId === 3 || layerId === 4) {
    return "silkscreen";
  }
  if (layerId === 9 || layerId === 10) {
    return "assembly";
  }
  return "documentation";
};

type ProCanvas = { originX: number; originY: number };

const proPoint = (rawX: number, rawY: number, canvas: ProCanvas): Point => ({
  x: mil2mm(rawX - canvas.originX),
  // Pro 库文档 Y 轴向上（见文件头注释），此处禁止取反。
  y: mil2mm(rawY - canvas.originY),
});

/**
 * 原理图符号坐标**不做单位换算**。
 *
 * 封装文档的坐标是 mil，需要 ×0.0254 变 mm；但 SYMBOL 文档的坐标是符号网格
 * 单位（1 单位 = 0.1 英寸），而 OrCAD Capture 的符号坐标恰好也是同一单位
 * （实测：两侧引脚间距 10 单位 = 0.1 英寸一步，且本机现网库里 40 脚器件的
 * 本体高 210 单位）。两边同源，直接 1:1 传递。
 */
const symbolPoint = (rawX: number, rawY: number, canvas: ProCanvas): Point => ({
  x: roundMm(rawX - canvas.originX),
  y: roundMm(rawY - canvas.originY),
});

const padShapeFromPro = (padType: unknown, widthMm: number, heightMm: number): PadShape => {
  const normalized = String(padType ?? "").toUpperCase();
  if (normalized === "ELLIPSE") {
    return Math.abs(widthMm - heightMm) < MIL_ROUNDING_TOLERANCE ? "circle" : "oval";
  }
  if (normalized === "OVAL" || normalized === "OBROUND" || normalized === "OBLONG") {
    return "oval";
  }
  if (
    normalized === "ROUND_RECT" ||
    normalized === "ROUNDRECT" ||
    normalized === "ROUNDED_RECTANGLE"
  ) {
    return "roundedRectangle";
  }
  if (normalized === "POLYGON") {
    return "polygon";
  }
  return "rectangle";
};

const extractPolygonPoints = (pad: Record<string, unknown>): Point[] => {
  const specialPads = pad.specialPad;
  if (!Array.isArray(specialPads)) {
    return [];
  }
  for (const special of specialPads) {
    if (special === null || typeof special !== "object") {
      continue;
    }
    const points = (special as Record<string, unknown>).points;
    if (!Array.isArray(points) || points.length < 6) {
      continue;
    }
    const values = points.map((item) => asNumber(item, Number.NaN));
    if (values.some((item) => !Number.isFinite(item))) {
      continue;
    }
    const polygon: Point[] = [];
    for (let index = 0; index + 1 < values.length; index += 2) {
      polygon.push({ x: mil2mm(values[index]), y: mil2mm(values[index + 1]) });
    }
    return polygon;
  }
  return [];
};

/**
 * Pro POLY.path 的结构是 [x1, y1, "L", x2, y2, ...]：
 * 数字两两成对表示坐标点，字符串表示到下一点的方式（"L"=直线）。
 * v1 仅展开直线段；弧/贝塞尔段跳过并写日志，避免静默丢图形。
 */
const polyToLines = (
  poly: Record<string, unknown>,
  canvas: ProCanvas,
  sourceLabel: string,
): readonly NormalizedLine[] => {
  const path = poly.path;
  if (!Array.isArray(path)) {
    return [];
  }
  const layer = proLayerKind(asNumber(poly.layerId, 3));
  const width = Math.max(mil2mm(asNumber(poly.width, 6)), 0.01);
  const lines: NormalizedLine[] = [];
  let pendingX: number | null = null;
  let previous: Point | null = null;
  let sawUnsupportedCommand = false;
  for (const token of path) {
    if (typeof token === "string") {
      if (token.toUpperCase() !== "L") {
        sawUnsupportedCommand = true;
      }
      continue;
    }
    const value = asNumber(token, Number.NaN);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (pendingX === null) {
      pendingX = value;
      continue;
    }
    const point = proPoint(pendingX, value, canvas);
    pendingX = null;
    if (previous !== null) {
      lines.push({ start: previous, end: point, width, layer });
    }
    previous = point;
  }
  if (sawUnsupportedCommand) {
    void writeLog("warn", "elibz2_poly_unsupported_segment", { sourceLabel });
  }
  return lines;
};

const fillToCircles = (
  fill: Record<string, unknown>,
  canvas: ProCanvas,
): readonly NormalizedCircle[] => {
  const path = fill.path;
  if (!Array.isArray(path)) {
    return [];
  }
  const layer = proLayerKind(asNumber(fill.layerId, 3));
  const circles: NormalizedCircle[] = [];
  for (const subPath of path) {
    if (!Array.isArray(subPath) || subPath.length < 4) {
      continue;
    }
    if (String(subPath[0]).toUpperCase() !== "CIRCLE") {
      void writeLog("warn", "elibz2_fill_unsupported_shape", { shape: String(subPath[0]) });
      continue;
    }
    // FILL 是实心区域（fillStyle=SOLID；fill.width 实测 0.2mil≈0.005mm，是无意义的描边宽度）。
    // 模型里的圆统一为"描边圆"(center/radius/width，与 NormalizedLine 对齐)，而 SVG 与
    // axlDBCreateCircle 的描边都居中于路径 —— 因此"半径减半的路径 + 线宽=原半径"可在预览与
    // Allegro 中得到外径不变 (R) 的实心圆盘。若按描边圆原样输出，0.01mm 发丝线宽的圆点在
    // 丝印上不可见（Allegro 侧还会触发最小线宽 DFM 告警）。
    const radius = mil2mm(asNumber(subPath[3]));
    circles.push({
      center: proPoint(asNumber(subPath[1]), asNumber(subPath[2]), canvas),
      radius: radius / 2,
      width: Math.max(radius, 0.01),
      layer,
    });
  }
  return circles;
};

const rectToLines = (
  rect: Record<string, unknown>,
  canvas: ProCanvas,
): readonly NormalizedLine[] => {
  const centerX = asNumber(rect.centerX);
  const centerY = asNumber(rect.centerY);
  const width = asNumber(rect.width);
  const height = asNumber(rect.height);
  const layer = proLayerKind(asNumber(rect.layerId, 3));
  const lineWidth = Math.max(mil2mm(asNumber(rect.strokeWidth, 6)), 0.01);
  const corners: readonly Point[] = [
    proPoint(centerX - width / 2, centerY - height / 2, canvas),
    proPoint(centerX + width / 2, centerY - height / 2, canvas),
    proPoint(centerX + width / 2, centerY + height / 2, canvas),
    proPoint(centerX - width / 2, centerY + height / 2, canvas),
  ];
  return corners.map((start, index) => ({
    start,
    end: corners[(index + 1) % corners.length],
    width: lineWidth,
    layer,
  }));
};

const synthesizeLcscId = (seed: string): string => {
  const digest = createHash("sha256").update(seed).digest("hex");
  const digits = String(parseInt(digest.slice(0, 8), 16) % 100_000_000).padStart(8, "0");
  return `C${digits}`;
};

const padCountOf = (doc: ElibuDoc): number =>
  doc.lines.filter((line) => line.head.type === "PAD").length;

const findFootprintDoc = (docs: readonly ElibuDoc[], footprintUuid: string): ElibuDoc | null => {
  const padDocs = docs.filter((doc) => padCountOf(doc) > 0);
  if (padDocs.length === 0) {
    return null;
  }
  if (padDocs.length === 1) {
    return padDocs[0];
  }
  // 多封装库：优先取 META.source 前缀与目标 uuid 匹配的文档块，否则取引脚最多的块。
  const matched = padDocs.find((doc) => {
    const source = typeof doc.meta?.source === "string" ? doc.meta.source : "";
    return source.split("|")[0] === footprintUuid;
  });
  return (
    matched ??
    [...padDocs].sort((left, right) => padCountOf(right) - padCountOf(left))[0]
  );
};

/**
 * 原理图符号（SYMBOL 文档块）解析。
 *
 * 实测结构（PEX8748 样例）：CANVAS 1 + PART 6 + PIN 676 + ATTR 2028 + RECT 6
 * + TEXT 17 + POLY 3（另有 ELE_PLACEHOLDER，仅占位计数，忽略）。
 *  - PART   ：一个 SYMBOL 文档里的每个 PART 是一"段"（Capture 的 section）；
 *             data.BBOX = [x1,y1,x2,y2]，y1/y2 是屏幕序（y1 > y2），需归一化。
 *  - PIN    ：data.x/y 是**电气连接端**；rotation 决定引脚朝本体延伸的方向，
 *             实测为顺时针：0=+x、90=-y、180=-x、270=+y，通式 (cosθ, -sinθ)。
 *             本体端 = 连接端 + length·方向（已用 RECT 边缘交叉验证）。
 *  - ATTR   ：每 PIN 恰好 3 个（Pin Name / Pin Number / Pin Type），
 *             通过 data.parentId 关联到 PIN 的 **meta.id**（如 "e15"）。
 *
 * 坐标单位与 Capture 符号单位一致（1 单位 = 10 mil）：源库引脚间距实测 10 单位
 * = 0.1 英寸网格一步，故 **不做换算、不缩放**。
 */
const symbolPinType = (raw: unknown): SymbolPinType => {
  const normalized = String(raw ?? "").trim().toUpperCase();
  switch (normalized) {
    case "IN":
    case "INPUT":
      return "input";
    case "OUT":
    case "OUTPUT":
      return "output";
    case "BI":
    case "BIDIRECTIONAL":
    case "IO":
      return "bidirectional";
    case "PWR":
    case "POWER":
    case "VCC":
    case "VDD":
    case "VSS":
    case "GND":
      return "power";
    case "OC":
    case "OPEN_COLLECTOR":
    case "OPENCOLLECTOR":
      return "openCollector";
    case "OE":
    case "OPEN_EMITTER":
    case "OPENEMITTER":
      return "openEmitter";
    case "TRISTATE":
    case "TRI":
    case "HIZ":
      return "tristate";
    case "":
      return "unspecified";
    default:
      // NC / UNDEFINED / TERMINATOR 等一律落到无源，保证一定能映射到
      // Capture 认可的类型码（见 capture-olb.ts 的 PIN_TYPE_CODE）。
      return "passive";
  }
};

/** 引脚由连接端朝本体延伸的方向：顺时针角度（与源 rotate 字段实测一致）。 */
const pinBodyDirection = (rotation: number): Point => {
  const radians = (rotation * Math.PI) / 180;
  return { x: Math.cos(radians), y: -Math.sin(radians) };
};

const translatePoint = (point: Point, dx: number, dy: number): Point => ({
  x: roundMm(point.x + dx),
  y: roundMm(point.y + dy),
});

const translateShape = translateSymbolShape;

const pinCountOf = (doc: ElibuDoc): number =>
  doc.lines.filter((line) => line.head.type === "PIN").length;

const findSymbolDoc = (docs: readonly ElibuDoc[]): ElibuDoc | null => {
  const pinDocs = docs.filter((doc) => pinCountOf(doc) > 0);
  if (pinDocs.length === 0) {
    return null;
  }
  if (pinDocs.length === 1) {
    return pinDocs[0];
  }
  // 多版本块取引脚最多者（与封装通道同一策略）。
  return [...pinDocs].sort((left, right) => pinCountOf(right) - pinCountOf(left))[0];
};

const sanitizeSymbolName = (raw: string, fallback: string): string => {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
};

const refdesPrefixFrom = (raw: unknown): string => {
  const letters = String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length > 0 ? letters : "U";
};

const parseSymbolDoc = (
  doc: ElibuDoc,
  canvas: ProCanvas,
): NormalizedSymbolSection[] => {
  const partOrder: string[] = [];
  const partBounds = new Map<string, readonly number[]>();
  const pins = new Map<string, Record<string, unknown>>();
  const pinAttributes = new Map<string, Map<string, Record<string, unknown>>>();
  const shapes = new Map<string, NormalizedSymbolShape[]>();

  const pushShape = (partId: string, shape: NormalizedSymbolShape): void => {
    const list = shapes.get(partId);
    if (list === undefined) {
      shapes.set(partId, [shape]);
      return;
    }
    list.push(shape);
  };

  for (const line of doc.lines) {
    const data = line.data;
    if (data === null) {
      continue;
    }
    switch (line.head.type) {
      case "PART": {
        const id = String(line.head.id ?? "");
        if (id.length === 0) {
          break;
        }
        partOrder.push(id);
        const bbox = data.BBOX;
        if (Array.isArray(bbox) && bbox.length >= 4) {
          partBounds.set(id, bbox.map((value) => asNumber(value)));
        }
        break;
      }
      case "PIN": {
        pins.set(String(line.head.id ?? ""), data);
        break;
      }
      case "ATTR": {
        const parentId = String(data.parentId ?? "");
        const key = String(data.key ?? "");
        if (parentId.length === 0 || key.length === 0) {
          break;
        }
        const entry = pinAttributes.get(parentId) ?? new Map<string, Record<string, unknown>>();
        entry.set(key, data);
        pinAttributes.set(parentId, entry);
        break;
      }
      case "RECT": {
        const partId = String(data.partId ?? "");
        if (partId.length === 0) {
          break;
        }
        const corner = asNumber(data.radiusX, 0);
        pushShape(partId, {
          kind: "rect",
          min: symbolPoint(asNumber(data.dotX1), asNumber(data.dotY1), canvas),
          max: symbolPoint(asNumber(data.dotX2), asNumber(data.dotY2), canvas),
          cornerRadius: corner,
          filled: data.fillColor !== null && data.fillColor !== undefined,
        });
        break;
      }
      case "POLY": {
        const partId = String(data.partId ?? "");
        const rawPoints = data.points;
        if (partId.length === 0 || !Array.isArray(rawPoints) || rawPoints.length < 2) {
          break;
        }
        const points = rawPoints.flatMap((item) => {
          if (item === null || typeof item !== "object") {
            return [];
          }
          const record = item as Record<string, unknown>;
          return [symbolPoint(asNumber(record.x), asNumber(record.y), canvas)];
        });
        if (points.length < 2) {
          break;
        }
        pushShape(partId, {
          kind: "polyline",
          points,
          closed: data.closed === true,
        });
        break;
      }
      case "TEXT": {
        const partId = String(data.partId ?? "");
        const text = String(data.value ?? "").trim();
        if (partId.length === 0 || text.length === 0) {
          break;
        }
        pushShape(partId, {
          kind: "text",
          text,
          at: symbolPoint(asNumber(data.x), asNumber(data.y), canvas),
          rotation: asNumber(data.rotation, 0),
          // 源 fontSize 为符号单位；缺省 12 与样例中的小标注一致。
          height: Math.max(asNumber(data.fontSize, 12), 1),
        });
        break;
      }
      default:
        break;
    }
  }

  return partOrder.map((partId) => {
    const partShapes = shapes.get(partId) ?? [];
    const sectionPins: NormalizedSymbolPin[] = [];
    for (const [pinId, pin] of pins) {
      if (String(pin.partId ?? "") !== partId) {
        continue;
      }
      const attrs = pinAttributes.get(pinId);
      const connection = symbolPoint(asNumber(pin.x), asNumber(pin.y), canvas);
      const length = asNumber(pin.length, 0);
      const direction = pinBodyDirection(asNumber(pin.rotation, 0));
      const number = String(attrs?.get("Pin Number")?.value ?? "").trim();
      sectionPins.push({
        name: String(attrs?.get("Pin Name")?.value ?? "").trim(),
        // 极少数器件不给引脚号：用段内序号兜底，避免 OLB 里出现空脚号。
        number: number.length > 0 ? number : `${partId}#${sectionPins.length + 1}`,
        connection,
        body: {
          x: roundMm(connection.x + length * direction.x),
          y: roundMm(connection.y + length * direction.y),
        },
        length,
        type: symbolPinType(attrs?.get("Pin Type")?.value),
        visible: pin.display !== false,
      });
    }

    const xs: number[] = [];
    const ys: number[] = [];
    for (const shape of partShapes) {
      if (shape.kind === "rect") {
        xs.push(shape.min.x, shape.max.x);
        ys.push(shape.min.y, shape.max.y);
      } else if (shape.kind === "polyline") {
        for (const point of shape.points) {
          xs.push(point.x);
          ys.push(point.y);
        }
      } else {
        xs.push(shape.at.x);
        ys.push(shape.at.y);
      }
    }
    // 本体包围盒也要覆盖引脚：否则"引脚比本体大"的符号会被裁掉引脚。
    for (const pin of sectionPins) {
      xs.push(pin.connection.x, pin.body.x);
      ys.push(pin.connection.y, pin.body.y);
    }
    // 源 BBOX 是屏幕序 [x1,y1,x2,y2]（y1 > y2），直接取 min/max 归一化。
    const bbox = partBounds.get(partId);
    if (bbox !== undefined && bbox.length >= 4) {
      xs.push(bbox[0], bbox[2]);
      ys.push(bbox[1], bbox[3]);
    }
    const bounds =
      xs.length === 0 || ys.length === 0
        ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
        : {
            minX: roundMm(Math.min(...xs)),
            minY: roundMm(Math.min(...ys)),
            maxX: roundMm(Math.max(...xs)),
            maxY: roundMm(Math.max(...ys)),
          };

    // OrCAD 本体锚点约定：真实库里 201/211 个器件的本体矩形左下角正好落在 (0,0)。
    // Capture 符号编辑器 y 轴向下，所以屏幕上就是"本体左上角在原点、本体向右下铺开"。
    // 源数据的本体以原点为中心（PEX8748 为 ±190/±155），不换算的话整个符号会
    // 偏在编辑器左上角（用户 2026-10-16 反馈"需要往右往下调整、居中显示"）。
    // 注意取的是**本体 RECT**的原点而非整体 bounds：真实库的左右引脚伸到 x<0 是正常的。
    const bodyRect = partShapes.find((shape) => shape.kind === "rect");
    const anchorX =
      bodyRect === undefined ? bounds.minX : Math.min(bodyRect.min.x, bodyRect.max.x);
    const anchorY =
      bodyRect === undefined ? bounds.minY : Math.min(bodyRect.min.y, bodyRect.max.y);
    const dx = -anchorX;
    const dy = -anchorY;

    return {
      name: partId,
      bounds: {
        minX: roundMm(bounds.minX + dx),
        minY: roundMm(bounds.minY + dy),
        maxX: roundMm(bounds.maxX + dx),
        maxY: roundMm(bounds.maxY + dy),
      },
      pins: sectionPins.map((pin) => ({
        ...pin,
        connection: translatePoint(pin.connection, dx, dy),
        body: translatePoint(pin.body, dx, dy),
      })),
      shapes: partShapes.map((shape) => translateShape(shape, dx, dy)),
    };
  });
};

const readArchive = async (
  filePath: string,
): Promise<{ devices: Record<string, DeviceEntry>; elibuText: string }> => {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Error(`无法读取本地库文件 ${filePath}：${cause.message}`);
  }
  const entries = zip.getEntries();
  const deviceEntry = entries.find(
    (entry) => !entry.isDirectory && entry.name.toLowerCase() === "device2.json",
  );
  const elibuEntry = entries.find(
    (entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".elibu"),
  );
  if (deviceEntry === undefined || elibuEntry === undefined) {
    throw new Error(
      "文件结构不是有效的立创EDA专业版库归档（缺少 device2.json 或 .elibu）。",
    );
  }
  const parsed = JSON.parse(zip.readAsText(deviceEntry)) as {
    devices?: Record<string, DeviceEntry>;
  };
  return { devices: parsed.devices ?? {}, elibuText: zip.readAsText(elibuEntry) };
};

export class Elibz2Connector {
  async readLibrary(filePath: string): Promise<readonly LocalLibraryDeviceSummary[]> {
    const { devices, elibuText } = await readArchive(filePath);
    const docs = splitElibuDocs(parseElibuLines(elibuText));
    const summaries: LocalLibraryDeviceSummary[] = [];
    for (const device of Object.values(devices)) {
      const attributes = device.attributes ?? {};
      const footprintUuid = String(attributes.Footprint ?? "");
      const doc = footprintUuid.length > 0 ? findFootprintDoc(docs, footprintUuid) : null;
      if (doc === null) {
        continue;
      }
      const rawLcscId = String(attributes["Supplier Part"] ?? "").toUpperCase();
      summaries.push(
        LocalLibraryDeviceSummarySchema.parse({
          deviceUuid: device.uuid,
          lcscId: /^C\d+$/.test(rawLcscId) ? rawLcscId : synthesizeLcscId(device.uuid),
          name: String(
            attributes["LCSC Part Name"] ?? device.display_title ?? device.title ?? device.uuid,
          ),
          manufacturer: String(attributes["Manufacturer"] ?? ""),
          manufacturerPartNumber: String(attributes["Manufacturer Part"] ?? ""),
          footprintTitle: String(doc.meta?.title ?? device.title ?? ""),
          padCount: padCountOf(doc),
          sourcePath: filePath,
        }),
      );
    }
    return summaries;
  }

  async loadFootprint(filePath: string, deviceUuid: string): Promise<NormalizedFootprint> {
    const { devices, elibuText } = await readArchive(filePath);
    const device = devices[deviceUuid];
    if (device === undefined) {
      throw new Error(`本地库中未找到器件 ${deviceUuid}`);
    }
    const attributes = device.attributes ?? {};
    const footprintUuid = String(attributes.Footprint ?? "");
    const docs = splitElibuDocs(parseElibuLines(elibuText));
    const doc = findFootprintDoc(docs, footprintUuid);
    if (doc === null) {
      throw new Error(`器件 ${deviceUuid} 在本地库中没有可转换的封装数据`);
    }

    const canvasLine = doc.lines.find((line) => line.head.type === "CANVAS");
    const canvas: ProCanvas = {
      originX: asNumber(canvasLine?.data?.originX, 0),
      originY: asNumber(canvasLine?.data?.originY, 0),
    };

    const pads: NormalizedPad[] = [];
    const holes: NormalizedFootprint["holes"] = [];
    let mechanicalIndex = 0;
    for (const line of doc.lines) {
      if (line.head.type !== "PAD" || line.data === null) {
        continue;
      }
      const pad = line.data;
      const defaultPad = (pad.defaultPad ?? {}) as Record<string, unknown>;
      const widthMm = mil2mm(asNumber(defaultPad.width, 0));
      const heightMm = mil2mm(asNumber(defaultPad.height, 0));
      const hole = (pad.hole ?? null) as Record<string, unknown> | null;
      const number = String(pad.num ?? "").trim();
      const holeDiameterMm =
        hole === null ? 0 : mil2mm(asNumber(hole.holeD ?? hole.holeDiameter ?? hole.diameter, 0));
      if (hole !== null && number.length === 0 && holeDiameterMm > 0) {
        // 无编号的纯机械孔 → holes
        holes.push({
          center: proPoint(asNumber(pad.centerX), asNumber(pad.centerY), canvas),
          diameter: holeDiameterMm,
        });
        continue;
      }
      const holeLengthMm =
        hole === null ? 0 : mil2mm(asNumber(hole.holeLen ?? hole.holeLength ?? 0, 0));
      const shape = padShapeFromPro(defaultPad.padType, widthMm, heightMm);
      pads.push({
        number: number.length > 0 ? number : `M${(mechanicalIndex += 1)}`,
        center: proPoint(asNumber(pad.centerX), asNumber(pad.centerY), canvas),
        width: widthMm,
        height: heightMm,
        // Pro 的 padAngle 旋转方向未做符号验证（本样例库全为 0），直传；
        // 若后续带角度封装出现镜像，再对照标准版 normalize 的 -rotation 约定修正。
        rotation: roundMm(asNumber(pad.padAngle, 0)),
        shape,
        polygon: shape === "polygon" ? extractPolygonPoints(pad) : [],
        plated: hole === null ? true : hole.plated !== false,
        holeWidth: holeDiameterMm,
        holeHeight: Math.max(holeLengthMm, holeDiameterMm),
        sourceLayerId: asNumber(pad.layerId, 1),
      });
    }

    const lines: NormalizedLine[] = [];
    const circles: NormalizedCircle[] = [];
    const sourceLabel = String(doc.meta?.title ?? deviceUuid);
    for (const line of doc.lines) {
      if (line.data === null) {
        continue;
      }
      if (line.head.type === "POLY") {
        lines.push(...polyToLines(line.data, canvas, sourceLabel));
      } else if (line.head.type === "RECT") {
        lines.push(...rectToLines(line.data, canvas));
      } else if (line.head.type === "FILL") {
        circles.push(...fillToCircles(line.data, canvas));
      }
    }
    // FILL 圆点在本例中就是 pin-1 角标，源尺寸 0.6mm 在大器件上不可见（见
    // geometry.enlargePin1Markers 注释）。放大后再算 bounds，预览与实机一致。
    const visibleCircles = enlargePin1Markers(circles, pads);

    const rawLcscId = String(attributes["Supplier Part"] ?? "").toUpperCase();
    const lcscId = /^C\d+$/.test(rawLcscId) ? rawLcscId : synthesizeLcscId(device.uuid);
    const sourcePackageName = String(
      doc.meta?.title ?? device.title ?? `LOCAL-${deviceUuid.slice(0, 8)}`,
    );
    const extraPoints: readonly Point[] = [
      ...lines.flatMap((line) => [line.start, line.end]),
      ...visibleCircles.flatMap((circle) => [
        {
          x: circle.center.x - circle.radius - circle.width / 2,
          y: circle.center.y - circle.radius - circle.width / 2,
        },
        {
          x: circle.center.x + circle.radius + circle.width / 2,
          y: circle.center.y + circle.radius + circle.width / 2,
        },
      ]),
      ...holes.map((hole) => hole.center),
    ];
    const footprint: NormalizedFootprint = {
      info: {
        lcscId,
        name: String(
          attributes["LCSC Part Name"] ?? device.display_title ?? device.title ?? lcscId,
        ),
        manufacturer: String(attributes["Manufacturer"] ?? ""),
        manufacturerPartNumber: String(attributes["Manufacturer Part"] ?? ""),
        sourcePackageName,
        targetPackageName: deriveTargetPackageName(sourcePackageName, pads),
        assemblyProcess:
          holes.length > 0 || pads.some((pad) => pad.holeWidth > 0) ? "THT" : "SMT",
        description: String(device.description ?? ""),
      },
      pads,
      holes,
      lines,
      circles: visibleCircles,
      sourceOrigin: { x: canvas.originX, y: canvas.originY },
      bounds: computeBounds(pads, extraPoints),
      model3d: null,
      sourceJson: JSON.stringify({
        source: "elibz2",
        filePath,
        device,
        docTicket: doc.head.ticket ?? null,
        docMeta: doc.meta,
      }),
    };
    return NormalizedFootprintSchema.parse(footprint);
  }

  /**
   * 读取器件的原理图符号（SYMBOL 文档块）。库中没有符号数据时返回 null，
   * 调用方应跳过 OLB 生成而不是报错 —— 标准版链路（C 编号）本来就只有封装。
   */
  async loadSymbol(filePath: string, deviceUuid: string): Promise<NormalizedSymbol | null> {
    const { devices, elibuText } = await readArchive(filePath);
    const device = devices[deviceUuid];
    if (device === undefined) {
      throw new Error(`本地库中未找到器件 ${deviceUuid}`);
    }
    const docs = splitElibuDocs(parseElibuLines(elibuText));
    const doc = findSymbolDoc(docs);
    if (doc === null) {
      return null;
    }
    const canvasLine = doc.lines.find((line) => line.head.type === "CANVAS");
    const canvas: ProCanvas = {
      originX: asNumber(canvasLine?.data?.originX, 0),
      originY: asNumber(canvasLine?.data?.originY, 0),
    };
    const sections = parseSymbolDoc(doc, canvas).filter(
      (section) => section.pins.length > 0 || section.shapes.length > 0,
    );
    if (sections.length === 0) {
      return null;
    }

    // 封装名沿用封装通道的推导结果，保证 OLB 里的 PCB Footprint 字段与
    // 实际生成的 .dra 同名；封装不可读时退化为空串（不阻塞符号生成）。
    let pcbFootprint = "";
    try {
      pcbFootprint = (await this.loadFootprint(filePath, deviceUuid)).info.targetPackageName;
    } catch (error) {
      await writeLog("warn", "elibz2_symbol_footprint_link_failed", {
        filePath,
        deviceUuid,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const attributes = device.attributes ?? {};
    const fallbackName = `SYM_${deviceUuid.slice(0, 8)}`;
    const symbol: NormalizedSymbol = {
      name: sanitizeSymbolName(
        String(
          device.display_title ??
            device.title ??
            attributes["Manufacturer Part"] ??
            fallbackName,
        ),
        fallbackName,
      ),
      refdesPrefix: refdesPrefixFrom(attributes.Designator),
      pcbFootprint,
      sections,
      sourceJson: JSON.stringify({
        source: "elibz2-symbol",
        filePath,
        deviceUuid,
        docTicket: doc.head.ticket ?? null,
        sectionNames: sections.map((section) => section.name),
      }),
    };
    return NormalizedSymbolSchema.parse(symbol);
  }
}
