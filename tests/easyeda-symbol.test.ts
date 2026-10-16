import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEasyEdaSymbol } from "../src/main/conversion/easyeda-symbol";
import {
  bodyBoxOf,
  boxesOverlap,
  pinNameBox,
  pinNumberBox,
  pinIsVertical,
  pinSideOf,
} from "../src/shared/symbol-labels";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
import type { NormalizedSymbol } from "../src/shared/schemas";

/**
 * 立创编号（在线 EasyEDA 标准版）链路的原理图符号。
 *
 * 夹具是两个真实接口响应的 `dataStr` 摘录（C2040 = RP2040 57 脚、C7955 = LM393 8 脚），
 * 只保留解析需要的 head / shape / BBox。别手改这两份数据 —— 它们是格式的唯一依据。
 */
const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/easyeda-symbols.json", import.meta.url)), "utf8"),
) as Record<string, { title: string; dataStr: unknown }>;

const parse = (lcscId: string): NormalizedSymbol | null =>
  parseEasyEdaSymbol(fixtures[lcscId].dataStr, {
    lcscId,
    fallbackName: fixtures[lcscId].title,
    pcbFootprint: "PKG_UNDER_TEST",
  });

const labelCollisions = (symbol: NormalizedSymbol): number => {
  let count = 0;
  for (const section of symbol.sections) {
    const body = bodyBoxOf(section);
    const boxes = section.pins.flatMap((pin) => [pinNameBox(pin, body), pinNumberBox(pin, body)]);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (boxesOverlap(boxes[i], boxes[j])) {
          count += 1;
        }
      }
    }
  }
  return count;
};

describe("easyeda standard symbol", () => {
  it("parses the 57-pin RP2040 symbol from the same response as the footprint", () => {
    const symbol = parse("C2040");
    expect(symbol).not.toBeNull();
    expect(symbol!.name).toBe("RP2040");
    expect(symbol!.refdesPrefix).toBe("U");
    expect(symbol!.pcbFootprint).toBe("PKG_UNDER_TEST");
    expect(symbol!.sections).toHaveLength(1);
    expect(symbol!.sections[0].pins).toHaveLength(57);
  });

  it("puts every pin's body end exactly on the body rect, and anchors it at (0,0)", () => {
    // 源数据里本体在 (285,100)-(515,480)，引脚本体端就在这两条边上 ——
    // 平移归零后必须仍然精确落在矩形边上（这是"映射正确"的硬证据）。
    const symbol = parse("C2040")!;
    const section = symbol.sections[0];
    const body = bodyBoxOf(section);
    expect(body).toEqual({ minX: 0, minY: 0, maxX: 270, maxY: 380 });
    const onEdge = section.pins.filter((pin) => {
      const onX = Math.abs(pin.body.x - body.minX) < 1e-6 || Math.abs(pin.body.x - body.maxX) < 1e-6;
      const onY = Math.abs(pin.body.y - body.minY) < 1e-6 || Math.abs(pin.body.y - body.maxY) < 1e-6;
      return onX !== onY;
    });
    expect(onEdge).toHaveLength(section.pins.length);
    // 引脚长度 10、间距 10（源符号单位 = Capture 符号单位，不做换算）
    expect(section.pins.every((pin) => pin.length === 10)).toBe(true);
  });

  it("maps pin sides from the EasyEDA rotation (0=右 90=上 180=左 270=下)", () => {
    const section = parse("C2040")!.sections[0];
    const sides = section.pins.reduce<Record<string, number>>((counts, pin) => {
      const side = pinSideOf(pin);
      counts[side] = (counts[side] ?? 0) + 1;
      return counts;
    }, {});
    expect(sides).toEqual({ right: 32, left: 11, top: 12, bottom: 2 });
    // 上下边引脚必须是"竖排"的那批（写 .olb 时靠它决定 IsPinNamesRotated）
    expect(section.pins.filter(pinIsVertical)).toHaveLength(14);
  });

  it("maps the EasyEDA electric code to a Capture pin type", () => {
    const pins = parse("C2040")!.sections[0].pins;
    const byNumber = (number: string) => pins.find((pin) => pin.number === number)!;
    // 实测：RUN/XIN = 1(输入)、QSPI_SCLK/SWCLK = 2(输出)、GPIO = 3(双向)
    expect(byNumber("26").name).toBe("RUN");
    expect(byNumber("26").type).toBe("input");
    expect(byNumber("52").type).toBe("output");
    expect(byNumber("9").type).toBe("bidirectional");
  });

  it("approximates circles/ellipses as closed polylines (LM393 has two)", () => {
    const symbol = parse("C7955")!;
    const kinds = symbol.sections[0].shapes.map((shape) => shape.kind);
    expect(kinds.filter((kind) => kind === "polyline").length).toBeGreaterThanOrEqual(2);
    expect(symbol.sections[0].pins).toHaveLength(8);
  });

  it("de-collides pin labels on the C-number path too", () => {
    for (const id of ["C2040", "C7955"]) {
      expect(labelCollisions(parse(id)!), `${id} 仍有标签重叠`).toBe(0);
    }
  });

  it("produces a writable Capture library XML", () => {
    const symbol = parse("C2040")!;
    const xml = buildCaptureLibraryXml(symbol, "C:/libs/target.OLB");
    expect(xml).toContain('<Defn name="C:/libs/target.OLB" />');
    expect(xml).toContain('<Defn CellName="RP2040" />');
    expect(xml).toContain('pcbFootprint="PKG_UNDER_TEST"');
    expect(xml.match(/<SymbolPinScalar>/g)).toHaveLength(57);
    // 单段器件：字母编号关(2)、同质(1)
    expect(xml).toMatch(/alphabeticNumbering="2" isHomogeneous="1"/);
    // 有上下边引脚 → 引脚名旋转打开
    expect(xml).toContain('<IsPinNamesRotated>\n          <Defn val="1" />');
  });

  it("returns null when the source has no symbol data", () => {
    expect(parseEasyEdaSymbol(undefined, { lcscId: "C1", fallbackName: "X", pcbFootprint: "" })).toBeNull();
    expect(parseEasyEdaSymbol({}, { lcscId: "C1", fallbackName: "X", pcbFootprint: "" })).toBeNull();
    expect(
      parseEasyEdaSymbol({ shape: [] }, { lcscId: "C1", fallbackName: "X", pcbFootprint: "" }),
    ).toBeNull();
  });

  it("falls back to a safe library name when the source name has odd characters", () => {
    const symbol = parseEasyEdaSymbol(
      {
        head: { c_para: { name: "OPA2134 PA/BB (DIP)", pre: "U?" } },
        shape: ["R~0~0~~~100~50~#000000~1~0~none~g1~0~"],
      },
      { lcscId: "C9999", fallbackName: "X", pcbFootprint: "" },
    );
    expect(symbol?.name).toBe("OPA2134_PA_BB_DIP");
  });
});
