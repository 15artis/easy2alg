import { describe, expect, it } from "vitest";
import {
  collectBoxes,
  planAlign,
  planDistribute,
  planLayoutAction,
  type OffsetMap,
} from "../src/shared/symbol-align";
import { pinLabelAnchors, type SymbolBox } from "../src/shared/symbol-labels";
import {
  accumulateLabelShift,
  applySymbolEdits,
  type SymbolEdits,
} from "../src/shared/symbol-edit";
import type { NormalizedSymbol } from "../src/shared/schemas";

/**
 * 用户 2026-10-20：多选后要能像 OrCAD/Visio 一样对齐与等间距分布。
 * 基准是**选择集整体包围盒**，分布按中心间距相等。
 */
const box = (minX: number, minY: number, maxX: number, maxY: number): SymbolBox => ({
  minX,
  minY,
  maxX,
  maxY,
});

const boxes = (): ReadonlyMap<string, SymbolBox> =>
  new Map([
    ["a", box(0, 10, 20, 20)],
    ["b", box(30, 0, 50, 40)],
    ["c", box(70, 5, 100, 15)],
  ]);

const applied = (offsets: OffsetMap, current: SymbolBox): SymbolBox => {
  const offset = offsets.get("x");
  return offset === undefined
    ? current
    : {
        minX: current.minX + offset.dx,
        minY: current.minY + offset.dy,
        maxX: current.maxX + offset.dx,
        maxY: current.maxY + offset.dy,
      };
};

const move = (map: ReadonlyMap<string, SymbolBox>, offsets: OffsetMap): ReadonlyMap<string, SymbolBox> => {
  const next = new Map<string, SymbolBox>();
  for (const [key, value] of map) {
    const offset = offsets.get(key);
    next.set(
      key,
      offset === undefined
        ? value
        : {
            minX: value.minX + offset.dx,
            minY: value.minY + offset.dy,
            maxX: value.maxX + offset.dx,
            maxY: value.maxY + offset.dy,
          },
    );
  }
  return next;
};

describe("symbol align / distribute", () => {
  it("左对齐：所有 minX 相等，其余坐标不变", () => {
    const result = move(boxes(), planAlign(boxes(), "left"));
    expect(result.get("a")!.minX).toBe(0);
    expect(result.get("b")!.minX).toBe(0);
    expect(result.get("c")!.minX).toBe(0);
    expect(result.get("b")!.minY).toBe(0);
    expect(result.get("c")!.maxY).toBe(15);
  });

  it("右对齐：所有 maxX 相等", () => {
    const result = move(boxes(), planAlign(boxes(), "right"));
    expect(new Set([...result.values()].map((item) => item.maxX)).size).toBe(1);
  });

  it("顶/底对齐与水平居中", () => {
    const top = move(boxes(), planAlign(boxes(), "top"));
    expect(new Set([...top.values()].map((item) => item.minY)).size).toBe(1);

    const bottom = move(boxes(), planAlign(boxes(), "bottom"));
    expect(new Set([...bottom.values()].map((item) => item.maxY)).size).toBe(1);

    const centerX = move(boxes(), planAlign(boxes(), "centerX"));
    const centers = [...centerX.values()].map((item) => (item.minX + item.maxX) / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1e-9);
  });

  it("垂直居中（centerY）", () => {
    const result = move(boxes(), planAlign(boxes(), "centerY"));
    const centers = [...result.values()].map((item) => (item.minY + item.maxY) / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1e-9);
  });

  it("少于 2 个元素不做对齐", () => {
    expect(planAlign(new Map([["a", box(0, 0, 10, 10)]]), "left").size).toBe(0);
  });

  it("水平分布：首尾不动，中间中心等距", () => {
    const source = boxes();
    const result = move(source, planDistribute(source, "horizontal"));
    const centers = ["a", "b", "c"].map((key) => {
      const value = result.get(key)!;
      return (value.minX + value.maxX) / 2;
    });
    expect(centers[0]).toBe(10);
    expect(centers[2]).toBe(85);
    expect(centers[1]).toBeCloseTo((10 + 85) / 2, 6);
    // 首尾元素没有被移动
    expect(result.get("a")).toEqual(source.get("a"));
    expect(result.get("c")).toEqual(source.get("c"));
  });

  it("垂直分布：中间 centerY 等距", () => {
    const source = new Map([
      ["a", box(0, 0, 10, 10)],
      ["b", box(0, 30, 10, 34)],
      ["c", box(0, 90, 10, 100)],
    ]);
    const result = move(source, planDistribute(source, "vertical"));
    const centers = ["a", "b", "c"].map((key) => {
      const value = result.get(key)!;
      return (value.minY + value.maxY) / 2;
    });
    expect(centers[0]).toBe(5);
    expect(centers[2]).toBe(95);
    expect(centers[1]).toBeCloseTo(50, 6);
  });

  it("少于 3 个元素不做分布", () => {
    const two = new Map([
      ["a", box(0, 0, 10, 10)],
      ["b", box(20, 0, 30, 10)],
    ]);
    expect(planDistribute(two, "horizontal").size).toBe(0);
  });

  it("工具栏动作字符串解析", () => {
    const source = boxes();
    expect(planLayoutAction(source, "align:left").size).toBeGreaterThan(0);
    expect(planLayoutAction(source, "distribute:horizontal").size).toBeGreaterThan(0);
    expect(planLayoutAction(source, "nonsense").size).toBe(0);
  });

  it("已对齐的元素不产生多余偏移（避免空撤销点）", () => {
    const aligned = new Map([
      ["a", box(0, 0, 10, 10)],
      ["b", box(0, 20, 10, 30)],
    ]);
    expect(planAlign(aligned, "left").size).toBe(0);
  });
});

/**
 * 用户 2026-10-22：对齐左侧引脚时，引脚本体被挪下边框（圆点跑到框内）。
 * 正确行为：只挪标签让文字对齐，引脚端点保持贴边。
 */
describe("aligning pins moves labels only", () => {
  const body = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const build = () => {
    const base = {
      name: "TESTPART",
      bounds: body,
      pins: [
        {
          name: "A",
          number: "1",
          connection: { x: -10, y: 20 },
          body: { x: 0, y: 20 },
          length: 10,
          type: "passive" as const,
          visible: true,
        },
        {
          name: "LONGER_NAME",
          number: "2",
          connection: { x: -10, y: 40 },
          body: { x: 0, y: 40 },
          length: 10,
          type: "passive" as const,
          visible: true,
        },
      ],
      shapes: [
        { kind: "rect" as const, min: { x: 0, y: 0 }, max: { x: 100, y: 60 }, cornerRadius: 0, filled: false },
      ],
    };
    return {
      ...base,
      pins: base.pins.map((pin) => ({ ...pin, labelAnchor: pinLabelAnchors(pin, body) })),
    };
  };

  it("右对齐后标签右边缘一致，引脚端点不动", () => {
    const section = build();
    const keys = ["p0:0", "p0:1"];
    const offsets = planAlign(collectBoxes(section, keys), "right");
    let edits: SymbolEdits = {};
    for (const [key, offset] of offsets) {
      edits = accumulateLabelShift(edits, key, offset.dx, offset.dy);
    }
    const symbol: NormalizedSymbol = {
      name: "TESTPART",
      refdesPrefix: "U",
      pcbFootprint: "",
      sections: [section],
      sourceJson: "{}",
    };
    const applied = applySymbolEdits(symbol, edits);
    const pins = applied.sections[0].pins;
    // 引脚端点原地不动（仍然贴边）
    expect(pins[0].connection).toEqual({ x: -10, y: 20 });
    expect(pins[1].connection).toEqual({ x: -10, y: 40 });
    expect(pins[0].body).toEqual({ x: 0, y: 20 });
    // 标签右边缘对齐
    const after = collectBoxes(applied.sections[0], keys);
    expect(after.get("p0:0")!.maxX).toBeCloseTo(after.get("p0:1")!.maxX, 6);
  });
});
