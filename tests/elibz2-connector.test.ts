import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Elibz2Connector } from "../src/main/connectors/elibz2-connector";
import { createAllegroSourceBundle } from "../src/main/conversion/allegro-skill";
import { createConversionPlan } from "../src/main/conversion/validate";

const fixturePath = fileURLToPath(new URL("./fixtures/pex8748.elibz2", import.meta.url));

const closeTo = (expected: number, tolerance = 0.01) => ({
  expected,
  tolerance,
  matches: (actual: number) => Math.abs(actual - expected) <= tolerance,
});

describe("elibz2 connector", () => {
  it("lists devices from the library archive", async () => {
    const connector = new Elibz2Connector();
    const summaries = await connector.readLibrary(fixturePath);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary.lcscId).toBe("C1522695");
    expect(summary.footprintTitle).toBe("pex8748_baca");
    expect(summary.padCount).toBe(676);
    expect(summary.manufacturerPartNumber).toBe("PEX8748-CA80BC G");
    expect(summary.sourcePath).toBe(fixturePath);
  });

  it("maps the FCBGA-676 footprint without flipping Y", async () => {
    const connector = new Elibz2Connector();
    const footprint = await connector.loadFootprint(fixturePath, "fc36ffe4397f472eb9c124285f536c2c");

    expect(footprint.pads).toHaveLength(676);
    expect(footprint.info.lcscId).toBe("C1522695");
    expect(footprint.info.sourcePackageName).toBe("pex8748_baca");
    expect(footprint.info.assemblyProcess).toBe("SMT");
    expect(footprint.info.manufacturer).toContain("Broadcom");

    // A1：行 A 自上而下，y 应为 +12.5 mm（Pro 文档 Y 轴向上，不取反）
    const a1 = footprint.pads.find((pad) => pad.number === "A1");
    expect(a1).toBeDefined();
    expect(a1!.center.x).toBeCloseTo(-12.5, 3);
    expect(a1!.center.y).toBeCloseTo(12.5, 3);
    expect(a1!.width).toBeCloseTo(0.49, 3);
    expect(a1!.height).toBeCloseTo(0.49, 3);
    expect(a1!.shape).toBe("circle");
    expect(a1!.holeWidth).toBe(0);

    // 行号递增 → y 递减：AF1 在最下面一行
    const af1 = footprint.pads.find((pad) => pad.number === "AF1");
    expect(af1).toBeDefined();
    expect(af1!.center.y).toBeCloseTo(-12.5, 3);

    // A26：最右列
    const a26 = footprint.pads.find((pad) => pad.number === "A26");
    expect(a26).toBeDefined();
    expect(a26!.center.x).toBeCloseTo(12.5, 3);

    // 丝印：4 条外框线（27mm 方形）+ 1 个 pin1 实心圆点
    expect(footprint.lines).toHaveLength(4);
    expect(footprint.lines.every((line) => line.layer === "silkscreen")).toBe(true);
    const silkX = footprint.lines.flatMap((line) => [line.start.x, line.end.x]);
    expect(silkX.some((value) => Math.abs(value - 13.5) < 0.001)).toBe(true);
    expect(silkX.some((value) => Math.abs(value + 13.5) < 0.001)).toBe(true);
    expect(footprint.circles).toHaveLength(1);
    expect(footprint.circles[0].radius).toBeCloseTo(0.3, 3);
    expect(footprint.circles[0].layer).toBe("silkscreen");
    // pin1 圆点位于 A1 左上角外侧
    expect(footprint.circles[0].center.x).toBeCloseTo(-13.97, 3);
    expect(footprint.circles[0].center.y).toBeCloseTo(13.97, 3);

    // bounds：由丝印外框 ±13.5 与 pin1 圆点（中心 13.97 ± 半径 0.3）共同决定
    const minXM = closeTo(-14.27);
    const maxYM = closeTo(14.27);
    expect(minXM.matches(footprint.bounds.minX)).toBe(true);
    expect(maxYM.matches(footprint.bounds.maxY)).toBe(true);
    expect(footprint.bounds.maxX).toBeCloseTo(13.5, 3);
    expect(footprint.bounds.minY).toBeCloseTo(-13.5, 3);

    expect(footprint.holes).toHaveLength(0);
    expect(footprint.model3d).toBeNull();
  });

  it("passes downstream plan validation and derives a single padstack", async () => {
    const connector = new Elibz2Connector();
    const footprint = await connector.loadFootprint(fixturePath, "fc36ffe4397f472eb9c124285f536c2c");
    const plan = createConversionPlan(footprint);
    expect(plan.padstackCount).toBe(1);
    expect(plan.checks.find((check) => check.id === "pin-count")?.severity).toBe("pass");
    expect(plan.checks.find((check) => check.id === "pin-numbers")?.severity).toBe("pass");
    expect(plan.checks.find((check) => check.id === "pad-dimensions")?.severity).toBe("pass");
    // 回归防护: 此前 axlDBCreateCircle 把 center/radius 包进同一 list 并多传 width,
    // 导致 Allegro 17.4 解析 SKILL 时硬崩 (PEX8748 42% 处, allegro.jrl 为空)。
    const bundle = createAllegroSourceBundle(plan, "C:\\Temp\\e2a-pex8748");
    const skill = bundle.sources.find((source) => source.relativePath === "build.il");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain(
      'axlDBCreateCircle(-13.97:13.97 0.3 "PACKAGE GEOMETRY/SILKSCREEN_TOP")',
    );
    expect(skill!.content).not.toContain("axlDBCreateCircle(list(");
  });

  it("rejects unknown device uuids", async () => {
    const connector = new Elibz2Connector();
    await expect(connector.loadFootprint(fixturePath, "not-a-uuid")).rejects.toThrow(
      /未找到器件/,
    );
  });
});
