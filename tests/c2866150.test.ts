import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEasyEdaSymbol } from "../src/main/conversion/easyeda-symbol";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
import { dedupePinNames } from "../src/shared/symbol-normalize";
import { bodyBoxOf, pinLabelAnchors, symbolKeysInBox } from "../src/shared/symbol-labels";
import { applySymbolEdits, symbolPinKey, symbolShapeKey } from "../src/shared/symbol-edit";
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

  it("引脚名去重：**所有**同名的都拼上引脚号（含第一个）", () => {
    const pins = parse();
    const names = pins.map((pin) => pin.name);
    expect(new Set(names).size).toBe(names.length);
    // GND 6 个、VCC 2 个、VCCOA/VCCOB 各 2 个 —— 全都带引脚号，没有裸名字
    const gnds = pins.filter((pin) => pin.name.startsWith("GND"));
    expect(gnds.length).toBe(6);
    for (const pin of gnds) {
      expect(pin.name).toBe(`GND_${pin.number}`);
    }
    expect(names).not.toContain("GND");
    expect(names).not.toContain("VCC");
    expect(names).toContain("VCC_15");
    expect(names).toContain("VCC_42");
    expect(names).toContain("VCCOA_5");
    expect(names).toContain("VCCOA_8");
    // 唯一名字保持原样
    expect(names).toContain("OSCin");
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

/**
 * 引脚文字锚点（用户 2026-10-19 反馈"框选后拖引脚，标签不跟着走 / 拖本体标签乱跑"）。
 * 锚点在解析时冻结到引脚上，所以：拖引脚 → 标签同位移；拖本体 → 标签不动。
 */
describe("引脚文字锚点", () => {
  const symbol = () =>
    parseEasyEdaSymbol(fixture.dataStr, {
      lcscId: "C2866150",
      fallbackName: fixture.title,
      pcbFootprint: "WQFN-48_L7.0-W7.0-P0.50-BL-EP5.1",
    })!;

  it("解析后每个引脚都有名字/编号锚点，且与本体盒推导一致", () => {
    const section = symbol().sections[0];
    const body = bodyBoxOf(section);
    for (const pin of section.pins) {
      expect(pin.labelAnchor).toBeDefined();
      const expected = pinLabelAnchors({ ...pin, labelAnchor: undefined }, body);
      expect(pin.labelAnchor!.name.x).toBeCloseTo(expected.name.x, 6);
      expect(pin.labelAnchor!.number.y).toBeCloseTo(expected.number.y, 6);
    }
  });

  it("移动引脚时锚点一起平移（标签与引脚不分离）", () => {
    const base = symbol();
    const section = base.sections[0];
    const pin = section.pins[0];
    const dx = 37;
    const dy = -21;
    const moved = applySymbolEdits(base, {
      [symbolPinKey(0, 0)]: { offset: { dx, dy } },
    });
    const after = moved.sections[0].pins[0];
    expect(after.body.x).toBe(pin.body.x + dx);
    expect(after.labelAnchor!.name.x).toBe(pin.labelAnchor!.name.x + dx);
    expect(after.labelAnchor!.name.y).toBe(pin.labelAnchor!.name.y + dy);
    expect(after.labelAnchor!.number.x).toBe(pin.labelAnchor!.number.x + dx);
    expect(after.labelAnchor!.number.y).toBe(pin.labelAnchor!.number.y + dy);
    // 引脚与标签的相对距离不变
    expect(after.body.y - after.labelAnchor!.name.y).toBeCloseTo(
      pin.body.y - pin.labelAnchor!.name.y,
      6,
    );
  });

  it("移动本体时锚点不动（标签跟着引脚，不跟着本体）", () => {
    const base = symbol();
    const rectKey = symbolShapeKey(0, 0);
    const pin = base.sections[0].pins[0];
    const moved = applySymbolEdits(base, {
      [rectKey]: { offset: { dx: 50, dy: 50 } },
    });
    expect(moved.sections[0].pins[0].labelAnchor).toEqual(pin.labelAnchor);
  });
});

/**
 * 框选命中规则（用户 2026-10-19 反馈"移动了旧的选择"）：
 * 本体框**不参与框选** —— 否则贴边框选总会把本体捎上，拖动时多出一堆东西跟着动。
 * 本体框要用鼠标点它的线选中。
 */
describe("框选命中", () => {
  const section = (): NormalizedSymbolSection =>
    parseEasyEdaSymbol(fixture.dataStr, {
      lcscId: "C2866150",
      fallbackName: fixture.title,
      pcbFootprint: "WQFN-48_L7.0-W7.0-P0.50-BL-EP5.1",
    })!.sections[0];

  it("框在内部：只选中引脚，不选中本体", () => {
    const current = section();
    const body = bodyBoxOf(current);
    const inside = {
      minX: body.minX + 40,
      minY: body.minY + 40,
      maxX: body.minX + 80,
      maxY: body.minY + 80,
    };
    const keys = symbolKeysInBox(current, 0, inside);
    expect(keys).not.toContain(symbolShapeKey(0, 0));
  });

  it("框越过本体边界：本体仍然不参与框选", () => {
    const current = section();
    const body = bodyBoxOf(current);
    const crossing = {
      minX: body.minX - 10,
      minY: body.minY + 20,
      maxX: body.minX + 10,
      maxY: body.minY + 40,
    };
    expect(symbolKeysInBox(current, 0, crossing)).not.toContain(symbolShapeKey(0, 0));
  });

  it("框住引脚线与它的文字：同一个引脚键只出现一次", () => {
    const current = section();
    const pin = current.pins[0];
    const label = pin.labelAnchor!.name;
    const box = {
      minX: Math.min(pin.connection.x, label.x) - 6,
      minY: Math.min(pin.connection.y, label.y) - 6,
      maxX: Math.max(pin.connection.x, label.x) + 20,
      maxY: Math.max(pin.connection.y, label.y) + 6,
    };
    const keys = symbolKeysInBox(current, 0, box);
    expect(keys.filter((key) => key === symbolPinKey(0, 0)).length).toBe(1);
    expect(keys).toContain(symbolPinKey(0, 0));
  });
});

describe("dedupePinNames（单元）", () => {  const pin = (number: string, name: string) => ({
    name,
    number,
    connection: { x: 0, y: 0 },
    body: { x: 0, y: 0 },
    length: 10,
    type: "passive" as const,
    visible: true,
  });

  it("同名引脚全部带引脚号；不同名的引脚不动", () => {
    const section = {
      name: "S",
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      shapes: [],
      pins: [pin("1", "VCC"), pin("2", "GND"), pin("3", "GND"), pin("4", "IO"), pin("5", "GND")],
    } as NormalizedSymbolSection;
    // VCC / IO 只出现一次 → 原名；GND ×3 → 三个都带引脚号
    expect(dedupePinNames(section).pins.map((p) => p.name)).toEqual([
      "VCC",
      "GND_2",
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
