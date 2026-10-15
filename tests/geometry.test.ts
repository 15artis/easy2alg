import { describe, expect, it } from "vitest";
import { enlargePin1Markers, isFilledDisc } from "../src/main/conversion/geometry";
import type { NormalizedCircle, NormalizedPad } from "../src/shared/schemas";

// pin-1 角标可见性规则（用户反馈 2026-10-15："丝印方向的圆非常小不利于观看"，
// 补充要求："源数据的方向圆点标识符需要限制最小"）。
// 目标外径 = min( max(本体短边 × 5%, 下限), 1.5mm )，下限 = min(0.8mm, 本体短边 × 50%)；
// 只放大不缩小；非实心盘（真正的丝印圆环）不动。
const disc = (outerDiameter: number): NormalizedCircle => ({
  center: { x: -13.97, y: 13.97 },
  radius: outerDiameter / 4,
  width: outerDiameter / 2,
  layer: "silkscreen",
});

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

const outerDiameter = (circle: NormalizedCircle): number =>
  circle.radius * 2 + circle.width;

describe("pin-1 marker visibility", () => {
  it("recognises filled discs by the stroke model invariant", () => {
    // 线宽 ≥ 2×半径 ⟹ 圆环内径为 0 ⟹ 实心盘
    expect(isFilledDisc(disc(0.6))).toBe(true);
    // 真正的丝印圆环：半径 1.0、线宽 0.15
    expect(isFilledDisc({ ...disc(0.6), radius: 1, width: 0.15 })).toBe(false);
  });

  it("enlarges a tiny disc up to 5% of the body short side", () => {
    // 焊盘跨度 27 + 焊盘自身 0.5 = 本体短边 27.5 → 目标 1.375mm；源 0.6 < 1.375 → 放大
    const [enlarged] = enlargePin1Markers([disc(0.6)], padsSpanning(27));
    expect(outerDiameter(enlarged!)).toBeCloseTo(1.375, 6);
  });

  it("caps the marker at 1.5mm on very large bodies", () => {
    const [enlarged] = enlargePin1Markers([disc(0.6)], padsSpanning(60));
    expect(outerDiameter(enlarged!)).toBeCloseTo(1.5, 6);
  });

  it("never shrinks a marker that is already large enough", () => {
    // 本体短边 7mm → 目标 0.35mm；源外径 2mm 已经足够大
    const source = disc(2);
    const [kept] = enlargePin1Markers([source], padsSpanning(7));
    expect(kept).toEqual(source);
  });

  it("leaves genuine stroked rings untouched", () => {
    const ring: NormalizedCircle = { ...disc(0.6), radius: 1, width: 0.15 };
    const [kept] = enlargePin1Markers([ring], padsSpanning(27));
    expect(kept).toEqual(ring);
  });

  it("enforces a 0.8mm floor on everyday parts", () => {
    // 本体短边 7.5mm（5% = 0.375 < 下限 0.8）→ 取下限 0.8mm
    const [enlarged] = enlargePin1Markers([disc(0.44)], padsSpanning(7));
    expect(outerDiameter(enlarged!)).toBeCloseTo(0.8, 6);
  });

  it("caps the floor at half of the body short side on tiny parts", () => {
    // 焊盘跨度 0.3 + 焊盘 0.5 = 本体短边 0.8 → 下限 min(0.8, 0.4) = 0.4
    const [enlarged] = enlargePin1Markers([disc(0.2)], padsSpanning(0.3));
    expect(outerDiameter(enlarged!)).toBeCloseTo(0.4, 6);
  });

  it("keeps small footprints (chip parts) at their source size", () => {
    // 0603：本体短边 0.8mm，源外径 0.44 > 目标 0.4 → 原样保留
    const source = disc(0.44);
    const [kept] = enlargePin1Markers([source], padsSpanning(0.3));
    expect(kept).toEqual(source);
  });
});
