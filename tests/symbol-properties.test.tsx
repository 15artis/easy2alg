// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SymbolInspector } from "../src/renderer/src/SymbolInspector";
import { symbolPinKey, symbolShapeKey, type SymbolEdits } from "../src/shared/symbol-edit";
import { writeSelectionStroke } from "../src/shared/symbol-property";
import type { NormalizedSymbolSection } from "../src/shared/schemas";

/**
 * 用户 2026-11-11：右侧新增「属性编辑」tab，覆盖文本 / 线段 / 圆 / 矩形等，
 * 可改内容、尺寸、线宽线型。这里钉住"按类型显示对应字段"与提交口径 ——
 * 真正的读写换算在 symbol-props.test.ts（纯函数）。
 */
const section = (): NormalizedSymbolSection => ({
  name: "TESTPART",
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  pins: [
    {
      name: "P1",
      number: "1",
      connection: { x: -10, y: 20 },
      body: { x: 0, y: 20 },
      length: 10,
      type: "passive",
      visible: true,
    },
  ],
  shapes: [
    { kind: "rect", min: { x: 10, y: 10 }, max: { x: 110, y: 70 }, cornerRadius: 0, filled: false },
    { kind: "text", text: "TXT", at: { x: 20, y: 40 }, rotation: 0, height: 10 },
    {
      kind: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 30, y: 40 },
      ],
      closed: false,
      added: true,
    },
    {
      kind: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
      closed: true,
      primitive: { type: "ellipse", center: { x: 0, y: 0 }, rx: 10, ry: 10 },
      added: true,
    },
  ],
});

const handlers = () => ({
  onField: vi.fn(),
  onStroke: vi.fn(),
  onTextStyle: vi.fn(),
  onPinType: vi.fn(),
  onPinSide: vi.fn(),
  onTextContent: vi.fn(),
  onDelete: vi.fn(),
});

const mount = (
  keys: readonly string[],
  overrides: Partial<ReturnType<typeof handlers>> = {},
  edits: SymbolEdits = {},
) => {
  const spies = { ...handlers(), ...overrides };
  const view = render(
    <SymbolInspector
      section={section()}
      edits={edits}
      selectedKeys={keys}
      snap={{ enabled: true, grid: 10 }}
      {...spies}
    />,
  );
  return { view, ...spies };
};

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.querySelector(`[data-testid="${id}"]`) as T;
}

afterEach(() => {
  cleanup();
});

describe("symbol inspector (right rail)", () => {
  it("没有选中时给提示，不渲染字段", () => {
    mount([]);
    expect(byTestId("symbol-inspector")).not.toBeNull();
    expect(document.querySelector('[data-testid="prop-x"]')).toBeNull();
  });

  it("文本：内容、字号、旋转、粗体/斜体都在", () => {
    mount([symbolShapeKey(0, 1)]);
    expect(byTestId<HTMLTextAreaElement>("prop-text").value).toBe("TXT");
    expect(byTestId("prop-text-height")).not.toBeNull();
    expect(byTestId("prop-rotation")).not.toBeNull();
    expect(byTestId("prop-bold")).not.toBeNull();
    expect(byTestId("prop-italic")).not.toBeNull();
  });

  it("文本内容在失焦时整段提交", () => {
    const { onTextContent } = mount([symbolShapeKey(0, 1)]);
    const area = byTestId<HTMLTextAreaElement>("prop-text");
    fireEvent.change(area, { target: { value: "GND\n3V" } });
    fireEvent.blur(area);
    expect(onTextContent).toHaveBeenCalledWith("GND\n3V");
  });

  it("粗体按钮把当前状态取反", () => {
    const { onTextStyle } = mount([symbolShapeKey(0, 1)]);
    fireEvent.click(byTestId("prop-bold"));
    expect(onTextStyle).toHaveBeenCalledWith({ bold: true });
  });

  it("矩形：宽高字段，改了直接提交（并且按吸附档位落格）", () => {
    const { onField } = mount([symbolShapeKey(0, 0)]);
    fireEvent.change(byTestId("prop-width"), { target: { value: "47" } });
    fireEvent.keyDown(byTestId("prop-width"), { key: "Enter" });
    // 47 吸附到 50（grid=10）
    expect(onField).toHaveBeenCalledWith("width", 50);
  });

  it("线段：四个端点 + 只读长度/角度", () => {
    mount([symbolShapeKey(0, 2)]);
    expect(byTestId("prop-line-x1")).not.toBeNull();
    expect(byTestId("prop-line-y2")).not.toBeNull();
    // 0,0 → 30,40 长度 50、角度约 53.13°
    expect(document.body.textContent).toContain("50");
    expect(document.body.textContent).toContain("53.13");
  });

  it("圆：只给半径（不给宽高）", () => {
    mount([symbolShapeKey(0, 3)]);
    expect(byTestId("prop-radius")).not.toBeNull();
    expect(document.querySelector('[data-testid="prop-width"]')).toBeNull();
  });

  it("引脚：编号/名称只读走行内编辑，面板给长度、方向、类型", () => {
    mount([symbolPinKey(0, 0)]);
    expect(byTestId("prop-pin-length")).not.toBeNull();
    expect(byTestId("prop-pin-side")).not.toBeNull();
    expect(byTestId("prop-pin-type")).not.toBeNull();
  });

  it("线宽/线型下拉触发 onStroke", () => {
    const { onStroke } = mount([symbolShapeKey(0, 0)]);
    fireEvent.change(byTestId("prop-line-width"), { target: { value: "2" } });
    expect(onStroke).toHaveBeenCalledWith({ lineWidth: 2 });
  });

  /**
   * 用户 2026-11-11 报的 bug：线型切到别的再回来看，下拉仍然是"实线"。
   * 面板读的必须是"原始值 + 编辑"，否则选了也白选。
   */
  it("改过线型后下拉显示新值（不会弹回实线）", () => {
    const edits = writeSelectionStroke(section(), {}, [symbolShapeKey(0, 0)], { lineStyle: 2 });
    mount([symbolShapeKey(0, 0)], {}, edits);
    expect(byTestId<HTMLSelectElement>("prop-line-style").value).toBe("2");
  });

  it("多选时显示共同线型；不一致才显示「不同」", () => {
    const same = writeSelectionStroke(section(), {}, [symbolShapeKey(0, 0), symbolShapeKey(0, 2)], {
      lineStyle: 4,
    });
    mount([symbolShapeKey(0, 0), symbolShapeKey(0, 2)], {}, same);
    expect(byTestId<HTMLSelectElement>("prop-line-style").value).toBe("4");
    cleanup();
    const mixed = writeSelectionStroke(section(), {}, [symbolShapeKey(0, 0)], { lineStyle: 1 });
    mount([symbolShapeKey(0, 0), symbolShapeKey(0, 2)], {}, mixed);
    expect(byTestId<HTMLSelectElement>("prop-line-style").value).toBe("-1");
  });

  /**
   * 下拉只列 Capture 常规 5 种，但源库里可能本来就存着表外值 ——
   * 没有对应 <option> 时 select 会显示空白（看着像"没值"），必须补一条兜底项。
   */
  it("表外线型兜底成「线型 N」，不会显示空白", () => {
    // 绕开 setLineStyle 的 0..5 夹取，直接构造"源库里存着 7"这种编辑值
    const key = symbolShapeKey(0, 0);
    mount([key], {}, { [key]: { lineStyle: 7 } });
    const select = byTestId<HTMLSelectElement>("prop-line-style");
    expect(select.value).toBe("7");
    expect(select.options[select.selectedIndex]?.textContent).toBe("线型 7");
  });

  it("多选只给批量描边，并显示选中数量", () => {
    mount([symbolShapeKey(0, 0), symbolShapeKey(0, 2)]);
    expect(document.body.textContent).toContain("已选 2 项");
    expect(byTestId("prop-line-width")).not.toBeNull();
    expect(document.querySelector('[data-testid="prop-x"]')).toBeNull();
  });

  it("源库本体不给删除按钮（几何是别人的）", () => {
    mount([symbolShapeKey(0, 0)]);
    expect(document.querySelector('[data-testid="prop-delete"]')).toBeNull();
  });

  it("文本与手画图形可以删除", () => {
    mount([symbolShapeKey(0, 1)]);
    expect(byTestId("prop-delete")).not.toBeNull();
    cleanup();
    mount([symbolShapeKey(0, 2)]);
    expect(byTestId("prop-delete")).not.toBeNull();
  });
});
