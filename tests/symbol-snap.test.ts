import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAP_GRID,
  arrowStep,
  SNAP_GRIDS,
  expandBox,
  fitBoxToView,
  gridMil,
  isOnGrid,
  snapDragDelta,
  snapRectBounds,
  snapValue,
  unionBoxes,
  worldRectOf,
} from "../src/shared/symbol-snap";

/**
 * 用户 2026-10-20：网格只保留两档 —— 100 mil（10 单位，默认）与 50 mil（5 单位）。
 * 背景网格、拖动吸附、rect 边吸附共用这一份内核。
 */
describe("symbol snap", () => {
  it("两档档位与 mil 对应关系", () => {
    expect(SNAP_GRIDS.map((item) => item.value)).toEqual([10, 5]);
    expect(DEFAULT_SNAP_GRID).toBe(10);
    expect(gridMil(10)).toBe(100);
    expect(gridMil(5)).toBe(50);
  });

  it("snapValue 按档位取整", () => {
    expect(snapValue(23, 10)).toBe(20);
    expect(snapValue(26, 10)).toBe(30);
    expect(snapValue(23, 5)).toBe(25);
    expect(snapValue(-3, 10)).toBe(-0);
    expect(snapValue(7.4, 1)).toBe(7);
    expect(isOnGrid(30, 10)).toBe(true);
    expect(isOnGrid(25, 10)).toBe(false);
    expect(isOnGrid(25, 5)).toBe(true);
  });

  it("累计位移量化不丢余量（每帧 7px，grid=10）", () => {
    let applied = { dx: 0, dy: 0 };
    let raw = 0;
    const deltas: number[] = [];
    for (let frame = 0; frame < 5; frame += 1) {
      raw += 7;
      const step = snapDragDelta({ dx: raw, dy: 0 }, applied, { enabled: true, grid: 10 });
      applied = { dx: step.appliedX, dy: step.appliedY };
      if (step.dx !== 0) {
        deltas.push(step.dx);
      }
    }
    // 7→10(+10), 14→10(0), 21→20(+10), 28→30(+10), 35→40(+10)（半格向上）
    expect(deltas).toEqual([10, 10, 10, 10]);
    // 最终落点与"总量取整"一致，没有逐帧取整造成的漂移
    expect(applied.dx).toBe(snapValue(35, 10));
  });

  it("关闭吸附时原样返回，且 applied 跟着 raw", () => {
    const step = snapDragDelta({ dx: 13.4, dy: -7.2 }, { dx: 0, dy: 0 }, { enabled: false, grid: 10 });
    expect(step.dx).toBeCloseTo(13.4, 6);
    expect(step.dy).toBeCloseTo(-7.2, 6);
    expect(step.appliedX).toBeCloseTo(13.4, 6);
  });

  it("rect 边吸附只动被拖的边", () => {
    const origin = { min: { x: 0, y: 0 }, max: { x: 37, y: 21 } };
    const left = snapRectBounds(origin, { left: true, right: false, top: false, bottom: false }, 10);
    expect(left.min).toEqual({ x: 0, y: 0 });
    expect(left.max).toEqual({ x: 37, y: 21 });

    const movedLeft = snapRectBounds(
      { min: { x: 13, y: 4 }, max: { x: 37, y: 21 } },
      { left: true, right: false, top: false, bottom: false },
      10,
    );
    expect(movedLeft.min).toEqual({ x: 10, y: 4 });
    expect(movedLeft.max).toEqual({ x: 37, y: 21 });

    const corner = snapRectBounds(
      { min: { x: -3, y: 0 }, max: { x: 37, y: 26 } },
      { left: true, right: true, top: false, bottom: true },
      10,
    );
    expect(corner.min.x).toBe(-0);
    expect(corner.max.x).toBe(40);
    expect(corner.min.y).toBe(0);
    expect(corner.max.y).toBe(30);
  });

  it("rect 拖到反向（min > max）也能正常工作", () => {
    const flipped = snapRectBounds(
      { min: { x: 45, y: 0 }, max: { x: 12, y: 20 } },
      { left: false, right: true, top: false, bottom: false },
      10,
    );
    expect(flipped.min.x).toBe(12);
    expect(flipped.max.x).toBe(50);
  });

  it("worldRectOf 把视口换算成世界矩形", () => {
    const box = worldRectOf({ tx: 100, ty: 50, scale: 2, width: 400, height: 300 });
    expect(box.minX).toBe(-50);
    expect(box.minY).toBe(-25);
    expect(box.maxX).toBe(150);
    expect(box.maxY).toBe(125);
  });

  it("expandBox / unionBoxes", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const b = { minX: 5, minY: -5, maxX: 20, maxY: 5 };
    expect(unionBoxes([a, b])).toEqual({ minX: 0, minY: -5, maxX: 20, maxY: 10 });
    expect(unionBoxes([])).toBeNull();
    expect(expandBox(a, 2)).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 12 });
  });

  it("fitBoxToView 与 PanZoom 的 fit 同构（含 padding 与上下限）", () => {
    const view = fitBoxToView(
      { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      { width: 900, height: 600 },
      0.86,
    );
    // 取更小的比例：900/100=9，600/50=12 → 9 * 0.86
    expect(view.scale).toBeCloseTo(7.74, 6);
    expect(view.tx).toBeCloseTo(450 - 50 * 7.74, 6);
    expect(view.ty).toBeCloseTo(300 - 25 * 7.74, 6);

    const clamped = fitBoxToView(
      { minX: 0, minY: 0, maxX: 1e6, maxY: 1e6 },
      { width: 100, height: 100 },
      0.86,
    );
    expect(clamped.scale).toBe(0.02);
  });

  it("方向键步长：吸附开按档位，Shift 精调，Alt 粗调", () => {
    const on10 = { enabled: true, grid: 10 };
    const on5 = { enabled: true, grid: 5 };
    expect(arrowStep(on10, { shift: false, alt: false })).toBe(10);
    expect(arrowStep(on5, { shift: false, alt: false })).toBe(5);
    expect(arrowStep(on10, { shift: true, alt: false })).toBe(1);
    expect(arrowStep(on10, { shift: false, alt: true })).toBe(100);
    expect(arrowStep(on5, { shift: false, alt: true })).toBe(50);
    // 吸附关：1 / 1 / 10
    const off = { enabled: false, grid: 10 };
    expect(arrowStep(off, { shift: false, alt: false })).toBe(1);
    expect(arrowStep(off, { shift: true, alt: false })).toBe(1);
    expect(arrowStep(off, { shift: false, alt: true })).toBe(10);
  });
});
