import { describe, expect, it } from "vitest";
import { sectionPreviewBounds, selectionBox } from "../src/shared/symbol-labels";
import { symbolPinKey, symbolShapeKey } from "../src/shared/symbol-edit";
import type { NormalizedSymbolSection } from "../src/shared/schemas";

/**
 * 用户 2026-10-20："缩放到选中"要能把编辑后的内容完整框进来。
 * 旧实现只取解析阶段的 `section.bounds` —— 本体被拖大、文字被拖出界后会被裁掉。
 */
const section = (): NormalizedSymbolSection => ({
  name: "TESTPART",
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  pins: [
    {
      name: "P1",
      number: "1",
      connection: { x: -20, y: 20 },
      body: { x: 0, y: 20 },
      length: 20,
      type: "passive",
      visible: true,
    },
  ],
  shapes: [
    // 本体被用户拖大到 160×100
    { kind: "rect", min: { x: 0, y: 0 }, max: { x: 160, y: 100 }, cornerRadius: 0, filled: false },
    // 文字被拖到本体右侧外
    { kind: "text", text: "OUTSIDE", at: { x: 200, y: 30 }, rotation: 0, height: 10 },
    { kind: "polyline", closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 70 }] },
  ],
});

describe("symbol preview bounds", () => {
  it("previewBounds 覆盖被编辑过的本体与拖出界的文字", () => {
    const box = sectionPreviewBounds(section());
    expect(box.minX).toBeLessThanOrEqual(-20);
    expect(box.maxX).toBeGreaterThanOrEqual(200);
    expect(box.maxY).toBeGreaterThanOrEqual(100);
  });

  it("selectionBox 取多个元素的并集", () => {
    const part = section();
    const box = selectionBox(part, [
      symbolShapeKey(0, 0),
      symbolPinKey(0, 0),
    ]);
    expect(box).not.toBeNull();
    expect(box!.minX).toBeLessThanOrEqual(-20);
    expect(box!.maxX).toBeGreaterThanOrEqual(160);
  });

  it("selectionBox 对空选择/非法键返回 null", () => {
    expect(selectionBox(section(), [])).toBeNull();
    expect(selectionBox(section(), ["0:99", "p0:99"])).toBeNull();
  });
});
