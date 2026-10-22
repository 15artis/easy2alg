// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SymbolGrid } from "../src/renderer/src/SymbolGrid";

/**
 * 用户 2026-10-20：背景网格必须跟着档位走（100 mil / 50 mil），
 * 并且是**世界坐标**网格 —— 缩放时贴住符号原点，而不是固定的屏幕像素。
 */
const mount = (grid: number, scale: number, visible = true) => {
  const view = { tx: 100, ty: 50, scale, width: 400, height: 300 };
  const result = render(
    <svg>
      <SymbolGrid view={view} grid={grid} visible={visible} />
    </svg>,
  );
  return result.container;
};

describe("symbol background grid", () => {
  it("网格铺满视口对应的世界矩形", () => {
    const container = mount(10, 2);
    const rect = container.querySelector('[data-testid="symbol-grid"]')!;
    expect(Number(rect.getAttribute("x"))).toBe(-50);
    expect(Number(rect.getAttribute("y"))).toBe(-25);
    expect(Number(rect.getAttribute("width"))).toBe(200);
    expect(Number(rect.getAttribute("height"))).toBe(150);
  });

  it("档位 10 单位时 tile 是 10，档位 5 单位时 tile 是 5", () => {
    const coarse = mount(10, 4);
    const coarseMinor = coarse.querySelector("pattern")!;
    expect(Number(coarseMinor.getAttribute("width"))).toBe(10);

    const fine = mount(5, 4);
    const fineMinor = fine.querySelector("pattern")!;
    expect(Number(fineMinor.getAttribute("width"))).toBe(5);
  });

  it("缩得太小时整层不画（避免 5 单位档在低缩放下卡死）", () => {
    expect(mount(5, 0.02).querySelector('[data-testid="symbol-grid"]')).toBeNull();
    // 100 mil 档在 2% 缩放下：细格 0.2px、粗格 2px，都低于 3px 阈值
    expect(mount(10, 0.02).querySelector('[data-testid="symbol-grid"]')).toBeNull();
    // 20% 缩放下细格 2px 不画，但粗格（1000 mil）仍有 20px → 保留粗网格
    const coarse = mount(10, 0.2);
    expect(coarse.querySelector('[data-testid="symbol-grid"]')).not.toBeNull();
    expect(coarse.querySelectorAll("pattern")).toHaveLength(1);
  });

  it("隐藏开关生效", () => {
    expect(mount(10, 4, false).querySelector('[data-testid="symbol-grid"]')).toBeNull();
  });

  it("多个实例的 pattern id 不冲突，且不带冒号", () => {
    const view = { tx: 0, ty: 0, scale: 4, width: 400, height: 300 };
    const { container } = render(
      <svg>
        <SymbolGrid view={view} grid={10} visible />
        <SymbolGrid view={view} grid={10} visible />
      </svg>,
    );
    const ids = [...container.querySelectorAll("pattern")].map((item) => item.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.includes(":")).toBe(false);
    }
  });

  it("网格不吃指针事件（否则框选/平移/空白点击全失效）", () => {
    const container = mount(10, 4);
    const group = container.querySelector(".symbol-grid")!;
    expect(group.getAttribute("pointer-events")).toBe("none");
  });
});
