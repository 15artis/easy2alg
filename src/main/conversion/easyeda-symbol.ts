import { z } from "zod";
import type {
  NormalizedSymbol,
  NormalizedSymbolPin,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
  Point,
  SymbolPinType,
  SymbolShapePrimitive,
} from "../../shared/schemas";
import { NormalizedSymbolSchema } from "../../shared/schemas";
import { avoidLabelOverlapInSection } from "../../shared/symbol-layout";
import {
  attachPinLabelAnchors,
  bodyBoxOf,
  DEFAULT_SYMBOL_TEXT_HEIGHT,
  sectionLabelsCollide,
} from "../../shared/symbol-labels";
import { alignPinsToGrid, alignPinEndsToGrid } from "../../shared/symbol-layout";
import { dedupePinNames } from "../../shared/symbol-normalize";
import { transformSymbolPrimitive } from "../../shared/symbol-edit";
import { cleanSymbolName, refdesPrefixFrom, sanitizeSymbolName } from "./naming";

/**
 * 立创编号（在线 EasyEDA **标准版**）链路里的原理图符号解析。
 *
 * 数据就在 `result.dataStr` 里 —— 和 PCB 封装同一次接口响应（`packageDetail.dataStr`
 * 是封装），所以**不需要额外请求**，只是过去没用它（用户 2026-10-16 反馈
 * "搜索的器件没出现原理图符号，实际是有符号的"）。
 *
 * 行式格式（用 C2040/RP2040、C7955/LM393 两个真实响应逐字段核对过）：
 *
 *   引脚 P~show~<电气类型>~<脚号>~<x>~<y>~<旋转>~<id>~<locked>
 *        ^^ <x>~<y>
 *        ^^ <SVG 路径>~<颜色>                    ← 从自由端往本体画，如 `M 525 230 h -10`
 *        ^^ 1~<x>~<y>~<旋转>~<引脚名>~...        ← 名字文字（下标 4 才是文本）
 *        ^^ 1~<x>~<y>~<旋转>~<脚号>~...          ← 脚号文字
 *        ^^ 0~<x>~<y>
 *        ^^ 0~<时钟/箭头路径>
 *
 *   矩形 R~<x>~<y>~<圆角x>~<圆角y>~<宽>~<高>~<描边色>~<描边宽>~<填充>~<id>~<locked>
 *   椭圆 E~<cx>~<cy>~<rx>~<ry>~<描边色>~<描边宽>~<填充>~<填充色>~<id>~<locked>
 *   文本 T~<对齐>~<x>~<y>~<旋转>~<色>~<字体>~<字号>~...~<类型>~<文本>~...
 *
 * 坐标约定（重要）：
 *  - **单位不换算**：源符号单位就是 Capture 符号单位（1 单位 = 10 mil），
 *    引脚间距 10、引脚长 10，与 Capture 库一致，和封装通道的 mil→mm 无关。
 *  - **y 轴不翻转**：EasyEDA 画布 y 向下，Capture 符号编辑器 y 也向下（见
 *    symbol-labels.ts 的说明），两边一致。
 *  - 本体锚点同样归零：本体 RECT 的 min 角平移到 (0,0)（现网库 201/211 个器件如此）。
 */

const ELECTRIC_PIN_TYPE: Readonly<Record<string, SymbolPinType>> = {
  // 实测：C2040 的 RUN/XIN = 1、QSPI_SCLK/SWCLK = 2、GPIO 与电源 = 3、
  // LM393 全部 = 0。按 EasyEDA 电气类型下拉顺序映射，未定义/缺省落 unspecified。
  "0": "unspecified",
  "1": "input",
  "2": "output",
  "3": "bidirectional",
  "4": "passive",
  "5": "openCollector",
  "6": "openEmitter",
  "7": "tristate",
};

/** 引脚自由端在哪个方向：旋转角 → 外向法线。实测 0=右侧 90=上 180=左 270=下。 */
const outwardOf = (rotation: number): Point => {
  const radians = (rotation * Math.PI) / 180;
  return { x: Math.round(Math.cos(radians)), y: Math.round(-Math.sin(radians)) };
};

const PIN_LENGTH_PATTERN = /^\s*M\s*[-\d.]+\s+[-\d.]+\s*([hv])\s*(-?[\d.]+)/i;

/** 引脚长度：直接量 `M x y h ±len` / `v ±len`，拿不到就退化成 10（EasyEDA 默认）。 */
const pinLengthFrom = (path: string): number => {
  const match = PIN_LENGTH_PATTERN.exec(path);
  if (match === null) {
    return 10;
  }
  const length = Math.abs(Number(match[2]));
  return Number.isFinite(length) && length > 0 ? length : 10;
};

const numberOr = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ELLIPSE_STEPS = 24;

const ellipsePoints = (cx: number, cy: number, rx: number, ry: number): Point[] =>
  Array.from({ length: ELLIPSE_STEPS }, (_, index) => {
    const angle = (index / ELLIPSE_STEPS) * Math.PI * 2;
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });

/** `PL~x1 y1 x2 y2 …~色~宽~…` 折线 */
const polylinePoints = (raw: string): Point[] =>
  raw
    .split("~")[1]
    ?.trim()
    .split(/\s+/)
    .reduce<Point[]>((points, token, index, all) => {
      if (index % 2 === 0) {
        const x = Number(token);
        const y = Number(all[index + 1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          points.push({ x, y });
        }
      }
      return points;
    }, []) ?? [];

/** 路径里的一个子环（`M … Z` 一段）。一条 `PT` 可能有多段，各自独立成图形。 */
type PathRing = { readonly points: Point[]; readonly closed: boolean };

/** 连没见过的命令字母一起切开：认不出来就停手，不能把它的参数当上一个命令的续参 */
const PATH_TOKEN_PATTERN = /[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
/** 曲线采样段数：符号尺度下 16 段的弦高误差 < r/30，远小于 1 个库单位。 */
const PATH_CURVE_STEPS = 16;

const quadraticAt = (p0: Point, p1: Point, p2: Point, t: number): Point => {
  const k = 1 - t;
  return {
    x: k * k * p0.x + 2 * k * t * p1.x + t * t * p2.x,
    y: k * k * p0.y + 2 * k * t * p1.y + t * t * p2.y,
  };
};

const cubicAt = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
  const k = 1 - t;
  const a = k * k * k;
  const b = 3 * k * k * t;
  const c = 3 * k * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
};

/**
 * 多边形路径 `PT~M x y L x y Z~色~宽~…` → 一组折线环。
 *
 * 用户 2026-11-10 报「创建的预览有问题」（C3699281 / SACB5.0 的 TVS 符号）：
 * 二极管的两个三角形在源数据里是 `PT` 路径，解析器只认 P/R/E/C/PL/A/T，
 * `PT` 落进 default 被静默丢弃 —— 预览和写进 .olb 的符号都少了两个三角形，
 * 只剩引脚、稳压条和两段连线。和之前漏掉 `A` 弧是同一类问题。
 *
 * 命令集按符号里实际出现的情况取 M/L/H/V/Z + C/Q（曲线采样），
 * 遇到没见过的命令直接停止解析该路径，宁可少画也不要画错。
 */
const pathRings = (raw: string): PathRing[] => {
  const tokens = raw.match(PATH_TOKEN_PATTERN) ?? [];
  const rings: PathRing[] = [];
  let points: Point[] = [];
  let closed = false;
  let cursor: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let index = 0;
  /** 当前生效的命令；参数批次读完后保持不变（`M 1 2 3 4` 的后续坐标对是 L） */
  let letter = "";

  const flush = (): void => {
    if (points.length >= 2) {
      rings.push({ points, closed });
    }
    points = [];
    closed = false;
  };
  const take = (): number => {
    const value = Number(tokens[index]);
    index += 1;
    return Number.isFinite(value) ? value : 0;
  };

  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (/^[A-Za-z]$/.test(token)) {
      index += 1;
      if (token === "Z" || token === "z") {
        // 闭合由 closed 标记表达：写 .olb 时补首点、预览时画 Z，都不在数据里重复存首点
        closed = true;
        flush();
        cursor = { ...subpathStart };
        letter = "";
        continue;
      }
      if ("MmLlHhVvCcQq".includes(token)) {
        letter = token;
        continue;
      }
      // 没见过的命令：后面的参数无从解释，整条路径就此打住
      break;
    }
    if (letter === "") {
      index += 1;
      continue;
    }
    const relative = letter !== letter.toUpperCase();
    const base = relative ? cursor : { x: 0, y: 0 };
    switch (letter.toUpperCase()) {
      case "M": {
        flush();
        const x = take() + base.x;
        const y = take() + base.y;
        cursor = { x, y };
        subpathStart = { x, y };
        points = [{ x, y }];
        // SVG 语义：M 之后成对的坐标是隐式 L
        letter = relative ? "l" : "L";
        break;
      }
      case "L": {
        const x = take() + base.x;
        const y = take() + base.y;
        cursor = { x, y };
        points.push({ x, y });
        break;
      }
      case "H": {
        const x = take() + (relative ? cursor.x : 0);
        cursor = { x, y: cursor.y };
        points.push({ ...cursor });
        break;
      }
      case "V": {
        const y = take() + (relative ? cursor.y : 0);
        cursor = { x: cursor.x, y };
        points.push({ ...cursor });
        break;
      }
      case "Q": {
        const control = { x: take() + base.x, y: take() + base.y };
        const end = { x: take() + base.x, y: take() + base.y };
        for (let step = 1; step <= PATH_CURVE_STEPS; step += 1) {
          points.push(quadraticAt(cursor, control, end, step / PATH_CURVE_STEPS));
        }
        cursor = end;
        break;
      }
      case "C": {
        const control1 = { x: take() + base.x, y: take() + base.y };
        const control2 = { x: take() + base.x, y: take() + base.y };
        const end = { x: take() + base.x, y: take() + base.y };
        for (let step = 1; step <= PATH_CURVE_STEPS; step += 1) {
          points.push(cubicAt(cursor, control1, control2, end, step / PATH_CURVE_STEPS));
        }
        cursor = end;
        break;
      }
      default:
        break;
    }
  }
  flush();
  return rings;
};

/**
 * 圆弧 `A~M x0 y0 A rx ry rot large sweep x1 y1~…` → 折线采样。
 *
 * 用户 2026-11-10 反馈「生成的原理符号四周没有合拢，应该半圆有问题」：
 * DSUB 这类符号的本体四角就是 4 条 `A` 弧（源数据 C141882 实测），
 * 而解析器原先只认 P/R/E/C/PL/T —— 圆弧整条被丢掉，于是四角全部缺口。
 *
 * 语义与 SVG 的 `A` 命令完全一致（EasyEDA 符号坐标 y 向下，与 SVG 同向，
 * sweep 不需要取反）。Capture 符号只有 Line/Rect/CommentText，没有圆弧图元，
 * 所以按弧长采样成折线（90° 圆角 6~8 段，肉眼看不出折线）。
 */
const ARC_PATTERN =
  /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*A\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([01])[\s,]+([01])[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)/i;

/** 一条 `A` 弧：折线采样点（预览用）+ 原生弧参数（写库用）。 */
type ArcGeometry = {
  readonly points: readonly Point[];
  readonly primitive: SymbolShapePrimitive | undefined;
};

const arcGeometry = (raw: string): ArcGeometry | null => {
  const match = ARC_PATTERN.exec(raw);
  if (match === null) {
    return null;
  }
  const start: Point = { x: Number(match[1]), y: Number(match[2]) };
  const end: Point = { x: Number(match[8]), y: Number(match[9]) };
  let rx = Math.abs(Number(match[3]));
  let ry = Math.abs(Number(match[4]));
  const rotation = (Number(match[5]) * Math.PI) / 180;
  const largeArc = match[6] === "1";
  const sweep = match[7] === "1";
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx === 0 || ry === 0) {
    return { points: [start, end], primitive: undefined };
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const halfDx = (start.x - end.x) / 2;
  const halfDy = (start.y - end.y) / 2;
  const x1p = cos * halfDx + sin * halfDy;
  const y1p = -sin * halfDx + cos * halfDy;
  // 半径不够容纳两端点：按 SVG 规范等比放大
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const grow = Math.sqrt(lambda);
    rx *= grow;
    ry *= grow;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient =
    denominator === 0 ? 0 : sign * Math.sqrt(Math.max(0, numerator / denominator));
  const centerXp = (coefficient * rx * y1p) / ry;
  const centerYp = (-coefficient * ry * x1p) / rx;
  const centerX = cos * centerXp - sin * centerYp + (start.x + end.x) / 2;
  const centerY = sin * centerXp + cos * centerYp + (start.y + end.y) / 2;
  /** 从 u 到 v 的有向夹角 */
  const angleOf = (ux: number, uy: number, vx: number, vy: number): number =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const startAngle = angleOf(1, 0, (x1p - centerXp) / rx, (y1p - centerYp) / ry);
  let deltaAngle = angleOf(
    (x1p - centerXp) / rx,
    (y1p - centerYp) / ry,
    (-x1p - centerXp) / rx,
    (-y1p - centerYp) / ry,
  );
  if (!sweep && deltaAngle > 0) {
    deltaAngle -= Math.PI * 2;
  }
  if (sweep && deltaAngle < 0) {
    deltaAngle += Math.PI * 2;
  }
  const steps = Math.max(6, Math.min(24, Math.ceil(Math.abs(deltaAngle) / (Math.PI / 12))));
  const points: Point[] = [start];
  for (let index = 1; index <= steps; index += 1) {
    const theta = startAngle + (deltaAngle * index) / steps;
    points.push({
      x: centerX + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
      y: centerY + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
    });
  }
  // 末点强制吸附到源端点：下一段 PL 从这一点起笔，浮点误差会留出肉眼可见的缝
  points[points.length - 1] = end;
  // 写库用的原生圆弧只支持轴对齐椭圆（Capture 的 <Arc> 只有一个包围盒）
  const primitive: SymbolShapePrimitive | undefined =
    Math.abs(rotation) < 1e-9 && Number.isFinite(deltaAngle)
      ? { type: "arc", center: { x: centerX, y: centerY }, rx, ry, startAngle, deltaAngle }
      : undefined;
  return { points, primitive };
};

type ParsedSymbolShapes = {
  readonly pins: NormalizedSymbolPin[];
  readonly shapes: NormalizedSymbolShape[];
};

const parseShapes = (shape: readonly string[]): ParsedSymbolShapes => {
  const pins: NormalizedSymbolPin[] = [];
  const shapes: NormalizedSymbolShape[] = [];

  for (const line of shape) {
    const head = line.split("^^")[0] ?? "";
    const fields = head.split("~");
    switch (fields[0]) {
      case "P": {
        const connection = { x: numberOr(fields[4], 0), y: numberOr(fields[5], 0) };
        const rotation = numberOr(fields[6], 0);
        const outward = outwardOf(rotation);
        const length = pinLengthFrom(line.split("^^")[2] ?? "");
        const nameParts = (line.split("^^")[3] ?? "").split("~");
        const numberParts = (line.split("^^")[4] ?? "").split("~");
        pins.push({
          name: (nameParts[4] ?? "").trim(),
          // 极少数引脚不给脚号：用脚号字段兜底，避免 .olb 里出现空脚号。
          number: (numberParts[4] ?? fields[3] ?? "").trim() || `PIN_${pins.length + 1}`,
          connection,
          body: {
            x: connection.x - outward.x * length,
            y: connection.y - outward.y * length,
          },
          length,
          type: ELECTRIC_PIN_TYPE[fields[2] ?? "0"] ?? "unspecified",
          visible: (fields[1] ?? "show") !== "hide",
        });
        break;
      }
      case "R":
      case "PG": {
        if (fields[0] === "PG") {
          const points = polylinePoints(head);
          if (points.length >= 3) {
            shapes.push({ kind: "polyline", points, closed: true });
          }
          break;
        }
        const x = numberOr(fields[1], 0);
        const y = numberOr(fields[2], 0);
        const width = numberOr(fields[5], 0);
        const height = numberOr(fields[6], 0);
        if (width === 0 || height === 0) {
          break;
        }
        shapes.push({
          kind: "rect",
          min: { x, y },
          max: { x: x + width, y: y + height },
          cornerRadius: Math.max(numberOr(fields[3], 0), 0),
          /**
           * `R~x~y~rx~ry~w~h~stroke~strokeWidth~fillFlag~fillColor~id~locked`
           * —— 填充是**第 9 个字段的开关**（0/1），第 10 个才是颜色。
           *
           * 这里原先写的是 `(fields[9] ?? "none") !== "none"`，而该字段永远是 "0"/"1"，
           * 于是**所有本体都被当成实心**：预览给矩形铺了一层不透明底色，把它前面画好的
           * 圆、短线全盖住了（用户 2026-11-10 的 SMA-KWE：本体中间的圆和水平线不见了，
           * 看着像解析漏了）。本机缓存 54 个器件、48 个 R 全是 fillFlag=0（空心）。
           */
          filled: (fields[9] ?? "0") === "1",
        });
        break;
      }
      case "E":
      case "C": {
        const cx = numberOr(fields[1], 0);
        const cy = numberOr(fields[2], 0);
        // C~cx~cy~r~… ；E~cx~cy~rx~ry~…
        const rx = fields[0] === "C" ? numberOr(fields[3], 0) : numberOr(fields[3], 0);
        const ry = fields[0] === "C" ? rx : numberOr(fields[4], 0);
        if (rx <= 0 || ry <= 0) {
          break;
        }
        // 符号图元只支持矩形/折线/文本 → 圆与椭圆用 24 边形近似；
        // 同时留下原生椭圆参数，写库时用 <Ellipse> 才不会退化成"带台阶的八边形"。
        shapes.push({
          kind: "polyline",
          points: ellipsePoints(cx, cy, rx, ry),
          closed: true,
          primitive: { type: "ellipse", center: { x: cx, y: cy }, rx, ry },
        });
        break;
      }
      case "PL": {
        const points = polylinePoints(head);
        if (points.length >= 2) {
          shapes.push({ kind: "polyline", points, closed: false });
        }
        break;
      }
      case "PT": {
        // 多边形路径（二极管三角、箭头、异形本体）。一条 PT 可能含多个 M…Z 子环，
        // 每个子环各写一条折线；闭合与否按源数据里的 Z 决定。
        for (const ring of pathRings(head.split("~")[1] ?? "")) {
          shapes.push({ kind: "polyline", points: [...ring.points], closed: ring.closed });
        }
        break;
      }
      case "A": {
        // 圆弧（用户 2026-11-10）：以前落到 default 被静默丢弃，符号四角全部缺口
        const arc = arcGeometry(head);
        if (arc !== null && arc.points.length >= 2) {
          shapes.push({
            kind: "polyline",
            points: [...arc.points],
            closed: false,
            primitive: arc.primitive,
          });
        }
        break;
      }
      case "T": {
        const value = (fields[12] ?? "").trim();
        if (value.length === 0) {
          break;
        }
        shapes.push({
          kind: "text",
          text: value,
          at: { x: numberOr(fields[2], 0), y: numberOr(fields[3], 0) },
          rotation: numberOr(fields[4], 0),
          // 源字号形如 "11.5pt"；符号单位下 1pt ≈ 1.33 单位。
          // 下限 = 符号文本的默认字号（用户 2026-10-16 要求 7，原先是 6）：
          // 源数据给的字号过小时兜底用这个值，免得画出一行看不见的小字。
          height: Math.max(
            Number.parseFloat(fields[7] ?? "12") * 1.33 || 12,
            DEFAULT_SYMBOL_TEXT_HEIGHT,
          ),
        });
        break;
      }
      default:
        break;
    }
  }

  return { pins, shapes };
};

const boundsOf = (
  pins: readonly NormalizedSymbolPin[],
  shapes: readonly NormalizedSymbolShape[],
  bbox: { x: number; y: number; width: number; height: number } | undefined,
): { minX: number; minY: number; maxX: number; maxY: number } => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const pin of pins) {
    xs.push(pin.connection.x, pin.body.x);
    ys.push(pin.connection.y, pin.body.y);
  }
  for (const shape of shapes) {
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
  if (bbox !== undefined) {
    xs.push(bbox.x, bbox.x + bbox.width);
    ys.push(bbox.y, bbox.y + bbox.height);
  }
  if (xs.length === 0 || ys.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

const RawSymbolSchema = z.object({
  head: z
    .object({
      x: z.union([z.string(), z.number()]).optional(),
      y: z.union([z.string(), z.number()]).optional(),
      c_para: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  shape: z.array(z.string()).optional(),
  BBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

/**
 * 多子部件器件（双运放 / 双 MOSFET / 四门逻辑 …）的一段符号。
 *
 * 实测（C18221391 = AGM609MNA 双 MOSFET、C55807314 = LM358）：
 * 这类器件 `result.dataStr.shape` 是**空数组**，真实图形逐段放在
 * `result.subparts[]` 里，每段自带 head.c_para（`pre` 形如 `U?.1`）与 BBox。
 * 只读 dataStr 的旧逻辑会把它们当成"没有原理图符号"。
 */
export type EasyEdaSubpart = {
  readonly title?: string;
  readonly dataStr?: unknown;
};

type ParsedPart = {
  readonly name: string;
  readonly refdesPrefix: string;
  readonly pins: readonly NormalizedSymbolPin[];
  readonly shapes: readonly NormalizedSymbolShape[];
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

/** 解析一段符号（单段器件的 dataStr，或多子部件器件的一段 subpart）。 */
const parsePart = (
  rawDataStr: unknown,
  options: {
    readonly fallbackName: string;
    readonly fallbackSymbol: string;
    readonly lcscId: string;
  },
): ParsedPart | null => {
  const parsed = RawSymbolSchema.safeParse(rawDataStr);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  const rawShapes = data.shape ?? [];
  if (rawShapes.length === 0) {
    return null;
  }
  const { pins, shapes } = parseShapes(rawShapes);
  if (pins.length === 0 && shapes.length === 0) {
    return null;
  }
  const cPara = data.head?.c_para ?? {};
  return {
    // 官方库的 c_para.name 形如 `HT7533-1-TD(24V)` / `HT7533-1_C3011202`，
    // 括号说明和立创编号都是供应商元数据，原理图元件名只留型号（见 cleanSymbolName）。
    name: sanitizeSymbolName(
      cleanSymbolName(cPara.name ?? options.fallbackName, options.lcscId),
      options.fallbackSymbol,
    ),
    refdesPrefix: refdesPrefixFrom(cPara.pre),
    pins,
    shapes,
    bounds: boundsOf(pins, shapes, data.BBox),
  };
};

/** 引脚标签塞不进本体时，整段最多放大到几倍（1 = 不放大）。 */
const MAX_LABEL_FIT_SCALE = 4;
/** 只有小于这个尺寸（单位 = 10 mil）的本体才考虑放大：9 单位字高塞不下 40 单位见方的本体。 */
const LABEL_FIT_MIN_BODY = 40;

/** 图形（不含引脚）的包围盒；没有图元时返回 null。 */
const shapeBoxOf = (
  shapes: readonly NormalizedSymbolShape[],
): { minX: number; minY: number; maxX: number; maxY: number } | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const shape of shapes) {
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
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

/** 单段几何 → NormalizedSymbolSection（锚点归零 + 去重 + 吸附 + 标签避让）。 */
const buildSection = (part: ParsedPart, name: string): NormalizedSymbolSection => {
  const { pins, shapes, bounds } = part;
  /**
   * 本体锚点归零：**本体左下角必须落在 (0,0)**。
   *
   * 用户 2026-11-10 第三次报 "生成的引脚还是有偏差"：DMR-9S 这种没有矩形本体的符号
   * （DSUB 由直线 + 圆弧拼成）以前退回用整体 bounds 归零，而 bounds 含引脚与源数据
   * 的 BBox 边距，本体因此落在 (22,0)。Capture 里本体按原点摆、引脚按绝对坐标画，
   * 于是引脚整体比本体偏出一整根引脚的长度（截图里左边引脚凭空短了 20 单位）。
   *
   * 依据：Cadence 自带 Gate.olb 的 **581 个符号，SymbolBBox 全部以 (0,0) 起算**，
   * 引脚参数是负 x（左侧）/ 超出本体（右侧），从不靠本体偏移表达。
   */
  const bodyRect = shapes.find((shape) => shape.kind === "rect");
  const drawingBox = shapeBoxOf(shapes);
  const anchorX =
    bodyRect === undefined
      ? (drawingBox?.minX ?? bounds.minX)
      : Math.min(bodyRect.min.x, bodyRect.max.x);
  const anchorY =
    bodyRect === undefined
      ? (drawingBox?.minY ?? bounds.minY)
      : Math.min(bodyRect.min.y, bodyRect.max.y);
  // 归零位移。别让 0 变成 -0：坐标里出现 -0 会污染后续取模/相等判断。
  const dx = anchorX === 0 ? 0 : -anchorX;
  const dy = anchorY === 0 ? 0 : -anchorY;

  const assemble = (scale: number): NormalizedSymbolSection => {
    const movePoint = (point: Point): Point => ({
      x: (point.x + dx) * scale,
      y: (point.y + dy) * scale,
    });
    const moveShape = (shape: NormalizedSymbolShape): NormalizedSymbolShape => {
      if (shape.kind === "rect") {
        return { ...shape, min: movePoint(shape.min), max: movePoint(shape.max) };
      }
      if (shape.kind === "polyline") {
        return {
          ...shape,
          points: shape.points.map(movePoint),
          // 原生椭圆/圆弧参数必须跟着一起平移放大，否则写库时图形会跑到原位置
          primitive:
            shape.primitive === undefined
              ? undefined
              : transformSymbolPrimitive(shape.primitive, dx, dy, scale),
        };
      }
      return { ...shape, at: movePoint(shape.at) };
    };

    // ① 引脚名去重（Cadence 不接受重复引脚文本）→ ② 引脚标签避让
    // ③ 引脚两端落到 10 单位格点（Capture 的硬约定，最后做，确保标签锚点算在最终几何上）。
    // 顺序不能反：避让按引脚名的字宽算竖带深度，必须用**最终名字**（GND_18 比 GND 宽）。
    // 都在解析阶段做，预览与写库看到的是同一份结果。
    return attachPinLabelAnchors(
      alignPinEndsToGrid(
        avoidLabelOverlapInSection(
          alignPinsToGrid(
            dedupePinNames({
              name,
              bounds: {
                minX: (bounds.minX + dx) * scale,
                minY: (bounds.minY + dy) * scale,
                maxX: (bounds.maxX + dx) * scale,
                maxY: (bounds.maxY + dy) * scale,
              },
              pins: pins.map((pin) => ({
                ...pin,
                connection: movePoint(pin.connection),
                body: movePoint(pin.body),
              })),
              shapes: shapes.map(moveShape),
            }),
          ),
        ),
      ),
    );
  };

  /**
   * Capture 的引脚字号固定 9 单位，不随符号大小变。MOSFET / 三极管这类本体只有
   * 20 单位高的符号，名字从上下两边往中间长必然压在一起 —— 这时把**整段按整数倍
   * 放大**（引脚与图元一起放大、字号不变），直到标签互不重叠。
   *
   * 只对**小本体**放大：大符号（RP2048 这类几百单位的）标签本来就排得开，
   * 万一避让没解干净也不能把整个符号放大 4 倍。
   */
  const natural = assemble(1);
  const naturalBody = bodyBoxOf(natural);
  const tooSmall =
    Math.min(naturalBody.maxX - naturalBody.minX, naturalBody.maxY - naturalBody.minY) <
    LABEL_FIT_MIN_BODY;
  if (!tooSmall || !sectionLabelsCollide(natural)) {
    return natural;
  }
  for (let scale = 2; scale <= MAX_LABEL_FIT_SCALE; scale += 1) {
    const section = assemble(scale);
    if (!sectionLabelsCollide(section)) {
      return section;
    }
  }
  return assemble(MAX_LABEL_FIT_SCALE);
};

/**
 * 把一次器件响应的符号数据解析成 NormalizedSymbol。
 *
 * - 单段器件：图形在 `dataStr` 里（RP2040 / LM393 等绝大多数器件）。
 * - 多子部件器件：`dataStr.shape` 为空，图形逐段在 `subparts[].dataStr` 里，
 *   每段对应 OLB 里的一个 LibPart（A/B/C…），用户 2026-10-23 报的 C18221391 就是这种。
 *
 * 没有符号数据（老器件 / 只有封装）时返回 null，调用方跳过 .olb 写入。
 */
export const parseEasyEdaSymbol = (
  rawDataStr: unknown,
  options: {
    readonly lcscId: string;
    readonly fallbackName: string;
    readonly pcbFootprint: string;
    /** 多子部件器件的各段（`result.subparts`），dataStr 为空时才会用到 */
    readonly subparts?: readonly EasyEdaSubpart[];
  },
): NormalizedSymbol | null => {
  const fallbackSymbol = `SYM_${options.lcscId}`;
  const partOptions = {
    fallbackName: options.fallbackName,
    fallbackSymbol,
    lcscId: options.lcscId,
  };

  const candidates: { readonly part: ParsedPart; readonly title: string | undefined }[] = [];
  const primary = parsePart(rawDataStr, partOptions);
  if (primary !== null) {
    candidates.push({ part: primary, title: undefined });
  } else {
    // 多子部件：dataStr 只是空壳，逐段取 subparts。空段（只有电源脚/无图形）直接跳过。
    for (const subpart of options.subparts ?? []) {
      const part = parsePart(subpart.dataStr, partOptions);
      if (part !== null) {
        candidates.push({ part, title: subpart.title });
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  const symbolName = candidates[0].part.name;
  const multiSection = candidates.length > 1;
  const sections = candidates.map(({ part, title }, index) =>
    buildSection(
      part,
      // 段名只用于界面标签 / React key，必须唯一：优先用源 subpart 标题（AGM609MNA.1）。
      multiSection ? title?.trim() || `${symbolName}.${index + 1}` : symbolName,
    ),
  );

  const symbol: NormalizedSymbol = {
    name: symbolName,
    refdesPrefix: candidates[0].part.refdesPrefix,
    pcbFootprint: options.pcbFootprint,
    sections,
    sourceJson: JSON.stringify({
      source: "easyeda-standard-symbol",
      lcscId: options.lcscId,
      pinCount: sections.reduce((total, section) => total + section.pins.length, 0),
      shapeCount: sections.reduce((total, section) => total + section.shapes.length, 0),
      sectionNames: sections.map((section) => section.name),
    }),
  };
  return NormalizedSymbolSchema.parse(symbol);
};
