import { describe, expect, it } from "vitest";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
import { applySymbolEdits } from "../src/shared/symbol-edit";
import { alignPinEndsToGrid, snapPinsToGrid } from "../src/shared/symbol-layout";
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
    const snapped = snapPinsToGrid(section());

    // 左脚：y 23 → 20（connection 与 body 一起动，引脚长度不变）
    expect(snapped.pins[0].connection).toEqual({ x: -10, y: 20 });
    expect(snapped.pins[0].body).toEqual({ x: 0, y: 20 });

    // 上脚：x 47 → 50（整脚横移），y -14 → -10（只动连接端，body 仍贴本体 0）
    expect(snapped.pins[1].connection).toEqual({ x: 50, y: -10 });
    expect(snapped.pins[1].body).toEqual({ x: 50, y: 0 });
  });

  it("已经对齐的符号原样返回（不产生无意义的复制）", () => {
    const aligned = snapPinsToGrid(section());
    expect(snapPinsToGrid(aligned)).toBe(aligned);
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
 * 用户 2026-11-10：「注意 OrCAD 应该需要按照网格上，有些是不需要网格吸附」。
 *
 * 本机 Cadence 自带 `Discrete.olb` 的 7023 个引脚**全部**是两端都在 10 单位格点上、
 * 长度只有 10/30；立创的符号却常用 15 单位引脚、本体端落在半格（SACB5.0 的
 * `startY=4` 就在三角形顶点上）。这样的 .olb 放进 Capture，引脚比本体短一截、
 * 连接端对不上格。
 */
describe("引脚两端都落到 100 mil 格点", () => {
  const tvs = (): NormalizedSymbolSection => ({
    name: "SACB5.0",
    bounds: { minX: 1, minY: -16, maxX: 20, maxY: 46 },
    pins: [
      {
        name: "1",
        number: "1",
        connection: { x: 10, y: -11 },
        body: { x: 10, y: 4 },
        length: 15,
        type: "passive",
        visible: true,
      },
      {
        name: "2",
        number: "2",
        connection: { x: 10, y: 49 },
        body: { x: 10, y: 34 },
        length: 15,
        type: "passive",
        visible: true,
      },
    ],
    shapes: [
      // 三角形顶点 (10,4) 正好是上脚的本体端
      {
        kind: "polyline",
        points: [
          { x: 4, y: 14 },
          { x: 10, y: 4 },
          { x: 17, y: 14 },
        ],
        closed: true,
      },
      { kind: "polyline", points: [{ x: 1, y: 34 }, { x: 20, y: 34 }], closed: false },
    ],
  });

  it("两端落格、长度取 10 的整数倍", () => {
    const aligned = alignPinEndsToGrid(tvs());
    for (const pin of aligned.pins) {
      for (const point of [pin.connection, pin.body]) {
        expect(Math.abs(point.x % 10)).toBe(0);
        expect(Math.abs(point.y % 10)).toBe(0);
      }
      expect(pin.length % 10).toBe(0);
      expect(pin.length).toBeGreaterThanOrEqual(10);
    }
    expect(aligned.pins.map((pin) => pin.length)).toEqual([20, 20]);
  });

  it("图元跟着引脚一起挪，顶点仍然贴着引脚本体端（不会裂开一道缝）", () => {
    const aligned = alignPinEndsToGrid(tvs());
    const triangle = aligned.shapes[0];
    if (triangle.kind !== "polyline") {
      throw new Error("应为折线");
    }
    const apex = triangle.points[1];
    expect(apex).toEqual(aligned.pins[0].body);
  });

  it("已经合规的符号原样返回（不产生无意义的复制）", () => {
    const once = alignPinEndsToGrid(tvs());
    expect(alignPinEndsToGrid(once)).toBe(once);
  });

  it("本体端余数不一致时（标签避让推歪过）沿引脚轴单独补格", () => {
    const mixed = tvs();
    const section: NormalizedSymbolSection = {
      ...mixed,
      pins: [
        mixed.pins[0],
        mixed.pins[1],
        {
          name: "5",
          number: "5",
          connection: { x: 66, y: 10 },
          body: { x: 46, y: 10 },
          length: 20,
          type: "passive",
          visible: true,
        },
      ],
    };
    const aligned = alignPinEndsToGrid(section);
    const side = aligned.pins[2];
    expect(side.body).toEqual({ x: 50, y: 10 });
    expect(side.connection).toEqual({ x: 70, y: 10 });
  });
});
