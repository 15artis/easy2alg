// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { SymbolPreview } from "../src/renderer/src/SymbolPreview";
import type { NormalizedSymbol } from "../src/shared/schemas";

/**
 * 用户 2026-10-19 报的回归："鼠标移动就让文本/引脚跟着跑"。
 * 用户 2026-10-20 起吸附覆盖全部元素（引脚/文本/图形/本体框线），本文件同时钉住：
 *  - 指针捕捉丢失后不再跟着鼠标走；
 *  - 吸附开关与 100/50 mil 两档；
 *  - Ctrl/Shift+点击只改选中、不启动拖动。
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
  options: {
    readonly x: number;
    readonly y: number;
    readonly buttons: number;
    readonly ctrlKey?: boolean;
    readonly shiftKey?: boolean;
  },
): void => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.x,
    clientY: options.y,
    button: 0,
    buttons: options.buttons,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
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

type Snap = { readonly enabled: boolean; readonly grid: number };

const mount = (
  options: {
    readonly snap?: Snap;
    readonly symbol?: NormalizedSymbol;
    readonly onMove?: (keys: readonly string[], dx: number, dy: number) => void;
    readonly onSelectKeys?: (
      keys: readonly string[],
      mode?: "replace" | "add" | "toggle",
    ) => void;
    readonly onResizeRect?: (
      key: string,
      bounds: { readonly min: { x: number; y: number }; readonly max: { x: number; y: number } },
      dragged: unknown,
    ) => void;
    readonly onReorientPins?: (
      entries: readonly {
        readonly key: string;
        readonly points: {
          readonly connection: { readonly x: number; readonly y: number };
          readonly body: { readonly x: number; readonly y: number };
        };
      }[],
    ) => void;
  } = {},
) => {
  const view = render(
    <SymbolPreview
      symbol={options.symbol ?? symbol}
      sectionIndex={0}
      scale={1}
      edits={{}}
      editing
      selectedKeys={new Set<string>()}
      onSelectKeys={options.onSelectKeys ?? (() => {})}
      onMoveElements={options.onMove ?? (() => {})}
      onResizeRect={
        (options.onResizeRect as never) ??
        (() => {
          /* 默认不关心的回调 */
        })
      }
      snap={options.snap}
      onReorientPins={options.onReorientPins}
    />,
  );
  const draggable = view.container.querySelectorAll('[data-draggable="true"]');
  expect(draggable.length).toBeGreaterThan(0);
  return {
    pin: view.container.querySelector('[data-pin="true"]') as Element,
    shape: draggable[0] as Element,
    stroke: view.container.querySelector('[data-hit="stroke"]') as Element,
  };
};

const drag = (
  element: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void => {
  firePointer(element, "pointerdown", { ...from, buttons: 1 });
  firePointer(element, "pointermove", { ...to, buttons: 1 });
};

describe("symbol element dragging", () => {
  it("拖动时元素不重建（指针捕捉不会丢）", () => {
    const onMove = vi.fn();
    const { pin } = mount({ onMove });
    drag(pin, { x: 100, y: 100 }, { x: 140, y: 100 });
    expect(onMove).toHaveBeenCalledTimes(1);
    // 同一个 DOM 节点：key 若含坐标，这里会变成另一个节点
    expect(document.querySelector('[data-pin="true"]')).toBe(pin);
  });

  it("松开左键后再移动鼠标不再移动元素", () => {
    const onMove = vi.fn();
    const { pin } = mount({ onMove });
    drag(pin, { x: 100, y: 100 }, { x: 140, y: 100 });
    firePointer(pin, "pointerup", { x: 140, y: 100, buttons: 0 });
    const afterDrag = onMove.mock.calls.length;

    for (let step = 1; step <= 5; step += 1) {
      firePointer(pin, "pointermove", { x: 140 + step * 20, y: 100, buttons: 0 });
    }
    expect(onMove.mock.calls.length).toBe(afterDrag);
  });

  it("没收到 pointerup（捕捉丢了）时，无按键的移动也会停手", () => {
    const onMove = vi.fn();
    const { pin } = mount({ onMove });
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 140, y: 100, buttons: 0 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("只是点一下（位移在死区内）不移动元素", () => {
    const onMove = vi.fn();
    const { pin } = mount({ onMove });
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1 });
    firePointer(pin, "pointermove", { x: 102, y: 101, buttons: 1 });
    expect(onMove).not.toHaveBeenCalled();
  });

  /**
   * 用户 2026-10-19："引脚必须落在网格上才能连线"。
   * 默认 100 mil（10 单位）：累计位移量化，余量不丢。
   */
  it("默认吸附：引脚位移是 100 mil 的整数倍，且累计余量不丢", () => {
    const onMove = vi.fn();
    const { pin } = mount({ onMove });
    drag(pin, { x: 100, y: 100 }, { x: 133, y: 122 });

    const [, dx, dy] = onMove.mock.calls[0] as [readonly string[], number, number];
    expect(Math.abs(dx % 10)).toBe(0);
    expect(Math.abs(dy % 10)).toBe(0);
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

  /** 用户 2026-10-20：吸附不再只管引脚 —— 文本/图形同样按档位走。 */
  it("默认吸附：拖图形元素也按 100 mil 量化", () => {
    const onMove = vi.fn();
    const { shape } = mount({ onMove });
    drag(shape, { x: 100, y: 100 }, { x: 133, y: 122 });
    const [, dx, dy] = onMove.mock.calls[0] as [readonly string[], number, number];
    expect(dx).toBe(30);
    expect(dy).toBe(20);
  });

  it("50 mil 档：位移量化到 5 单位", () => {
    const onMove = vi.fn();
    const { pin } = mount({ snap: { enabled: true, grid: 5 }, onMove });
    drag(pin, { x: 100, y: 100 }, { x: 133, y: 122 });
    const [, dx, dy] = onMove.mock.calls[0] as [readonly string[], number, number];
    expect(dx).toBe(35);
    expect(dy).toBe(20);
  });

  it("关闭吸附：任意小数位移原样下发", () => {
    const onMove = vi.fn();
    const { pin } = mount({ snap: { enabled: false, grid: 10 }, onMove });
    drag(pin, { x: 100, y: 100 }, { x: 133, y: 122 });
    const [, dx, dy] = onMove.mock.calls[0] as [readonly string[], number, number];
    expect(dx).toBeCloseTo(33, 6);
    expect(dy).toBeCloseTo(22, 6);
  });

  it("拖动本体框线改大小时，被拖的边吸附到格点", () => {
    const onResize = vi.fn();
    const { stroke } = mount({ onResizeRect: onResize });
    expect(stroke).toBeTruthy();
    // jsdom 没有 getScreenCTM → 退化成"拖右边线"
    drag(stroke, { x: 200, y: 100 }, { x: 233, y: 100 });
    const [, bounds] = onResize.mock.calls[0] as [
      string,
      { min: { x: number; y: number }; max: { x: number; y: number } },
    ];
    expect(bounds.max.x).toBe(130);
    expect(bounds.min.x).toBe(0);
    expect(bounds.min.y).toBe(0);
    expect(bounds.max.y).toBe(60);
  });

  it("Ctrl+点击只切换选中，不启动拖动", () => {
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const { pin } = mount({ onMove, onSelectKeys: onSelect });
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1, ctrlKey: true });
    firePointer(pin, "pointermove", { x: 160, y: 100, buttons: 1 });
    expect(onSelect).toHaveBeenCalledWith(["p0:0"], "toggle");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("Shift+点击按追加语义选中，也不启动拖动", () => {
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const { pin } = mount({ onMove, onSelectKeys: onSelect });
    firePointer(pin, "pointerdown", { x: 100, y: 100, buttons: 1, shiftKey: true });
    firePointer(pin, "pointermove", { x: 160, y: 100, buttons: 1 });
    expect(onSelect).toHaveBeenCalledWith(["p0:0"], "add");
    expect(onMove).not.toHaveBeenCalled();
  });

  /**
   * 用户 2026-10-21：把引脚拖到本体另一侧后，松手要按"贴边朝外"重建方向。
   * 这里用一个"body 端在本体外、连接端却在边缘"的错向引脚，验证松手结算真的被触发。
   */
  it("松手时触发引脚重定向（错向引脚被翻正）", () => {
    const misoriented: NormalizedSymbol = {
      ...symbol,
      sections: [
        {
          ...symbol.sections[0],
          pins: [
            {
              name: "P1",
              number: "1",
              connection: { x: 100, y: 20 },
              body: { x: 110, y: 20 },
              length: 10,
              type: "passive",
              visible: true,
            },
          ],
        },
      ],
    };
    const onReorient = vi.fn();
    const { pin } = mount({ symbol: misoriented, onReorientPins: onReorient });
    drag(pin, { x: 100, y: 100 }, { x: 120, y: 100 });
    firePointer(pin, "pointerup", { x: 120, y: 100, buttons: 0 });

    expect(onReorient).toHaveBeenCalledTimes(1);
    const entries = onReorient.mock.calls[0][0] as readonly {
      key: string;
      points: { connection: { x: number; y: number }; body: { x: number; y: number } };
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("p0:0");
    expect(entries[0].points.body).toEqual({ x: 100, y: 20 });
    expect(entries[0].points.connection).toEqual({ x: 110, y: 20 });
  });

  it("竖直方向拖动时按上/下边重定向", () => {
    const misoriented: NormalizedSymbol = {
      ...symbol,
      sections: [
        {
          ...symbol.sections[0],
          pins: [
            {
              name: "P1",
              number: "1",
              // 圆点在边缘、body 端伸到本体上方：方向是错的
              connection: { x: 40, y: 0 },
              body: { x: 40, y: -10 },
              length: 10,
              type: "passive",
              visible: true,
            },
          ],
        },
      ],
    };
    const onReorient = vi.fn();
    const { pin } = mount({ symbol: misoriented, onReorientPins: onReorient });
    drag(pin, { x: 100, y: 100 }, { x: 100, y: 120 });
    firePointer(pin, "pointerup", { x: 100, y: 120, buttons: 0 });

    const entries = onReorient.mock.calls[0][0] as readonly {
      key: string;
      points: { connection: { x: number; y: number }; body: { x: number; y: number } };
    }[];
    expect(entries[0].points.body).toEqual({ x: 40, y: 0 });
    expect(entries[0].points.connection).toEqual({ x: 40, y: -10 });
  });
});
