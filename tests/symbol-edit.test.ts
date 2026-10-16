import { describe, expect, it } from "vitest";
import type { NormalizedSymbol } from "../src/shared/schemas";
import {
  applySymbolEdits,
  EMPTY_SYMBOL_EDITS,
  hasSymbolEdits,
  symbolShapeKey,
  translateSymbolShape,
} from "../src/shared/symbol-edit";
import { sanitizeLibraryName } from "../src/shared/naming";

const symbol = (): NormalizedSymbol => ({
  name: "TESTPART",
  refdesPrefix: "U",
  pcbFootprint: "TESTPART",
  sections: [
    {
      name: "SEC0",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      pins: [],
      shapes: [
        { kind: "rect", min: { x: 0, y: 0 }, max: { x: 100, y: 100 }, cornerRadius: 0, filled: false },
        {
          kind: "polyline",
          points: [
            { x: 0, y: 50 },
            { x: 100, y: 50 },
          ],
          closed: false,
        },
        { kind: "text", text: "LABEL", at: { x: 10, y: 20 }, rotation: 0, height: 12 },
      ],
    },
    {
      name: "SEC1",
      bounds: { minX: 0, minY: 0, maxX: 50, maxY: 50 },
      pins: [],
      shapes: [
        { kind: "text", text: "OTHER", at: { x: 5, y: 5 }, rotation: 0, height: 12 },
      ],
    },
  ],
  sourceJson: "{}",
});

describe("symbol shape translation", () => {
  it("moves rect / polyline / text by the same offset", () => {
    const base = symbol().sections[0].shapes;
    expect(translateSymbolShape(base[0], 3, -4)).toEqual({
      kind: "rect",
      min: { x: 3, y: -4 },
      max: { x: 103, y: 96 },
      cornerRadius: 0,
      filled: false,
    });
    expect(translateSymbolShape(base[1], 3, -4)).toEqual({
      kind: "polyline",
      points: [
        { x: 3, y: 46 },
        { x: 103, y: 46 },
      ],
      closed: false,
    });
    expect(translateSymbolShape(base[2], 3, -4)).toEqual({
      kind: "text",
      text: "LABEL",
      at: { x: 13, y: 16 },
      rotation: 0,
      height: 12,
    });
    // 旋转角度不随平移改变
    const textShape = base[2];
    expect(textShape.kind).toBe("text");
    if (textShape.kind !== "text") return;
    expect(translateSymbolShape({ ...textShape, rotation: 90 }, 1, 1)).toMatchObject({
      rotation: 90,
    });
  });

  it("applies edits only to the addressed section/shape", () => {
    const base = symbol();
    const moved = applySymbolEdits(base, {
      [symbolShapeKey(0, 2)]: { dx: 40, dy: -7 },
      [symbolShapeKey(1, 0)]: { dx: 1, dy: 2 },
    });
    // 目标元素移动
    expect(moved.sections[0].shapes[2]).toMatchObject({ at: { x: 50, y: 13 } });
    expect(moved.sections[1].shapes[0]).toMatchObject({ at: { x: 6, y: 7 } });
    // 同段其它元素不动
    expect(moved.sections[0].shapes[0]).toEqual(base.sections[0].shapes[0]);
    expect(moved.sections[0].shapes[1]).toEqual(base.sections[0].shapes[1]);
    // 原对象不被就地修改（state 里要保持不可变）
    expect(base.sections[0].shapes[2]).toMatchObject({ at: { x: 10, y: 20 } });
  });

  it("returns the same object when there is nothing to apply", () => {
    const base = symbol();
    expect(applySymbolEdits(base, EMPTY_SYMBOL_EDITS)).toBe(base);
    expect(hasSymbolEdits(EMPTY_SYMBOL_EDITS)).toBe(false);
    expect(hasSymbolEdits({ [symbolShapeKey(0, 0)]: { dx: 0, dy: 0 } })).toBe(true);
  });
});

describe("library name sanitizing", () => {
  it("upper-cases and strips characters Allegro/Capture reject", () => {
    expect(sanitizeLibraryName("pex8748-baca")).toBe("PEX8748-BACA");
    expect(sanitizeLibraryName("PEX8748 CA80BC G")).toBe("PEX8748-CA80BC-G");
    // 非 ASCII（这里是 ×）先被剥掉再补分隔符 —— 与 main 侧 naming.ts 的行为一致
    expect(sanitizeLibraryName("  FCBGA-676_L27.0×27.0  ")).toBe("FCBGA-676_L27-027-0");
    expect(sanitizeLibraryName("PEX--8748__")).toBe("PEX-8748");
    expect(sanitizeLibraryName("封装名")).toBe("");
  });

  it("caps the length so Allegro accepts the name", () => {
    expect(sanitizeLibraryName("A".repeat(60))).toHaveLength(31);
  });
});
