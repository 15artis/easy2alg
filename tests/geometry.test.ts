import { describe, expect, it } from "vitest";
import {
  enlargePin1Markers,
  isFilledDisc,
  type OutlineBox,
} from "../src/main/conversion/geometry";
import type { NormalizedCircle, NormalizedPad, Point } from "../src/shared/schemas";

// pin-1 角标可见性规则（用户反馈 2026-10-15："丝印方向的圆非常小不利于观看"，
// 补充要求："源数据的方向圆点标识符需要限制最小"）。
// 目标外径 = min( max(本体短边 × 5%, 下限), 1.5mm )，下限 = min(0.3mm, 本体短边 × 20%)；
// 只放大不缩小；非实心盘（真正的丝印圆环）不动。
//
// 2026-10-28 补充：只有「丝印层 + 实心盘 + 位于本体轮廓之外」才算 1 脚角标。
// 立创封装常在本体角点上再放一个装饰圆点，位置正好压在轮廓角，放大后就成了
// "两个方向指示、其中一个又大又压在边框上"（C3210600 TFBGA-100）。
//
// 2026-10-28 二次修正：下限从 0.8mm 改成 0.3mm 且按本体等比（用户对照立创原封装
// 反馈"这个圆过大"）。8mm 本体从 0.8mm 收到 0.41mm，与原图的 0.39mm 基本一致。
const discAt = (outerDiameter: number, center: Point): NormalizedCircle => ({
  center,
  radius: outerDiameter / 4,
  width: outerDiameter / 2,
  layer: "silkscreen",
});

/** 把角标放在本体轮廓外的空白处（真实封装里 1 脚角标就画在这里）。 */
const outsideDisc = (outerDiameter: number, span: number): NormalizedCircle =>
  discAt(outerDiameter, { x: -(span / 2 + 1), y: 0 });

const padsSpanning = (span: number): readonly NormalizedPad[] =>
  [
    { x: -span / 2, y: -span / 2 },
    { x: span / 2, y: span / 2 },
  ].map((center, index) => ({
    number: `P${index}`,
    center,
    width: 0.5,
    height: 0.5,
    rotation: 0,
    shape: "circle" as const,
    polygon: [],
    plated: false,
    holeWidth: 0,
    holeHeight: 0,
    sourceLayerId: 1,
  }));

const outlineOf = (span: number): OutlineBox => ({
  minX: -span / 2,
  minY: -span / 2,
  maxX: span / 2,
  maxY: span / 2,
});

const outerDiameter = (circle: NormalizedCircle): number =>
  circle.radius * 2 + circle.width;

describe("pin-1 marker visibility", () => {
  it("recognises filled discs by the stroke model invariant", () => {
    // 线宽 ≥ 2×半径 ⟹ 圆环内径为 0 ⟹ 实心盘
    expect(isFilledDisc(discAt(0.6, { x: 0, y: 0 }))).toBe(true);
    // 真正的丝印圆环：半径 1.0、线宽 0.15
    expect(isFilledDisc({ ...discAt(0.6, { x: 0, y: 0 }), radius: 1, width: 0.15 })).toBe(false);
  });

  it("treats a hairline-hole disc as filled (source rounding must not turn it into a ring)", () => {
    // C3210600 的真实数值：半径 0.050038、线宽 0.1 —— 2r 比 width 大 7.6e-5mm
    expect(isFilledDisc({ center: { x: 0, y: 0 }, radius: 0.050038, width: 0.1, layer: "silkscreen" })).toBe(true);
  });

  it("enlarges a tiny disc up to 5% of the body short side", () => {
    // 焊盘跨度 27 + 焊盘自身 0.5 = 本体短边 27.5 → 目标 1.375mm；源 0.6 < 1.375 → 放大
    const [enlarged] = enlargePin1Markers([outsideDisc(0.6, 27)], padsSpanning(27));
    expect(outerDiameter(enlarged!)).toBeCloseTo(1.375, 6);
  });

  it("caps the marker at 1.5mm on very large bodies", () => {
    const [enlarged] = enlargePin1Markers([outsideDisc(0.6, 60)], padsSpanning(60));
    expect(outerDiameter(enlarged!)).toBeCloseTo(1.5, 6);
  });

  it("never shrinks a marker that is already large enough", () => {
    // 本体短边 7mm → 目标 0.35mm；源外径 2mm 已经足够大
    const source = outsideDisc(2, 7);
    const [kept] = enlargePin1Markers([source], padsSpanning(7));
    expect(kept).toEqual(source);
  });

  it("leaves genuine stroked rings untouched", () => {
    const ring: NormalizedCircle = { ...outsideDisc(0.6, 27), radius: 1, width: 0.15 };
    const [kept] = enlargePin1Markers([ring], padsSpanning(27));
    expect(kept).toEqual(ring);
  });

  it("scales the marker with the body (5% of the short side)", () => {
    // 本体短边 7.5mm（5% = 0.375 > 下限 0.3）→ 取 0.375mm
    const [enlarged] = enlargePin1Markers([outsideDisc(0.1, 7)], padsSpanning(7));
    expect(outerDiameter(enlarged!)).toBeCloseTo(0.375, 6);
  });

  it("caps the floor at 20% of the body short side on tiny parts", () => {
    // 焊盘跨度 0.3 + 焊盘 0.5 = 本体短边 0.8 → 下限 min(0.3, 0.16) = 0.16
    // 源外径 0.1 < 0.16 → 放大到 0.16
    const [enlarged] = enlargePin1Markers([outsideDisc(0.1, 0.3)], padsSpanning(0.3));
    expect(outerDiameter(enlarged!)).toBeCloseTo(0.16, 6);
  });

  it("keeps small footprints (chip parts) at their source size", () => {
    // 0603：本体短边 0.8mm，目标 0.16，源外径 0.44 > 0.16 → 原样保留
    const source = outsideDisc(0.44, 0.3);
    const [kept] = enlargePin1Markers([source], padsSpanning(0.3));
    expect(kept).toEqual(source);
  });
});

describe("1 脚角标只认本体轮廓之外的那一个", () => {
  // C3210600（TFBGA-100）的真实布局：本体 ±4.076，角点 (-4, 4) 有个装饰圆点，
  // 轮廓外 (-4.576, 3.6) 才是 1 脚角标。
  const body = outlineOf(8.152);
  const cornerDot: NormalizedCircle = {
    center: { x: -3.999992, y: 3.999992 },
    radius: 0.029972,
    width: 0.059944,
    layer: "silkscreen",
  };
  const pin1Dot: NormalizedCircle = {
    center: { x: -4.576064, y: 3.599942 },
    radius: 0.050038,
    width: 0.1,
    layer: "silkscreen",
  };
  const pads = padsSpanning(7.2);

  it("本体角点上的装饰圆点保持原样，不会被放大成压在边框上的色块", () => {
    const [kept] = enlargePin1Markers([cornerDot], pads, body);
    expect(kept).toEqual(cornerDot);
  });

  it("轮廓外的角标被放大", () => {
    const [enlarged] = enlargePin1Markers([pin1Dot], pads, body);
    expect(outerDiameter(enlarged!)).toBeCloseTo(0.4076, 6);
    expect(enlarged!.center).toEqual(pin1Dot.center);
  });

  it("两个圆同时存在时只放大轮廓外的那个", () => {
    const [cornerResult, pinResult] = enlargePin1Markers([cornerDot, pin1Dot], pads, body);
    expect(cornerResult).toEqual(cornerDot);
    expect(outerDiameter(pinResult!)).toBeCloseTo(0.4076, 6);
  });

  it("多个轮廓外候选时只放大最大的一个（避免出现两个指示）", () => {
    const small = discAt(0.2, { x: -5.2, y: 0 });
    const large = discAt(0.3, { x: -6, y: 0 });
    const [smallResult, largeResult] = enlargePin1Markers([small, large], pads, body);
    expect(smallResult).toEqual(small);
    expect(outerDiameter(largeResult!)).toBeCloseTo(0.4076, 6);
  });

  it("装配层的圆点（每个焊盘中心的小点）不参与放大", () => {
    const assembly: NormalizedCircle = { ...pin1Dot, layer: "assembly" };
    const [kept] = enlargePin1Markers([assembly], pads, body);
    expect(kept).toEqual(assembly);
  });

  it("轮廓内的圆点不放大（源数据没画在本体之外时保持原样）", () => {
    const inside: NormalizedCircle = discAt(0.2, { x: 0, y: 0 });
    const [kept] = enlargePin1Markers([inside], pads, body);
    expect(kept).toEqual(inside);
  });
});
