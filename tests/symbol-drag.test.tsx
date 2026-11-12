// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { act } from "react";
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

afterEach(() => {
  // 无 globals 配置时 RTL 不会自动清理；不清理的话上一个用例的输入框会串场
  cleanup();
});

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
    readonly onTextEdit?: (key: string, text: string) => void;
    readonly onPinTextEdit?: (key: string, kind: "name" | "number", text: string) => void;
    readonly onReorientPins?: (
      entries: readonly {
        readonly key: string;
        readonly points: {
          readonly connection: { readonly x: number; readonly y: number };
          readonly body: { readonly x: number; readonly y: number };
        };
      }[],
    ) => void;
    readonly view?: { readonly tx: number; readonly ty: number; readonly scale: number; readonly width: number; readonly height: number };
    readonly drawTool?: "line" | "rect" | "circle" | null;
    readonly onDrawShape?: (shape: {
      readonly kind: "line" | "rect" | "circle";
      readonly from: { readonly x: number; readonly y: number };
      readonly to: { readonly x: number; readonly y: number };
    }) => void;
  } = {},
) => {
  const view = render(
    <SymbolPreview
      symbol={options.symbol ?? symbol}
      sectionIndex={0}
      scale={1}
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
      onTextEdit={options.onTextEdit}
      onPinTextEdit={options.onPinTextEdit}
      view={options.view}
      drawTool={options.drawTool ?? null}
      onDrawShape={options.onDrawShape}
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

describe("text double-click editing (user 2026-10-21)", () => {
  it("双击文本进入行内编辑，Ctrl+Enter 提交新内容", () => {
    const onTextEdit = vi.fn();
    const view = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
        onTextEdit={onTextEdit}
      />,
    );
    const text = view.container.querySelector("text")!;
    expect(text.textContent).toBe("TXT");
    fireEvent.doubleClick(text);

    const input = document.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("TXT");

    fireEvent.change(input, { target: { value: "RENAME" } });
    // 用户 2026-11-09 起 Enter 是换行，提交改成 Ctrl+Enter
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, bubbles: true });
    expect(onTextEdit).toHaveBeenCalledWith("0:1", "RENAME");
    expect(document.querySelector('[data-testid="text-editor"]')).toBeNull();
  });

  /**
   * 用户 2026-11-09 要求"文本支持换行编辑"：Enter 只换行、不提交，
   * 提交后换行必须原样进编辑记录（写库时一行一条 CommentText）。
   */
  it("Enter 换行不提交，Ctrl+Enter 提交后换行原样保留", () => {
    const onTextEdit = vi.fn();
    const view = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
        onTextEdit={onTextEdit}
      />,
    );
    fireEvent.doubleClick(view.container.querySelector("text")!);
    const editor = document.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");

    fireEvent.change(editor, { target: { value: "LINE1\nLINE2" } });
    fireEvent.keyDown(editor, { key: "Enter", bubbles: true });
    // Enter 只换行：编辑器还在，也没提交
    expect(document.querySelector('[data-testid="text-editor"]')).not.toBeNull();
    expect(onTextEdit).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "LINE1\nLINE2\n" } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, bubbles: true });
    // 末尾多敲的换行被去掉，中间换行保留
    expect(onTextEdit).toHaveBeenCalledWith("0:1", "LINE1\nLINE2");
  });

  it("多行文本按行渲染（每行一个 tspan）", () => {
    const multiline: NormalizedSymbol = {
      ...symbol,
      sections: [
        {
          ...symbol.sections[0],
          shapes: symbol.sections[0].shapes.map((shape) =>
            shape.kind === "text" ? { ...shape, text: "AA\nB" } : shape,
          ),
        },
      ],
    };
    const view = render(
      <SymbolPreview
        symbol={multiline}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
      />,
    );
    const tspans = [...view.container.querySelectorAll("text tspan")];
    expect(tspans.map((node) => node.textContent)).toEqual(["AA", "B"]);
    // 第一行 dy=0，第二行按行距下移
    expect(tspans[0].getAttribute("dy")).toBe("0");
    expect(Number(tspans[1].getAttribute("dy"))).toBeGreaterThan(0);
  });

  it("Escape 取消编辑，不提交", () => {
    const onTextEdit = vi.fn();
    const view = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
        onTextEdit={onTextEdit}
      />,
    );
    fireEvent.doubleClick(view.container.querySelector("text")!);
    const input = document.querySelector('[data-testid="text-editor"]') as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape", bubbles: true });
    expect(onTextEdit).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="text-editor"]')).toBeNull();
  });
});

describe("pin label double-click editing (user 2026-10-22)", () => {
  it("双击引脚名（EP25 这类）进入编辑，Enter 提交", () => {
    const onPinTextEdit = vi.fn();
    const { container } = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
        onPinTextEdit={onPinTextEdit}
      />,
    );
    const nameLabel = [...container.querySelectorAll("text")].find(
      (node) => node.textContent === "P1",
    );
    expect(nameLabel).toBeTruthy();
    fireEvent.doubleClick(nameLabel!);

    const input = document.querySelector('[data-testid="pin-label-editor"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("P1");

    fireEvent.change(input, { target: { value: "EP25" } });
    fireEvent.keyDown(input, { key: "Enter", bubbles: true });
    expect(onPinTextEdit).toHaveBeenCalledWith("p0:0", "name", "EP25");
    expect(document.querySelector('[data-testid="pin-label-editor"]')).toBeNull();
  });
});

/**
 * 用户 2026-10-22：dblclick 在真机上收不到 —— 按下元素时 setPointerCapture 会把
 * click/dblclick 重定向到捕捉元素。改成 pointerdown 层判"同元素 + 400ms + 8px"。
 */
describe("double tap on pointerdown (user 2026-10-22)", () => {
  const tapTwice = (
    element: Element,
    x: number,
    y: number,
    mods: { readonly ctrlKey?: boolean; readonly shiftKey?: boolean } = {},
  ): void => {
    // 原生 dispatchEvent 不经过 act：状态更新不会同步 flush，查 DOM 会拿到旧树
    act(() => {
      firePointer(element, "pointerdown", { x, y, buttons: 1, ...mods });
      firePointer(element, "pointerup", { x, y, buttons: 0, ...mods });
      firePointer(element, "pointerdown", { x, y, buttons: 1, ...mods });
      firePointer(element, "pointerup", { x, y, buttons: 0, ...mods });
    });
  };

  it("双击引脚（任意位置）打开引脚名编辑器", () => {
    const { container } = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
        onPinTextEdit={() => {}}
      />,
    );
    const pin = container.querySelector('[data-pin="true"]') as Element;
    tapTwice(pin, 100, 100);
    const input = document.querySelector('[data-testid="pin-label-editor"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("P1");
  });

  it("双击注释文本打开文本编辑器", () => {
    const { container } = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
        onTextEdit={() => {}}
      />,
    );
    const textLabel = [...container.querySelectorAll("text")].find(
      (node) => node.textContent === "TXT",
    )!;
    tapTwice(textLabel, 120, 120);
    const input = document.querySelector('[data-testid="text-editor"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("TXT");
  });

  /**
   * 用户 2026-11-09 报"双击文本无法编辑了"：原阈值 400ms / 8px 比 Windows 默认的
   * 双击速度（500ms）还紧，手稍慢或抖一点都不算双击。放宽到 600ms / 16px 后
   * 这两种输入都必须命中。
   */
  it("间隔 500ms 的两次点击仍算双击（Windows 默认双击速度）", () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      const { container } = render(
        <SymbolPreview
          symbol={symbol}
          sectionIndex={0}
          scale={1}
          editing
          selectedKeys={new Set<string>()}
          onSelectKeys={() => {}}
          onMoveElements={() => {}}
          onResizeRect={() => {}}
          onTextEdit={() => {}}
        />,
      );
      const textLabel = [...container.querySelectorAll("text")].find(
        (node) => node.textContent === "TXT",
      )!;
      act(() => {
        firePointer(textLabel, "pointerdown", { x: 120, y: 120, buttons: 1 });
        firePointer(textLabel, "pointerup", { x: 120, y: 120, buttons: 0 });
        clock += 500;
        firePointer(textLabel, "pointerdown", { x: 120, y: 120, buttons: 1 });
        firePointer(textLabel, "pointerup", { x: 120, y: 120, buttons: 0 });
      });
      expect(document.querySelector('[data-testid="text-editor"]')).not.toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("第二下偏离 12px 仍算双击（缩小时手抖）", () => {
    const { container } = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
        onTextEdit={() => {}}
      />,
    );
    const textLabel = [...container.querySelectorAll("text")].find(
      (node) => node.textContent === "TXT",
    )!;
    act(() => {
      firePointer(textLabel, "pointerdown", { x: 120, y: 120, buttons: 1 });
      firePointer(textLabel, "pointerup", { x: 120, y: 120, buttons: 0 });
      firePointer(textLabel, "pointerdown", { x: 129, y: 128, buttons: 1 });
      firePointer(textLabel, "pointerup", { x: 129, y: 128, buttons: 0 });
    });
    expect(document.querySelector('[data-testid="text-editor"]')).not.toBeNull();
  });

  /**
   * 用户 2026-11-09 反馈：装出来的旧版本"只有 Ctrl / Shift + 双击能编辑"。
   * 根因是修饰键分支在双击识别之前就 return 了 —— 那条路径没设 pointer capture，
   * 浏览器原生 dblclick 反而能落到子节点上。现在两条路都必须能改字。
   */
  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Shift", { shiftKey: true }],
  ])("%s + 双击同样进入编辑", (_name, mods) => {
    const { container } = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {}}
        onMoveElements={() => {}}
        onResizeRect={() => {}}
        onTextEdit={() => {}}
      />,
    );
    const textLabel = [...container.querySelectorAll("text")].find(
      (node) => node.textContent === "TXT",
    )!;
    tapTwice(textLabel, 120, 120, mods);
    expect(document.querySelector('[data-testid="text-editor"]')).not.toBeNull();
  });
});

/**
 * 用户 2026-11-11：「文本拖动出现跳动两个网格，应该是一个网格才对」。
 *
 * 根因：吸附量化的是**位移**，源文本起点 `at.x = 13` 时落点永远在 143/153… 这些
 * 格线之间的位置，视觉上就会"有时一格有时两格"。改成量化**位置**之后，
 * 落点必定压在格线上（位移量反过来不再是 10 的整数倍，这是预期的）。
 */
describe("position snapping (user 2026-11-11)", () => {
  const offGrid: NormalizedSymbol = {
    ...symbol,
    sections: [
      {
        ...symbol.sections[0],
        shapes: symbol.sections[0].shapes.map((shape) =>
          shape.kind === "text" ? { ...shape, at: { x: 13, y: 40 } } : shape,
        ),
      },
    ],
  };

  const textElement = (): Element =>
    [...document.querySelectorAll('[data-draggable="true"]')][1] as Element;

  it("起点在格线之间时，拖动后的落点压回格线", () => {
    const onMove = vi.fn();
    mount({ symbol: offGrid, onMove });
    drag(textElement(), { x: 100, y: 100 }, { x: 133, y: 100 });
    const [, dx] = onMove.mock.calls[0] as [readonly string[], number, number];
    // 13 + 33 = 46 → 吸附到 50 → 位移 37（落点 50 在格线上）
    expect(dx).toBe(37);
    expect((13 + dx) % 10).toBe(0);
  });

  it("起点本来就在格线上时，位移仍是整格", () => {
    const onMove = vi.fn();
    mount({ symbol, onMove });
    drag(textElement(), { x: 100, y: 100 }, { x: 133, y: 100 });
    const [, dx] = onMove.mock.calls[0] as [readonly string[], number, number];
    expect(dx).toBe(30);
    expect((10 + dx) % 10).toBe(0);
  });
});

/** 用户 2026-11-11：「再添加啊支持线段，圆，矩形 任意画线」。 */
describe("draw tools (user 2026-11-11)", () => {
  const view = { tx: 0, ty: 0, scale: 1, width: 800, height: 600 };

  beforeEach(() => {
    /* jsdom 没有 getScreenCTM：给一个恒等矩阵，让绘制层能算出世界坐标。
     * 挂 `Element.prototype` 而不是 `SVGElement.prototype` —— mount 没有 `<svg>` 包裹，
     * `<rect>` 在 jsdom 里被建成了 HTMLUnknownElement，拿不到 SVGElement 上的方法。 */
    (Element.prototype as unknown as { getScreenCTM: () => unknown }).getScreenCTM = () => ({
      inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    });
  });

  afterEach(() => {
    delete (Element.prototype as unknown as { getScreenCTM?: unknown }).getScreenCTM;
  });

  it("绘制层铺满可视区，并接管按下/移动/抬起", () => {
    const onDraw = vi.fn();
    mount({ view, drawTool: "line", onDrawShape: onDraw });
    const layer = document.querySelector('[data-testid="symbol-draw-layer"]') as Element;
    expect(layer).not.toBeNull();
    // 世界矩形按 view 换算：0..800 × 0..600
    expect(layer.getAttribute("width")).toBe("800");
    expect(layer.getAttribute("height")).toBe("600");

    firePointer(layer, "pointerdown", { x: 10, y: 20, buttons: 1 });
    firePointer(layer, "pointermove", { x: 58, y: 24, buttons: 1 });
    firePointer(layer, "pointerup", { x: 58, y: 24, buttons: 0 });

    expect(onDraw).toHaveBeenCalledTimes(1);
    const drawn = onDraw.mock.calls[0][0] as {
      kind: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    };
    expect(drawn.kind).toBe("line");
    // 两端都吸附到 10 单位的格点
    expect(drawn.from).toEqual({ x: 10, y: 20 });
    expect(drawn.to).toEqual({ x: 60, y: 20 });
  });

  it("绘制态下元素层不接指针（落点压在本体上也能起笔）", () => {
    mount({ view, drawTool: "rect", onDrawShape: () => {} });
    const preview = document.querySelector(".symbol-preview") as Element;
    expect(preview.getAttribute("pointer-events")).toBe("none");
  });

  it("没开绘图工具时不渲染绘制层", () => {
    mount({});
    expect(document.querySelector('[data-testid="symbol-draw-layer"]')).toBeNull();
  });
});

/** 用户自己画的矩形拖整体移动，不是改本体四边。 */
describe("added rect is movable, not resizable (user 2026-11-11)", () => {
  const withAddedRect: NormalizedSymbol = {
    ...symbol,
    sections: [
      {
        ...symbol.sections[0],
        shapes: [
          ...symbol.sections[0].shapes,
          {
            kind: "rect",
            min: { x: 20, y: 10 },
            max: { x: 40, y: 20 },
            cornerRadius: 0,
            filled: false,
            added: true,
          },
        ],
      },
    ],
  };

  it("只有源库本体才挂框线改大小命中区", () => {
    mount({ symbol: withAddedRect });
    expect(document.querySelectorAll('[data-hit="stroke"]')).toHaveLength(1);
  });

  it("拖自己画的矩形走移动回调", () => {
    const onMove = vi.fn();
    mount({ symbol: withAddedRect, onMove });
    const added = [...document.querySelectorAll('[data-draggable="true"]')][2] as Element;
    drag(added, { x: 100, y: 100 }, { x: 133, y: 100 });
    const [, dx] = onMove.mock.calls[0] as [readonly string[], number, number];
    // 锚点 = 左上角 (20,10)：20+33=53 → 50 → 位移 30（落点 50 在格线上）
    expect(dx).toBe(30);
  });
});
