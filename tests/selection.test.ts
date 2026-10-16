import { describe, expect, it } from "vitest";
import {
  isRunnable,
  selectRunnableItems,
  shouldOfferRegeneration,
} from "../src/renderer/src/selection";
import type { ConversionPlan, NormalizedFootprint, QueueItem } from "../src/shared/schemas";

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
