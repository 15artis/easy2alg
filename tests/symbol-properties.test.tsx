// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SymbolProperties } from "../src/renderer/src/SymbolProperties";
import type { ElementProps } from "../src/shared/symbol-property";

/**
 * 用户 2026-10-22：属性面板挡住缩放控件 → 面板可拖动、位置持久化。
 * 这里钉住：自定义位置真的作用在元素上；双击标题复位（回调 null）。
 */
const element: ElementProps = {
  kind: "text",
  key: "0:2",
  x: 40,
  y: 60,
  height: 7,
  rotation: 90,
  fontFactor: 1,
};

afterEach(() => {
  cleanup();
});

describe("symbol property panel position", () => {
  it("传入位置时用 left/top 定位（right 置 auto）", () => {
    const { container } = render(
      <div>
        <SymbolProperties element={element} snap={{ enabled: true, grid: 10 }} onField={() => {}} position={{ x: 40, y: 60 }} onMove={() => {}} />
      </div>,
    );
    const panel = container.querySelector('[data-testid="symbol-props"]') as HTMLElement;
    expect(panel.style.left).toBe("40px");
    expect(panel.style.top).toBe("60px");
    expect(panel.style.right).toBe("auto");
  });

  it("没有位置时保持默认定位（由 CSS 决定）", () => {
    const { container } = render(
      <SymbolProperties element={element} snap={{ enabled: true, grid: 10 }} onField={() => {}} />,
    );
    const panel = container.querySelector('[data-testid="symbol-props"]') as HTMLElement;
    expect(panel.style.left).toBe("");
    expect(panel.style.top).toBe("");
  });

  it("双击标题回到默认位置（onMove(null)）", () => {
    const onMove = vi.fn();
    const { container } = render(
      <SymbolProperties
        element={element}
        snap={{ enabled: true, grid: 10 }}
        onField={() => {}}
        position={{ x: 40, y: 60 }}
        onMove={onMove}
      />,
    );
    fireEvent.doubleClick(container.querySelector('[data-testid="symbol-props-title"]')!);
    expect(onMove).toHaveBeenCalledWith(null);
  });
});
