import { describe, expect, it } from "vitest";
import {
  applySelection,
  isRunnable,
  selectRunnableItems,
  shouldOfferRegeneration,
} from "../src/renderer/src/selection";
import { symbolSelectableKeys } from "../src/shared/symbol-labels";
import type {
  ConversionPlan,
  NormalizedFootprint,
  NormalizedSymbolSection,
  QueueItem,
} from "../src/shared/schemas";

const footprint = (): NormalizedFootprint => ({
  info: {
    lcscId: "C2040",
    name: "TEST",
    manufacturer: "",
    manufacturerPartNumber: "",
    sourcePackageName: "LQFN-56",
    targetPackageName: "LQFN-56_TEST",
    assemblyProcess: "SMT",
    description: "",
  },
  pads: [],
  holes: [],
  lines: [],
  circles: [],
  sourceOrigin: { x: 0, y: 0 },
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  model3d: null,
  sourceJson: "{}",
});

const plan: ConversionPlan = {
  footprint: footprint(),
  checks: [],
  padstackCount: 1,
  solderMaskExpansionMm: 0.05,
  pasteAreaRatio: 1,
};

const item = (patch: Partial<QueueItem> = {}): QueueItem => ({
  id: "C2040",
  state: "ready",
  footprint: footprint(),
  message: "",
  selected: true,
  ...patch,
});

const plans: Readonly<Record<string, ConversionPlan>> = { C2040: plan };

describe("generation eligibility", () => {
  it("keeps an already-generated item runnable so it can be regenerated", () => {
    // 回归防护（用户 2026-10-16 反馈）：生成成功后器件进入 generated 态，
    // 旧实现里按钮的 state 白名单不含 generated，按钮变灰后再也点不动。
    const generated = item({ state: "generated" });
    expect(isRunnable(generated, plans)).toBe(true);
    expect(selectRunnableItems([generated], plans)).toHaveLength(1);
  });

  it("treats failed and warning items as runnable too", () => {
    for (const state of ["ready", "warning", "generationFailed", "generated"] as const) {
      expect(isRunnable(item({ state }), plans)).toBe(true);
    }
  });

  it("excludes unchecked, unloaded and plan-less items", () => {
    expect(isRunnable(item({ selected: false }), plans)).toBe(false);
    expect(isRunnable(item({ footprint: null }), plans)).toBe(false);
    // 有计划表但缺该项（读取中途失败等）时不能生成
    expect(isRunnable(item({ id: "C9999" }), plans)).toBe(false);
    expect(isRunnable(item({ state: "loading" }), {})).toBe(false);
    expect(isRunnable(item({ state: "error" }), {})).toBe(false);
  });

  it("only offers regeneration when everything runnable has already been generated", () => {
    expect(shouldOfferRegeneration([])).toBe(false);
    expect(shouldOfferRegeneration([item({ state: "ready" })])).toBe(false);
    expect(
      shouldOfferRegeneration([item({ state: "generated" }), item({ state: "ready" })]),
    ).toBe(false);
    expect(
      shouldOfferRegeneration([item({ state: "generated" }), item({ state: "generated" })]),
    ).toBe(true);
  });
});

/**
 * 多选语义（用户 2026-10-20，参考 OrCAD）：
 *  - 普通点击/框选 = 替换
 *  - Shift+点击 = 追加
 *  - Ctrl/Cmd+点击 = 切换
 *  - Ctrl+A = 全选（与框选一致：排除本体 rect）
 */
const symbolSection = (): NormalizedSymbolSection => ({
  name: "TESTPART",
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  pins: [
    {
      name: "P1",
      number: "1",
      connection: { x: -10, y: 20 },
      body: { x: 0, y: 20 },
      length: 10,
      type: "passive",
      visible: true,
    },
    {
      name: "P2",
      number: "2",
      connection: { x: -10, y: 40 },
      body: { x: 0, y: 40 },
      length: 10,
      type: "passive",
      visible: true,
    },
  ],
  shapes: [
    { kind: "rect", min: { x: 0, y: 0 }, max: { x: 100, y: 60 }, cornerRadius: 0, filled: false },
    { kind: "text", text: "TXT", at: { x: 10, y: 30 }, rotation: 0, height: 10 },
  ],
});

describe("symbol selection modes", () => {
  it("replace 整体替换", () => {
    expect(applySelection(["a", "b"], ["c"], "replace")).toEqual(["c"]);
  });

  it("add 取并集且不重复", () => {
    expect(applySelection(["a"], ["b", "a"], "add")).toEqual(["a", "b"]);
  });

  it("toggle 有则移除、无则加入", () => {
    expect(applySelection(["a", "b"], ["a"], "toggle")).toEqual(["b"]);
    expect(applySelection(["a"], ["b"], "toggle")).toEqual(["a", "b"]);
  });
});

describe("select all keys", () => {
  it("包含全部引脚与非 rect 图形，排除本体", () => {
    const keys = symbolSelectableKeys(symbolSection(), 0);
    expect(keys).toContain("p0:0");
    expect(keys).toContain("p0:1");
    expect(keys).toContain("0:1");
    // 本体（0:0）不参与 —— 否则整体移动会把整个符号挪走
    expect(keys).not.toContain("0:0");
  });
});
