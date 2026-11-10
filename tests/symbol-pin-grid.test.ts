import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEasyEdaSymbol } from "../src/main/conversion/easyeda-symbol";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
import { applySymbolEdits } from "../src/shared/symbol-edit";
import { alignBodyToGrid, alignPinEndsToGrid } from "../src/shared/symbol-layout";
import { bodyBoxOf } from "../src/shared/symbol-labels";
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
 * 三颗真实器件（夹具 `easyeda-pins.json` 是接口响应原文）。
 *
 * 用户 2026-11-10：「生成的图 OrCAD 尺寸需要满足引脚落在网格上，也就是 100 mil；
 * 预览能够准确，实物就不正常。」SACB5.0 的引脚原本 `startY=4`、长 15 —— 两端都不在
 * 10 的整数倍上；预览按自己的坐标画得准，Capture 里就是歪的。
 */
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

describe("真实器件：引脚两端都落在 100 mil 网格", () => {

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

  it("SMA-KWE：五条脚两端都在格点上，5 号脚穿出本体右边缘", () => {
    const [section] = parse("C7498154").sections;
    for (const pin of section.pins) {
      for (const point of [pin.body, pin.connection]) {
        expect(Math.abs(point.x % 10)).toBe(0);
        expect(Math.abs(point.y % 10)).toBe(0);
      }
      expect(Math.abs(pin.length % 10)).toBe(0);
    }
    const body = bodyBoxOf(section);
    // 5 号脚从本体**内部**起画、穿出右边缘（立创原图就是这样：本体 387..414、脚从 410 引出）
    const right = section.pins.find((pin) => pin.number === "5");
    expect(right?.body.x).toBeLessThan(body.maxX);
    expect(right?.connection.x).toBeGreaterThan(body.maxX);
  });

  it("SMA-KWE：两个矩形都转线段，本体打 body 标记", () => {
    const [section] = parse("C7498154").sections;
    // 用户 2026-11-10：「出现了两个矩形图应该都使用线段，不要使用矩形」——
    // 一只 RECT 就是 Capture 的「本体」，会把框内的引脚裁掉（5 号脚实体被裁成空白）
    expect(section.shapes.filter((shape) => shape.kind === "rect")).toHaveLength(0);
    const closed = section.shapes.filter(
      (shape): shape is Extract<typeof shape, { kind: "polyline" }> =>
        shape.kind === "polyline" && shape.closed && shape.points.length === 4,
    );
    expect(closed).toHaveLength(2);
    // 外壳（源 340..377×290..310，归一化后 -50..-13）也是四段闭合折线
    const shell = closed.find(
      (shape) => Math.min(...shape.points.map((point) => point.x)) === -50,
    );
    expect(shell).toBeDefined();
    // 本体（引脚本体端压得最多的那只）带标记，布局据此算标签落点
    const body = closed.find((shape) => shape.kind === "polyline" && shape.body === true);
    expect(body).toBeDefined();
  });

  it("引脚按脚号排序：立创数组顺序不按号排（SMA-KWE 是 5,4,3,2,1）", () => {
    const [section] = parse("C7498154").sections;
    expect(section.pins.map((pin) => pin.number)).toEqual(["1", "2", "3", "4", "5"]);
    // 排序后 position（数组下标）与脚号一致，Capture 才不会把名字和编号错开画
    expect(section.pins.map((pin) => pin.name)).toEqual(["1", "2", "3", "4", "5"]);
    expect(section.pins[0].body).toEqual({ x: 0, y: 0 });
  });

  it("SMA-KWE：本体不再为（被关掉的）引脚名让位而加宽", () => {
    const [section] = parse("C7498154").sections;
    const body = bodyBoxOf(section);
    // 立创原图 27 宽 → 收到 30（曾经被撑到 50，用户 2026-11-10：「怎么这么大」）
    expect(body.maxX - body.minX).toBe(30);
    expect(body.maxY - body.minY).toBe(20);
  });
});

/**
 * 用户 2026-11-10（第二次）：「可以看到生成的……不在网格上，这是有问题，
 * 正常的一个框内部引脚原理图符号 应该需要按照网格进行」。
 *
 * 截图（SN74LVC1G17DBVR）里框的下边压在两行网格线**之间**：立创画的本体是
 * 33×62，左右/上下四条边只有左上角在格点上。引脚早已两端落格，框却没落，
 * 预览一眼就能看出来，进 Capture 也一样对不齐。
 */
describe("本体矩形也落在 100 mil 网格", () => {
  const framed = (): NormalizedSymbolSection => ({
    name: "FRAME",
    bounds: { minX: -11, minY: 0, maxX: 33, maxY: 62 },
    pins: [
      {
        name: "A",
        number: "1",
        connection: { x: -10, y: 10 },
        body: { x: 0, y: 10 },
        length: 10,
        type: "passive",
        visible: true,
      },
      {
        name: "B",
        number: "2",
        connection: { x: 43, y: 30 },
        body: { x: 33, y: 30 },
        length: 10,
        type: "passive",
        visible: true,
      },
    ],
    shapes: [
      { kind: "rect", min: { x: 0, y: 0 }, max: { x: 33, y: 62 }, cornerRadius: 2, filled: false },
      // 横贯本体的分隔线：右端贴住本体的右边
      {
        kind: "polyline",
        points: [
          { x: 0, y: 20 },
          { x: 33, y: 20 },
        ],
        closed: false,
      },
      // 反相圆圈：采样折线带 primitive，只可能有一个点碰到边，不能挪
      {
        kind: "polyline",
        points: [
          { x: 1.5, y: 3 },
          { x: 3, y: 4.5 },
        ],
        closed: true,
        primitive: { type: "ellipse", center: { x: 3, y: 3 }, rx: 1.5, ry: 1.5 },
      },
    ],
  });

  it("锚点取格点、长宽取 10 的倍数（33×62 → 30×60）", () => {
    const shape = alignBodyToGrid(framed()).shapes[0];
    if (shape.kind !== "rect") {
      throw new Error("缺少本体矩形");
    }
    expect(shape.min).toEqual({ x: 0, y: 0 });
    expect(shape.max).toEqual({ x: 30, y: 60 });
  });

  it("贴边引脚跟着边走，连接端仍在格点上，长度还是 10 的整数倍", () => {
    const [left, right] = alignBodyToGrid(framed()).pins;
    // 左脚贴左边缘（0 未动）
    expect(left.body).toEqual({ x: 0, y: 10 });
    expect(left.connection).toEqual({ x: -10, y: 10 });
    // 右脚贴右边缘：33 → 30，连接端跟着落到 40（原来是 43）
    expect(right.body).toEqual({ x: 30, y: 30 });
    expect(right.connection).toEqual({ x: 40, y: 30 });
    expect(right.length).toBe(10);
  });

  it("贴边折线端点跟着走，椭圆/圆弧采样折线不动", () => {
    const source = framed();
    const shapes = alignBodyToGrid(source).shapes;
    const divider = shapes[1];
    if (divider.kind !== "polyline") {
      throw new Error("缺少分隔线");
    }
    expect(divider.points).toEqual([
      { x: 0, y: 20 },
      { x: 30, y: 20 },
    ]);
    // 椭圆采样折线原样保留（挪一个采样点会把圆啃出一个口）
    expect(shapes[2]).toBe(source.shapes[2]);
  });

  it("已经落在网格上的本体原样返回（不产生无意义的复制）", () => {
    const aligned = alignBodyToGrid(framed());
    expect(alignBodyToGrid(aligned)).toBe(aligned);
  });

  it("真实器件 SN74LVC1G17DBVR：本体 33×62 收敛到 30×60", () => {
    const [section] = parse("C7836").sections;
    const body = section.shapes.find((shape) => shape.kind === "rect");
    if (body?.kind !== "rect") {
      throw new Error("缺少本体矩形");
    }
    expect(Math.abs(body.min.x % 10)).toBe(0);
    expect(Math.abs(body.max.x % 10)).toBe(0);
    expect(Math.abs(body.min.y % 10)).toBe(0);
    expect(Math.abs(body.max.y % 10)).toBe(0);
    expect(body.max.x - body.min.x).toBe(30);
    expect(body.max.y - body.min.y).toBe(60);
    // 引脚仍然两端落格，并且 1/2/3/4/5 都在左边缘上一字排开
    for (const pin of section.pins) {
      for (const point of [pin.body, pin.connection]) {
        expect(Math.abs(point.x % 10)).toBe(0);
        expect(Math.abs(point.y % 10)).toBe(0);
      }
      expect(pin.body.x).toBe(body.min.x);
    }
  });
});
