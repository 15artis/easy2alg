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
  const pin = view.container.querySelectorAll('[data-draggable="true"]')[0];
  expect(pin).toBeTruthy();
  return pin as Element;
};

describe("symbol element dragging", () => {
  it("拖动时元素不重建（指针捕捉不会丢）", () => {
    const onMove = vi.fn();
    const pin = mount(onMove);
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 140, y: 100, buttons: 1 });
    expect(onMove).toHaveBeenCalledTimes(1);
    // 同一个 DOM 节点：key 若含坐标，这里会变成另一个节点
    expect(document.querySelectorAll('[data-draggable="true"]')[0]).toBe(pin);
  });

  it("松开左键后再移动鼠标不再移动元素", () => {
    const onMove = vi.fn();
    const pin = mount(onMove);
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
    const pin = mount(onMove);
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 140, y: 100, buttons: 0 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("只是点一下（位移在死区内）不移动元素", () => {
    const onMove = vi.fn();
    const pin = mount(onMove);
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 102, y: 101, buttons: 1 });
    expect(onMove).not.toHaveBeenCalled();
  });
});
