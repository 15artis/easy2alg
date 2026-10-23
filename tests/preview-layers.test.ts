import { describe, expect, it } from "vitest";
import type { NormalizedFootprint, NormalizedPad } from "../src/shared/schemas";
import {
  defaultVisibleLayers,
  footprintLayers,
  footprintViewBounds,
  normalizeVisibleLayers,
} from "../src/shared/preview-layers";

const pad = (patch: Partial<NormalizedPad> = {}): NormalizedPad => ({
  number: "1",
  center: { x: 0, y: 0 },
  width: 1,
  height: 1,
  rotation: 0,
  shape: "rectangle",
  polygon: [],
  plated: true,
  holeWidth: 0,
  holeHeight: 0,
  sourceLayerId: 1,
  ...patch,
});

const footprint = (patch: Partial<NormalizedFootprint> = {}): NormalizedFootprint => ({
  info: {
    lcscId: "C2040",
    name: "TEST",
    manufacturer: "",
    manufacturerPartNumber: "",
    sourcePackageName: "QFN",
    targetPackageName: "QFN_TEST",
    assemblyProcess: "SMT",
    description: "",
  },
  pads: [pad(), pad({ number: "2", center: { x: 2, y: 0 } })],
  holes: [],
  lines: [
    { start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 0.15, layer: "silkscreen" },
    { start: { x: 0, y: 1 }, end: { x: 1, y: 1 }, width: 0.15, layer: "assembly" },
  ],
  circles: [],
  sourceOrigin: { x: 0, y: 0 },
  bounds: { minX: -1, minY: -1, maxX: 3, maxY: 2 },
  model3d: null,
  sourceJson: "{}",
  ...patch,
});

describe("PCB preview layers", () => {
  it("derives one entry per layer that actually has content", () => {
    const layers = footprintLayers(footprint());
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    expect(byId.get("pads")?.count).toBe(2);
    expect(byId.get("pinNumbers")?.count).toBe(2);
    expect(byId.get("silkscreen")?.count).toBe(1);
    expect(byId.get("assembly")?.count).toBe(1);
    // 表贴器件没有钻孔、也没有禁布区几何 → 不列出来
    expect(byId.has("holes")).toBe(false);
    expect(byId.has("courtyard")).toBe(false);
    expect(byId.has("documentation")).toBe(false);
  });

  it("counts through-hole pads and mechanical holes separately from SMD pads", () => {
    const layers = footprintLayers(
      footprint({
        pads: [pad(), pad({ number: "3", holeWidth: 0.8, holeHeight: 0.8 })],
        holes: [{ center: { x: 5, y: 5 }, diameter: 2 }],
      }),
    );
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    expect(byId.get("holes")?.count).toBe(2);
    // 钢网只覆盖表贴焊盘
    expect(byId.get("pasteMask")?.count).toBe(1);
  });

  it("keeps Allegro layer names alongside the Chinese label", () => {
    const byId = new Map(footprintLayers(footprint()).map((layer) => [layer.id, layer]));
    expect(byId.get("pads")?.allegro).toBe("PIN");
    expect(byId.get("solderMask")?.allegro).toBe("SOLDERMASK_TOP");
    expect(byId.get("silkscreen")?.allegro).toContain("SILKSCREEN_TOP");
  });

  it("drops stale selections but never leaves the canvas empty", () => {
    const layers = footprintLayers(footprint());
    const defaults = defaultVisibleLayers(layers);
    expect(defaults.has("pads")).toBe(true);
    expect(defaults.has("pinNumbers")).toBe(true);
    // 钢网默认关掉，免得盖住焊盘
    expect(defaults.has("pasteMask")).toBe(false);

    // 换器件后旧 id 不存在 → 只保留仍存在的
    const kept = normalizeVisibleLayers(layers, new Set(["pads", "documentation"]));
    expect([...kept]).toEqual(["pads"]);

    // 全被过滤掉时回落到默认可见集，而不是空白画布
    expect([...normalizeVisibleLayers(layers, new Set())].sort()).toEqual(
      [...defaults].sort(),
    );
  });
});

/**
 * 用户 2026-10-22：PCB 预览缩在画布中间 —— 源 bounds 把远大于本体的 courtyard
 * 也算进去了。适应窗口只按焊盘取景。
 */
describe("pcb preview view bounds", () => {
  it("忽略远处的 courtyard / 丝印，只按焊盘取景（外扩 6%）", () => {
    const part = footprint({
      pads: [pad({ center: { x: -3.5, y: 0 } }), pad({ center: { x: 3.5, y: 0 } })],
      lines: [
        // 离谱的大外框：bounds 会到 ±20
        { start: { x: -20, y: -20 }, end: { x: 20, y: -20 }, width: 0.1, layer: "courtyard" },
        { start: { x: -20, y: 20 }, end: { x: 20, y: 20 }, width: 0.1, layer: "courtyard" },
      ],
      bounds: { minX: -20, minY: -20, maxX: 20, maxY: 20 },
    });
    const box = footprintViewBounds(part);
    // 焊盘含宽度后跨度 8（-4..4），外扩 6%（0.48）→ ±4.48
    expect(box.minX).toBeCloseTo(-4.48, 6);
    expect(box.maxX).toBeCloseTo(4.48, 6);
  });

  it("没有焊盘时退回原 bounds", () => {
    const part = footprint({ pads: [], bounds: { minX: -1, minY: -2, maxX: 3, maxY: 4 } });
    expect(footprintViewBounds(part)).toEqual({ minX: -1, minY: -2, maxX: 3, maxY: 4 });
  });
});
