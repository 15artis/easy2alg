import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEasyEdaSymbol } from "../src/main/conversion/easyeda-symbol";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
import { applySymbolEdits } from "../src/shared/symbol-edit";
import { alignPinEndsToGrid } from "../src/shared/symbol-layout";
import type { NormalizedSymbol, NormalizedSymbolSection } from "../src/shared/schemas";

/**
 * 用户 2026-10-19：**原理图符号**的引脚必须落在 Capture 的 100 mil 网格上，
 * 否则在原理图里连不上线。
 *
 * 解析阶段 `alignPinsToGrid` 已经把整排平移对齐；但用户随后在预览里拖动元素，
 * offset 是像素 ÷ 缩放算出来的任意小数，连接端会重新离开网格。所以写库出口
 * （`buildCaptureLibraryXml`）再做一次 `snapPinsToGrid` 兜底。
 */

const section = (): NormalizedSymbolSection => ({
  name: "TESTPART",
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  pins: [
    {
      name: "LEFT",
      number: "1",
      connection: { x: -14, y: 23 },
      body: { x: 0, y: 23 },
      length: 14,
      type: "passive",
      visible: true,
    },
    {
      name: "TOP",
      number: "2",
      connection: { x: 47, y: -14 },
      body: { x: 47, y: 0 },
      length: 14,
      type: "passive",
      visible: true,
    },
  ],
  shapes: [
    { kind: "rect", min: { x: 0, y: 0 }, max: { x: 100, y: 60 }, cornerRadius: 0, filled: false },
  ],
});

const symbol = (): NormalizedSymbol => ({
  name: "TESTPART",
  refdesPrefix: "U",
  pcbFootprint: "",
  sections: [section()],
  sourceJson: "{}",
});

const hotPoints = (xml: string): readonly (readonly [number, number])[] =>
  [...xml.matchAll(/hotptX="(-?\d+)" hotptY="(-?\d+)"/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);

describe("原理图符号引脚落入 100 mil 网格", () => {
  it("排方向整脚平移、引脚长度方向只挪连接端", () => {
    const snapped = alignPinEndsToGrid(section());

    // 左脚：y 23 → 20（connection 与 body 一起动，引脚长度不变）
    expect(snapped.pins[0].connection).toEqual({ x: -10, y: 20 });
    expect(snapped.pins[0].body).toEqual({ x: 0, y: 20 });

    // 上脚：x 47 → 50（整脚横移），y -14 → -10（只动连接端，body 仍贴本体 0）
    expect(snapped.pins[1].connection).toEqual({ x: 50, y: -10 });
    expect(snapped.pins[1].body).toEqual({ x: 50, y: 0 });
  });

  it("已经对齐的符号原样返回（不产生无意义的复制）", () => {
    const aligned = alignPinEndsToGrid(section());
    expect(alignPinEndsToGrid(aligned)).toBe(aligned);
  });

  it("用户在预览里拖过之后，写库的 hotpt 仍然是 10 的整数倍", () => {
    // 模拟拖动：像素 ÷ scale 出来的是小数
    const edited = applySymbolEdits(symbol(), {
      "p0:0": { offset: { dx: 3.4, dy: 7.2 } },
      "p0:1": { offset: { dx: -2.7, dy: 4.9 } },
    });
    const xml = buildCaptureLibraryXml(edited, "C:/libs/test.OLB");
    const points = hotPoints(xml);
    expect(points.length).toBe(2);
    for (const [x, y] of points) {
      expect(Math.abs(x % 10)).toBe(0);
      expect(Math.abs(y % 10)).toBe(0);
    }
  });

  it("关闭吸附（snapPins:false）时按实际坐标写入，但仍取整", () => {
    const edited = applySymbolEdits(symbol(), {
      "p0:0": { offset: { dx: 3.4, dy: 7.2 } },
    });
    const xml = buildCaptureLibraryXml(edited, "C:/libs/test.OLB", { snapPins: false });
    const points = hotPoints(xml);
    expect(points.length).toBe(2);
    for (const [x, y] of points) {
      // XSD 只收整数：无论吸附开关如何，写出去的一定是整数
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
    // 至少有一个坐标不再落在 10 的倍数上（说明确实没有强制吸附）
    expect(points.some(([x, y]) => x % 10 !== 0 || y % 10 !== 0)).toBe(true);
  });
});

/**
 * 两颗真实器件（夹具 `easyeda-pins.json` 是接口响应原文）。
 *
 * 用户 2026-11-10：「生成的图 OrCAD 尺寸需要满足引脚落在网格上，也就是 100 mil；
 * 预览能够准确，实物就不正常。」SACB5.0 的引脚原本 `startY=4`、长 15 —— 两端都不在
 * 10 的整数倍上；预览按自己的坐标画得准，Capture 里就是歪的。
 */
describe("真实器件：引脚两端都落在 100 mil 网格", () => {
  const fixtures = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/easyeda-pins.json", import.meta.url)), "utf8"),
  ) as Record<string, { title: string; dataStr: unknown }>;

  const parse = (lcscId: string): NormalizedSymbol => {
    const symbol = parseEasyEdaSymbol(fixtures[lcscId].dataStr, {
      lcscId,
      fallbackName: fixtures[lcscId].title,
      pcbFootprint: "",
    });
    if (symbol === null) {
      throw new Error(`解析失败：${lcscId}`);
    }
    return symbol;
  };

  it("SACB5.0：本体与引脚一起下移 4，引脚落在 0/30，长度取整到 20", () => {
    const [section] = parse("C3699281").sections;
    const [top, bottom] = section.pins;
    expect(top.body).toEqual({ x: 10, y: 0 });
    expect(top.connection).toEqual({ x: 10, y: -20 });
    expect(bottom.body).toEqual({ x: 10, y: 30 });
    expect(bottom.connection).toEqual({ x: 10, y: 50 });
    expect(top.length).toBe(20);

    // 图元跟着一起挪：上三角的顶点正好是上脚的本体端（不能只挪引脚留下缝）
    const apex = section.shapes.find(
      (shape) => shape.kind === "polyline" && shape.closed && shape.points.length === 3,
    );
    if (apex?.kind !== "polyline") {
      throw new Error("缺少三角形");
    }
    expect(apex.points).toContainEqual({ x: 10, y: 0 });
  });

  it("SMA-KWE：五条脚两端都在格点上，右脚贴住本体右边缘", () => {
    const [section] = parse("C7498154").sections;
    for (const pin of section.pins) {
      for (const point of [pin.body, pin.connection]) {
        expect(Math.abs(point.x % 10)).toBe(0);
        expect(Math.abs(point.y % 10)).toBe(0);
      }
      expect(Math.abs(pin.length % 10)).toBe(0);
    }
    const body = section.shapes.find((shape) => shape.kind === "rect");
    if (body?.kind !== "rect") {
      throw new Error("缺少本体矩形");
    }
    expect(section.pins[0].body.x).toBe(body.max.x);
  });
});
