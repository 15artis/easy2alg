import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Elibz2Connector } from "../src/main/connectors/elibz2-connector";
import {
  bodyBoxOf,
  boxesOverlap,
  commentTextBox,
  estimateLabelWidth,
  pinIsVertical,
  pinNameBox,
  pinNumberBox,
  pinSideOf,
  type SymbolBox,
} from "../src/shared/symbol-labels";
import { avoidLabelOverlap, avoidLabelOverlapInSection } from "../src/shared/symbol-layout";
import type { NormalizedSymbol, NormalizedSymbolSection } from "../src/shared/schemas";

const fixturePath = fileURLToPath(new URL("./fixtures/pex8748.elibz2", import.meta.url));
const deviceUuid = "fc36ffe4397f472eb9c124285f536c2c";

/** 一段里所有标签盒（引脚名 + 引脚号），带可读标识。 */
const labelBoxes = (section: NormalizedSymbolSection): { id: string; box: SymbolBox }[] => {
  const body = bodyBoxOf(section);
  return section.pins.flatMap((pin) => [
    { id: `${pin.number}:name`, box: pinNameBox(pin, body) },
    { id: `${pin.number}:number`, box: pinNumberBox(pin, body) },
  ]);
};

/** 返回所有相交的标签对（空数组 = 没重叠）。 */
const collisions = (section: NormalizedSymbolSection): string[] => {
  const boxes = labelBoxes(section);
  const found: string[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxesOverlap(boxes[i].box, boxes[j].box)) {
        found.push(`${boxes[i].id} × ${boxes[j].id}`);
      }
    }
  }
  return found;
};

const pin = (
  name: string,
  number: string,
  connection: { x: number; y: number },
  body: { x: number; y: number },
) => ({
  name,
  number,
  connection,
  body,
  length: Math.abs(connection.x - body.x) + Math.abs(connection.y - body.y),
  type: "passive" as const,
  visible: true,
});

/** 一个"本体太窄"的合成符号：左右长名 + 上下一排竖脚。 */
const narrowSection = (): NormalizedSymbolSection => ({
  name: "SEC",
  bounds: { minX: -10, minY: -10, maxX: 110, maxY: 110 },
  shapes: [
    { kind: "rect", min: { x: 0, y: 0 }, max: { x: 100, y: 100 }, cornerRadius: 0, filled: false },
  ],
  pins: [
    ...Array.from({ length: 4 }, (_, index) =>
      pin(
        `LEFT_SIGNAL_${index}`,
        `L${index}`,
        { x: -10, y: 20 + index * 10 },
        { x: 0, y: 20 + index * 10 },
      ),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      pin(
        `RIGHT_SIGNAL_${index}`,
        `R${index}`,
        { x: 110, y: 20 + index * 10 },
        { x: 100, y: 20 + index * 10 },
      ),
    ),
    ...Array.from({ length: 3 }, (_, index) =>
      pin(
        `TOP_${index}`,
        `T${index}`,
        { x: 10 + index * 30, y: -10 },
        { x: 10 + index * 30, y: 0 },
      ),
    ),
  ],
});

describe("label de-overlap", () => {
  it("leaves sections without vertical pins untouched", () => {
    const section = narrowSection();
    const onlyHorizontal: NormalizedSymbolSection = {
      ...section,
      pins: section.pins.filter((item) => !pinIsVertical(item)),
    };
    const before = JSON.stringify(onlyHorizontal);
    expect(JSON.stringify(avoidLabelOverlapInSection(onlyHorizontal))).toBe(before);
  });

  it("widens the body so the vertical pins clear both name bands", () => {
    const section = narrowSection();
    const adjusted = avoidLabelOverlapInSection(section);
    // 本体确实被加宽了（上下一排竖脚本体不够宽）
    const widthBefore = bodyBoxOf(section).maxX - bodyBoxOf(section).minX;
    const widthAfter = bodyBoxOf(adjusted).maxX - bodyBoxOf(adjusted).minX;
    expect(widthAfter).toBeGreaterThan(widthBefore);

    // 加宽后本体左上角仍在 (0,0)（Capture 本体锚点约定）
    const body = bodyBoxOf(adjusted);
    expect(body.minX).toBe(0);
    expect(body.minY).toBe(0);

    // 右侧引脚跟着右边缘一起走，左侧引脚原地不动
    const rightBefore = section.pins.filter((item) => pinSideOf(item) === "right");
    const rightAfter = adjusted.pins.filter((item) => pinSideOf(item) === "right");
    for (let index = 0; index < rightBefore.length; index += 1) {
      expect(rightAfter[index].connection.x).toBe(rightBefore[index].connection.x + (widthAfter - widthBefore));
    }
    const leftBefore = section.pins.filter((item) => pinSideOf(item) === "left");
    const leftAfter = adjusted.pins.filter((item) => pinSideOf(item) === "left");
    for (let index = 0; index < leftBefore.length; index += 1) {
      expect(leftAfter[index].connection).toEqual(leftBefore[index].connection);
    }
    expect(collisions(adjusted)).toEqual([]);
  });

  it("keeps the vertical pins' order and spacing while shifting them", () => {
    const section = narrowSection();
    const adjusted = avoidLabelOverlapInSection(section);
    const before = section.pins.filter(pinIsVertical);
    const after = adjusted.pins.filter(pinIsVertical);
    expect(after).toHaveLength(before.length);
    for (let index = 1; index < after.length; index += 1) {
      expect(after[index].connection.x - after[index - 1].connection.x).toBe(
        before[index].connection.x - before[index - 1].connection.x,
      );
    }
  });

  it("shifts vertical pins by a multiple of the 5-unit grid", () => {
    const adjusted = avoidLabelOverlapInSection(narrowSection());
    for (const item of adjusted.pins.filter(pinIsVertical)) {
      expect(item.connection.x % 5).toBe(0);
    }
  });

  it("removes every label collision in the real 676-pin fixture", async () => {
    // 用户 2026-10-16 截图：竖排引脚名压在横排引脚名上（四角重叠）。
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    expect(symbol).not.toBeNull();
    const sections = symbol!.sections;
    expect(sections).toHaveLength(6);
    for (const section of sections) {
      expect(collisions(section), `${section.name} 仍有标签重叠`).toEqual([]);
    }
  });

  it("keeps the geometry sane for every section of the fixture", async () => {
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    for (const section of symbol!.sections) {
      const body = bodyBoxOf(section);
      // 锚点约定 + 加宽只往右，不会出现负的原点
      expect(body.minX).toBe(0);
      expect(body.minY).toBe(0);
      // 加宽有上界：不能为了避让把本体撑到离谱（源符号本体都 ≤ 950 单位宽）
      expect(body.maxX).toBeLessThan(1300);
      // 每一段仍然是一个 RECT
      expect(section.shapes.filter((shape) => shape.kind === "rect")).toHaveLength(1);
    }
  });

  it("is idempotent — running it twice changes nothing", async () => {
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    const once: NormalizedSymbol = avoidLabelOverlap(symbol!);
    const twice = avoidLabelOverlap(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("nudges a region label that would land on a pin name", () => {
    // 合成：一个 3 字符区域标注压在一个 6 字符引脚名（`SIGNAL`，含窄字符 I）的尾端。Capture 的引脚名字宽比
    // 立创EDA 大，源符号里"刚好不挨着"的标注会压上去（用户截图里的 JTAG）。
    const section: NormalizedSymbolSection = {
      name: "SEC",
      bounds: { minX: -10, minY: 0, maxX: 210, maxY: 100 },
      shapes: [
        { kind: "rect", min: { x: 0, y: 0 }, max: { x: 200, y: 100 }, cornerRadius: 0, filled: false },
        { kind: "text", text: "TAG", at: { x: 30, y: 46 }, rotation: 0, height: 12 },
      ],
      pins: [pin("SIGNAL", "1", { x: -10, y: 50 }, { x: 0, y: 50 })],
    };
    expect(boxesOverlap(commentTextBox(section.shapes[1] as never), pinNameBox(section.pins[0], bodyBoxOf(section)))).toBe(true);

    const adjusted = avoidLabelOverlapInSection(section);
    const text = adjusted.shapes.find((shape) => shape.kind === "text");
    expect(text?.kind === "text" ? text.at : null).toEqual({ x: 35, y: 46 });
    // 挪完确实不再压引脚名
    const moved = adjusted.shapes.find((shape) => shape.kind === "text");
    expect(moved?.kind).toBe("text");
    if (moved?.kind === "text") {
      expect(boxesOverlap(commentTextBox(moved), pinNameBox(adjusted.pins[0], bodyBoxOf(adjusted)))).toBe(false);
    }
  });

  it("keeps every region label clear of pin labels in the real fixture", async () => {
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    for (const section of symbol!.sections) {
      const body = bodyBoxOf(section);
      const labels = section.pins.flatMap((item) => [
        pinNameBox(item, body),
        pinNumberBox(item, body),
      ]);
      for (const shape of section.shapes) {
        if (shape.kind !== "text") {
          continue;
        }
        const box = commentTextBox(shape);
        const hit = labels.some((label) => boxesOverlap(box, label));
        expect(hit, `${section.name} 的 "${shape.text}" 仍压在引脚标签上`).toBe(false);
      }
    }
  });

  it("estimates label width from measured raster metrics", () => {
    // 实机截图标定：`PEX_NT_PERST#`(13 字符) 占 ≈64 单位
    expect(estimateLabelWidth("PEX_NT_PERST#")).toBeGreaterThanOrEqual(60);
    expect(estimateLabelWidth("PEX_NT_PERST#")).toBeLessThanOrEqual(70);
    // 窄字符明显更窄
    expect(estimateLabelWidth("1111")).toBeLessThan(estimateLabelWidth("WWWW"));
  });
});
