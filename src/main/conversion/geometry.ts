import type { NormalizedCircle, NormalizedPad, Point } from "../../shared/schemas";

export const EASYEDA_UNIT_MM = 0.254;

export const roundMm = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export const toMm = (value: number): number => roundMm(value * EASYEDA_UNIT_MM);

export const normalizePoint = (
  rawX: number,
  rawY: number,
  originX: number,
  originY: number,
): Point => ({
  x: toMm(rawX - originX),
  y: toMm(-(rawY - originY)),
});

export const parseCoordinatePairs = (value: string): readonly [number, number][] => {
  const values = value
    .trim()
    .split(/[\s,]+/)
    .filter((item) => item.length > 0)
    .map((item) => Number(item));

  if (values.some((item) => !Number.isFinite(item))) {
    throw new TypeError(`Invalid EasyEDA coordinate list: ${value}`);
  }

  const pairs: [number, number][] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    pairs.push([values[index], values[index + 1]]);
  }
  return pairs;
};

const rotatePoint = (point: Point, center: Point, angleDegrees: number): Point => {
  const radians = (angleDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const offsetX = point.x - center.x;
  const offsetY = point.y - center.y;
  return {
    x: roundMm(center.x + offsetX * cosine - offsetY * sine),
    y: roundMm(center.y + offsetX * sine + offsetY * cosine),
  };
};

export const padCorners = (pad: NormalizedPad): readonly Point[] => {
  if (pad.shape === "polygon" && pad.polygon.length >= 3) {
    return pad.polygon;
  }
  const halfWidth = pad.width / 2;
  const halfHeight = pad.height / 2;
  return [
    { x: pad.center.x - halfWidth, y: pad.center.y - halfHeight },
    { x: pad.center.x + halfWidth, y: pad.center.y - halfHeight },
    { x: pad.center.x + halfWidth, y: pad.center.y + halfHeight },
    { x: pad.center.x - halfWidth, y: pad.center.y + halfHeight },
  ].map((point) => rotatePoint(point, pad.center, pad.rotation));
};

export const computeBounds = (
  pads: readonly NormalizedPad[],
  extraPoints: readonly Point[],
): { minX: number; minY: number; maxX: number; maxY: number } => {
  const points = [...pads.flatMap((pad) => padCorners(pad)), ...extraPoints];
  if (points.length === 0) {
    throw new RangeError("Cannot compute footprint bounds without geometry");
  }
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
};

// pin-1 角标（实心圆盘）可见性 —— 用户反馈 2026-10-15："生成的丝印方向的圆非常小
// 不利于观看"。源数据的 FILL 圆点外径只有 0.6mm（11.811mil），在 27mm 的 FCBGA 上
// 按整版缩放显示几乎看不见。
// 判据不依赖数据来源：模型把圆统一为"描边圆"(center/radius/width)，当线宽 ≥ 2×半径
// 时圆环内径为 0，即实心圆盘 —— elibz2 的 FILL 圆点（radius=外径/2、width=外径）与
// 立创 C 编号接口的 EasyEDA CIRCLE（width=2×radius）都满足该不变式；而真正的丝印圆环
// 外径本就不小，会被下面的"不小于目标值则跳过"自然排除。
// 尺寸规则（用户要求："源数据的 方向圆点标识符 需要限制最小"，2026-10-15）：
//   目标外径 = min( max(本体短边 × 5%, 下限), 1.5mm )，且仅在「源外径 < 目标」时放大
//   下限     = min(0.8mm, 本体短边 × 50%)
//   · 只放大不缩小：源尺寸已足够大时原样保留；
//   · 5% 项让大器件（BGA）的角标随本体一起放大；
//   · 下限项给所有器件兜底一个可见尺寸，同时用"本体短边的一半"限制下限本身，
//     避免 0402/0603 这类小本体被角标占满；
//   · 1.5mm 上限防止超大本体上角标失控。
export const PIN1_MARKER_MIN_DIAMETER_MM = 0.8;
export const PIN1_MARKER_BODY_RATIO = 0.05;
export const PIN1_MARKER_MAX_DIAMETER_MM = 1.5;

export const isFilledDisc = (circle: NormalizedCircle): boolean =>
  circle.width >= circle.radius * 2 - 1e-9;

const discOuterDiameter = (circle: NormalizedCircle): number =>
  circle.radius * 2 + circle.width;

export const enlargePin1Markers = (
  circles: readonly NormalizedCircle[],
  pads: readonly NormalizedPad[],
): NormalizedCircle[] => {
  if (pads.length === 0 || circles.length === 0) {
    return [...circles];
  }
  const body = computeBounds(pads, []);
  const bodyShortSide = Math.min(body.maxX - body.minX, body.maxY - body.minY);
  const floor = Math.min(PIN1_MARKER_MIN_DIAMETER_MM, bodyShortSide * 0.5);
  const targetOuterDiameter = Math.min(
    Math.max(bodyShortSide * PIN1_MARKER_BODY_RATIO, floor),
    PIN1_MARKER_MAX_DIAMETER_MM,
  );
  return circles.map((circle) => {
    if (!isFilledDisc(circle) || discOuterDiameter(circle) >= targetOuterDiameter) {
      return circle;
    }
    // 维持实心圆盘编码：描边外沿 = radius + width/2 = 目标外半径，因此
    // radius = 目标外径/4、width = 目标外径/2，使 SVG 预览与 axlDBCreateCircle
    // 的居中描边得到同一个外径。（源编码 radius=外径/2、width=外径 同理。）
    return {
      ...circle,
      radius: roundMm(targetOuterDiameter / 4),
      width: roundMm(targetOuterDiameter / 2),
    };
  });
};

export const uniquePositiveDeltas = (values: readonly number[]): readonly number[] => {
  const sorted = [...new Set(values.map((value) => roundMm(value)))].sort(
    (left, right) => left - right,
  );
  const deltas: number[] = [];
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const delta = roundMm(sorted[rightIndex] - sorted[leftIndex]);
      if (delta > 0.05) {
        deltas.push(delta);
      }
    }
  }
  return [...new Set(deltas)].sort((left, right) => left - right);
};

const vectorAngle = (ux: number, uy: number, vx: number, vy: number): number => {
  const dot = ux * vx + uy * vy;
  const magnitude = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  const clamped = Math.min(1, Math.max(-1, dot / magnitude));
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  return sign * Math.acos(clamped);
};

export const approximateSvgArc = (
  path: string,
  originX: number,
  originY: number,
  segments: number,
): readonly Point[] => {
  const values = path
    .replace(/[A-Za-z]/g, " ")
    .replace(/,/g, " ")
    .trim()
    .split(/\s+/)
    .map((item) => Number(item));
  if (values.length < 9 || values.some((item) => !Number.isFinite(item))) {
    throw new TypeError(`Unsupported EasyEDA arc path: ${path}`);
  }

  const [startX, startY, radiusXInput, radiusYInput, rotation, largeArc, sweep, endX, endY] =
    values.slice(-9);
  const phi = (rotation * Math.PI) / 180;
  const cosine = Math.cos(phi);
  const sine = Math.sin(phi);
  const dx = (startX - endX) / 2;
  const dy = (startY - endY) / 2;
  const transformedX = cosine * dx + sine * dy;
  const transformedY = -sine * dx + cosine * dy;
  let radiusX = Math.abs(radiusXInput);
  let radiusY = Math.abs(radiusYInput);
  const radiusScale =
    (transformedX * transformedX) / (radiusX * radiusX) +
    (transformedY * transformedY) / (radiusY * radiusY);
  if (radiusScale > 1) {
    const scale = Math.sqrt(radiusScale);
    radiusX *= scale;
    radiusY *= scale;
  }

  const numerator =
    radiusX * radiusX * radiusY * radiusY -
    radiusX * radiusX * transformedY * transformedY -
    radiusY * radiusY * transformedX * transformedX;
  const denominator =
    radiusX * radiusX * transformedY * transformedY +
    radiusY * radiusY * transformedX * transformedX;
  const factorSign = largeArc === sweep ? -1 : 1;
  const factor = factorSign * Math.sqrt(Math.max(0, numerator / denominator));
  const centerTransformedX = (factor * radiusX * transformedY) / radiusY;
  const centerTransformedY = (-factor * radiusY * transformedX) / radiusX;
  const centerX =
    cosine * centerTransformedX - sine * centerTransformedY + (startX + endX) / 2;
  const centerY =
    sine * centerTransformedX + cosine * centerTransformedY + (startY + endY) / 2;

  const startVectorX = (transformedX - centerTransformedX) / radiusX;
  const startVectorY = (transformedY - centerTransformedY) / radiusY;
  const endVectorX = (-transformedX - centerTransformedX) / radiusX;
  const endVectorY = (-transformedY - centerTransformedY) / radiusY;
  const startAngle = vectorAngle(1, 0, startVectorX, startVectorY);
  let angleDelta = vectorAngle(startVectorX, startVectorY, endVectorX, endVectorY);
  if (sweep === 0 && angleDelta > 0) {
    angleDelta -= Math.PI * 2;
  }
  if (sweep === 1 && angleDelta < 0) {
    angleDelta += Math.PI * 2;
  }

  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = startAngle + (angleDelta * index) / segments;
    const rawX =
      centerX + cosine * radiusX * Math.cos(angle) - sine * radiusY * Math.sin(angle);
    const rawY =
      centerY + sine * radiusX * Math.cos(angle) + cosine * radiusY * Math.sin(angle);
    return normalizePoint(rawX, rawY, originX, originY);
  });
};
