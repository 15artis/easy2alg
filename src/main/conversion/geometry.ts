import type {
  NormalizedCircle,
  NormalizedLine,
  NormalizedPad,
  Point,
} from "../../shared/schemas";
import { normalizePolygon, roundMm } from "../../shared/pad-geometry";

// 多边形几何（normalizePolygon / offsetPolygon / scalePolygon …）住在 shared，
// 渲染进程画预览也要用同一套算法，避免"预览是矩形、生成是异形"的两套逻辑。
export {
  normalizePolygon,
  offsetPolygon,
  polygonBounds,
  polygonSignedArea,
  scalePolygon,
} from "../../shared/pad-geometry";

export const EASYEDA_UNIT_MM = 0.254;

export { roundMm };

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

export const rotatePoint = (point: Point, center: Point, angleDegrees: number): Point => {
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

/**
 * 实心圆盘的判定容差。
 *
 * 不能取 1e-9：源数据是「半径 0.197 / 线宽 0.3937（单位 0.254mm）」这种值，
 * 乘 0.254 再四舍五入到 6 位后，2×半径 会比线宽大 7.6e-5mm，真正的实心盘就被
 * 判成圆环了。2026-10-28 实测：C3210600 的 1 脚圆点正是这样被漏掉，反倒是旁边
 * 那个装饰点被放大成了大色块。
 */
const DISC_TOLERANCE_MM = 0.01;

export const isFilledDisc = (circle: NormalizedCircle): boolean =>
  circle.width >= circle.radius * 2 - DISC_TOLERANCE_MM;

const discOuterDiameter = (circle: NormalizedCircle): number =>
  circle.radius * 2 + circle.width;

/** 本体轮廓（毫米）。判断角标"是否在本体之外"用。 */
export type OutlineBox = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

/**
 * 取本体轮廓：优先丝印线，其次 courtyard，两者都没有才退回焊盘包围盒。
 *
 * 用线条而不是焊盘包围盒，是因为 1 脚角标通常画在轮廓外的空白处（比焊盘范围还外），
 * 拿焊盘包围盒当本体，会把角标也判成"本体之内"。
 */
export const outlineBoxOf = (
  lines: readonly NormalizedLine[],
  pads: readonly NormalizedPad[],
): OutlineBox => {
  const silkscreen = lines.filter((line) => line.layer === "silkscreen");
  const courtyard = lines.filter((line) => line.layer === "courtyard");
  const source = silkscreen.length > 0 ? silkscreen : courtyard;
  const points = source.flatMap((line) => [line.start, line.end]);
  if (points.length === 0) {
    return computeBounds(pads, []);
  }
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
};

const isOutside = (box: OutlineBox, point: Point): boolean =>
  point.x < box.minX || point.x > box.maxX || point.y < box.minY || point.y > box.maxY;

/**
 * 放大 1 脚角标。
 *
 * 只有同时满足下面三条的圆才是 1 脚角标，才会被放大：
 *   1. 在**丝印层**（装配层的圆是每个焊盘中心的小点，放大就是灾难）；
 *   2. 是**实心圆盘**（见 isFilledDisc 的容差说明）；
 *   3. 位于**本体轮廓之外**。
 *
 * 第 3 条是 2026-10-28 补的。立创的封装常在本体角点上再放一个小圆点当装饰，
 * 它和 1 脚角标长得一模一样，但位置正好压在轮廓角上 —— 照旧规则放大后，预览里
 * 就出现"两个方向指示、其中一个又大又压在边框上"（C3210600 的 TFBGA-100）。
 *
 * 多个候选时只放大**最大**的那个：再放大第二个就又变成两个指示了。
 */
export const enlargePin1Markers = (
  circles: readonly NormalizedCircle[],
  pads: readonly NormalizedPad[],
  outline?: OutlineBox,
): NormalizedCircle[] => {
  if (pads.length === 0 || circles.length === 0) {
    return [...circles];
  }
  const body = outline ?? computeBounds(pads, []);
  const bodyShortSide = Math.min(body.maxX - body.minX, body.maxY - body.minY);
  const floor = Math.min(PIN1_MARKER_MIN_DIAMETER_MM, bodyShortSide * 0.5);
  const targetOuterDiameter = Math.min(
    Math.max(bodyShortSide * PIN1_MARKER_BODY_RATIO, floor),
    PIN1_MARKER_MAX_DIAMETER_MM,
  );
  const candidates = circles.filter(
    (circle) =>
      circle.layer === "silkscreen" &&
      isFilledDisc(circle) &&
      discOuterDiameter(circle) < targetOuterDiameter &&
      isOutside(body, circle.center),
  );
  if (candidates.length === 0) {
    return [...circles];
  }
  const chosen = candidates.reduce((best, current) =>
    discOuterDiameter(current) > discOuterDiameter(best) ? current : best,
  );
  return circles.map((circle) => {
    if (circle !== chosen) {
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

/**
 * 多边形焊盘（异形焊盘）的几何工具在 shared/pad-geometry.ts —— 渲染进程画
 * PCB 预览也要用同一套算法。这里只保留依赖 rotatePoint 的局部坐标变换。
 */

/**
 * 焊盘多边形 → 焊盘局部坐标：先平移到焊盘中心，再反向旋转 pad.rotation。
 * `padCorners` 对非多边形焊盘做的是「局部包围盒 + 正旋转」，这里必须是它的逆运算，
 * 否则引脚按 rotation 摆上去之后形状会转两遍。
 *
 * 注意 rotatePoint 返回的是**含中心**的绝对坐标（center + R·offset），
 * 而 padstack 图形必须以焊盘原点为 0，所以这里还要再减掉一次中心。
 * 少了这一步，形状会整体平移（HT7533-1 实测偏了 1.36mm）。
 */
export const localPadPolygon = (pad: NormalizedPad): readonly Point[] =>
  normalizePolygon(
    pad.polygon.map((point) => {
      const rotated = rotatePoint(point, pad.center, -pad.rotation);
      return { x: rotated.x - pad.center.x, y: rotated.y - pad.center.y };
    }),
  );

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
