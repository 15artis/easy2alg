import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEasyEdaSymbol } from "../src/main/conversion/easyeda-symbol";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
import { dedupePinNames } from "../src/shared/symbol-normalize";
import type { NormalizedSymbolSection } from "../src/shared/schemas";

/**
 * C2866150（LMK00301ARHST）：用户 2026-10-19 反馈"无法创建原理图元件"。
 *
 * 两条独立缺陷都在这个器件上暴露：
 *  1. 极性圆点（E 记录，半径 1.5）按 24 边形近似后坐标带小数，而 XMATIC 的
 *     XSD 对 `<Line>` 的坐标只收 `[+\-]?[0-9]+` → 整库导入失败；
 *  2. 49 个引脚里 GND ×6、VCC ×2、VCCOA ×2、VCCOB ×2 —— Cadence 侧不接受
 *     重复的引脚文本，需要去重。
 *
 * 夹具是真实接口响应的 dataStr（只留 head/shape/BBox），别手改。
 */
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/easyeda-c2866150.json", import.meta.url)), "utf8"),
) as { title: string; dataStr: unknown };

const parse = (): NormalizedSymbolSection["pins"] => {
  const symbol = parseEasyEdaSymbol(fixture.dataStr, {
    lcscId: "C2866150",
    fallbackName: fixture.title,
    pcbFootprint: "WQFN-48_L7.0-W7.0-P0.50-BL-EP5.1",
  })!;
  return symbol.sections[0].pins;
};

describe("C2866150（LMK00301ARHST）", () => {
  it("49 个引脚全部解析出来", () => {
    expect(parse().length).toBe(49);
  });

  it("引脚名去重：同名的第二个起拼上引脚号", () => {
    const pins = parse();
    const names = pins.map((pin) => pin.name);
    expect(new Set(names).size).toBe(names.length);
    // 第一个 GND 保持原名，后续的带引脚号
    const gnds = pins.filter((pin) => pin.name.startsWith("GND"));
    expect(gnds.length).toBeGreaterThan(1);
    expect(gnds[0].name).toBe("GND");
    for (const pin of gnds.slice(1)) {
      expect(pin.name).toBe(`GND_${pin.number}`);
    }
  });

  it("写库坐标全为整数（小数会让 XMATIC 整库导入失败）", () => {
    const symbol = parseEasyEdaSymbol(fixture.dataStr, {
      lcscId: "C2866150",
      fallbackName: fixture.title,
      pcbFootprint: "WQFN-48_L7.0-W7.0-P0.50-BL-EP5.1",
    })!;
    const xml = buildCaptureLibraryXml(symbol, "C:/libs/lmk.OLB");
    const coordinates = [
      ...xml.matchAll(/\b(x1|x2|y1|y2|hotptX|hotptY|startX|startY|locX|locY)="([^"]*)"/g),
    ];
    expect(coordinates.length).toBeGreaterThan(100);
    expect(coordinates.filter((m) => !/^-?\d+$/.test(m[2])).map((m) => `${m[1]}=${m[2]}`)).toEqual([]);
    // 引脚编号在库文件里仍然唯一
    const numbers = [...xml.matchAll(/<PinNumber>\s*<Defn number="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("dedupePinNames（单元）", () => {
  const pin = (number: string, name: string) => ({
    name,
    number,
    connection: { x: 0, y: 0 },
    body: { x: 0, y: 0 },
    length: 10,
    type: "passive" as const,
    visible: true,
  });

  it("首个保留原名，后续附加引脚号；不同名的引脚不动", () => {
    const section = {
      name: "S",
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      shapes: [],
      pins: [pin("1", "VCC"), pin("2", "GND"), pin("3", "GND"), pin("4", "IO"), pin("5", "GND")],
    } as NormalizedSymbolSection;
    expect(dedupePinNames(section).pins.map((p) => p.name)).toEqual([
      "VCC",
      "GND",
      "GND_3",
      "IO",
      "GND_5",
    ]);
  });

  it("没有重复时原样返回（保持对象引用，避免无谓重渲染）", () => {
    const section = {
      name: "S",
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      shapes: [],
      pins: [pin("1", "A"), pin("2", "B")],
    } as NormalizedSymbolSection;
    expect(dedupePinNames(section)).toBe(section);
  });
});
