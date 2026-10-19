// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { SymbolPreview } from "../src/renderer/src/SymbolPreview";
import type { NormalizedSymbol } from "../src/shared/schemas";

/**
 * 用户 2026-10-19 报的回归："鼠标移动就让文本/引脚跟着跑"。
 *
 * 根因有两条，这里都钉住：
 *  1. 引脚 <g> 的 React key 里拼了 connection 坐标 → 拖动时每帧都卸载重建 →
 *     指针捕捉丢失 → 松手收不到 pointerup → dragRef 一直挂着；
 *  2. pointermove 不检查按键状态，只要 dragRef 还在就继续移动。
 */

const symbol: NormalizedSymbol = {
  name: "TESTPART",
  refdesPrefix: "U",
  pcbFootprint: "",
  sections: [
    {
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
        { kind: "rect", min: { x: 0, y: 0 }, max: { x: 100, y: 60 }, cornerRadius: 0, filled: false },
        { kind: "text", text: "TXT", at: { x: 10, y: 40 }, rotation: 0, height: 10 },
      ],
    },
  ],
  sourceJson: "{}",
};

const firePointer = (
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  options: { readonly x: number; readonly y: number; readonly buttons: number },
): void => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.x,
    clientY: options.y,
    button: 0,
    buttons: options.buttons,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  element.dispatchEvent(event);
};

beforeEach(() => {
  // jsdom 没有指针捕捉 API
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
});

const mount = (onMove: (keys: readonly string[], dx: number, dy: number) => void) => {
  const view = render(
    <SymbolPreview
      symbol={symbol}
      sectionIndex={0}
      scale={1}
      edits={{}}
      editing
      selectedKeys={new Set<string>()}
      onSelectKeys={() => {}}
      onMoveElements={onMove}
      onResizeRect={() => {}}
    />,
  );
  const draggable = view.container.querySelectorAll('[data-draggable="true"]');
  expect(draggable.length).toBeGreaterThan(0);
  return {
    pin: view.container.querySelector('[data-pin="true"]') as Element,
    shape: draggable[0] as Element,
  };
};

describe("symbol element dragging", () => {
  it("拖动时元素不重建（指针捕捉不会丢）", () => {
    const onMove = vi.fn();
    const { pin } = mount(onMove);
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 140, y: 100, buttons: 1 });
    expect(onMove).toHaveBeenCalledTimes(1);
    // 同一个 DOM 节点：key 若含坐标，这里会变成另一个节点
    expect(document.querySelector('[data-pin="true"]')).toBe(pin);
  });

  it("松开左键后再移动鼠标不再移动元素", () => {
    const onMove = vi.fn();
    const { pin } = mount(onMove);
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 140, y: 100, buttons: 1 });
    firePointer(pin, "pointerup", { x: 140, y: 100, buttons: 0 });
    const afterDrag = onMove.mock.calls.length;

    for (let step = 1; step <= 5; step += 1) {
      firePointer(pin, "pointermove", { x: 140 + step * 20, y: 100, buttons: 0 });
    }
    expect(onMove.mock.calls.length).toBe(afterDrag);
  });

  it("没收到 pointerup（捕捉丢了）时，无按键的移动也会停手", () => {
    const onMove = vi.fn();
    const { pin } = mount(onMove);
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 140, y: 100, buttons: 0 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("只是点一下（位移在死区内）不移动元素", () => {
    const onMove = vi.fn();
    const { pin } = mount(onMove);
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 102, y: 101, buttons: 1 });
    expect(onMove).not.toHaveBeenCalled();
  });

  /**
   * 用户 2026-10-19："引脚必须落在网格上才能连线"。
   * 组里有引脚时整组位移吸附到 10 单位（100 mil），预览位置 = 写进 .olb 的位置。
   */
  it("拖动引脚时位移吸附到 100 mil 网格，且累计位移不丢余量", () => {
    const onMove = vi.fn();
    const { pin } = mount(onMove);
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 133, y: 122, buttons: 1 });

    const [, dx, dy] = onMove.mock.calls[0] as [readonly string[], number, number];
    expect(Math.abs(dx % 10)).toBe(0);
    expect(Math.abs(dy % 10)).toBe(0);
    // 33 → 30，22 → 20（就近吸附，误差不超过半格）
    expect(Math.abs(dx - 33)).toBeLessThanOrEqual(5);
    expect(Math.abs(dy - 22)).toBeLessThanOrEqual(5);

    // 继续拖到 136：累计 36 → 40，这一步应再补 10
    firePointer(pin, "pointermove", { x: 136, y: 122, buttons: 1 });
    const [, dx2] = onMove.mock.calls[onMove.mock.calls.length - 1] as [
      readonly string[],
      number,
      number,
    ];
    expect(dx2).toBe(10);
  });

  /** 对照组：拖图形/文本（不含引脚）仍然自由移动，不吸附。 */
  it("拖图形元素不做网格吸附", () => {
    const onMove = vi.fn();
    const { shape } = mount(onMove);
    firePointer(shape, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(shape, "pointermove", { x: 133, y: 122, buttons: 1 });
    const [, dx, dy] = onMove.mock.calls[0] as [readonly string[], number, number];
    expect(dx).toBeCloseTo(33, 6);
    expect(dy).toBeCloseTo(22, 6);
  });
});
