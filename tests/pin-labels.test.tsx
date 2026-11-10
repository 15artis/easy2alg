// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SymbolPreview } from "../src/renderer/src/SymbolPreview";
import { pinLabelWidth, pinLabelVisible } from "../src/shared/symbol-labels";
import type { NormalizedSymbol } from "../src/shared/schemas";

/**
 * 用户 2026-11-10 报的："预览里 7 号脚的 name 和 MH1 叠成一团"。
 *
 * DMR-9S 这类符号的 name 与 number 常常是同一个值，Capture 会把 name 画在本体
 * 内侧、number 画在引脚上方 → 每个脚写两遍。约定只留一份（关脚号）。
 * 同时字宽必须按 Capture 的等宽值钉死，否则 "MH1" 会向左伸出去压住隔壁的 7。
 */
const symbol: NormalizedSymbol = {
  name: "DSUB",
  refdesPrefix: "J",
  pcbFootprint: "",
  sections: [
    {
      name: "DSUB",
      bounds: { minX: 0, minY: 0, maxX: 30, maxY: 60 },
      pins: [
        {
          name: "7",
          number: "7",
          connection: { x: -20, y: 20 },
          body: { x: 0, y: 20 },
          length: 20,
          type: "passive",
          visible: true,
        },
        {
          name: "MH1",
          number: "10",
          connection: { x: 50, y: 20 },
          body: { x: 30, y: 20 },
          length: 20,
          type: "passive",
          visible: true,
        },
      ],
      shapes: [
        { kind: "rect", min: { x: 0, y: 0 }, max: { x: 30, y: 60 }, cornerRadius: 0, filled: false },
      ],
    },
  ],
  sourceJson: "{}",
};

const renderTexts = (): readonly string[] => {
  const view = render(
    <SymbolPreview
      symbol={symbol}
      sectionIndex={0}
      scale={1}
      edits={{}}
      editing
      selectedKeys={new Set<string>()}
      onSelectKeys={() => {
        /* 本组测试不关心选中 */
      }}
      onMoveElements={() => {
        /* 不关心拖动 */
      }}
      onResizeRect={() => {
        /* 不关心缩放 */
      }}
    />,
  );
  return [...view.container.querySelectorAll("text")].map((node) => node.textContent ?? "");
};

describe("pin labels", () => {
  it("name 与 number 相同时只画一遍（关脚号、留 name）", () => {
    expect(pinLabelVisible(symbol.sections[0].pins[0], "name")).toBe(true);
    expect(pinLabelVisible(symbol.sections[0].pins[0], "number")).toBe(false);
    expect(renderTexts().filter((text) => text === "7")).toHaveLength(1);
  });

  it("name 与 number 不同时两个都画", () => {
    expect(pinLabelVisible(symbol.sections[0].pins[1], "name")).toBe(true);
    expect(pinLabelVisible(symbol.sections[0].pins[1], "number")).toBe(true);
    const texts = renderTexts();
    expect(texts).toContain("MH1");
    expect(texts).toContain("10");
  });

  it("字宽按 Capture 的等宽值钉死，渲染宽度与盒模型一致", () => {
    expect(pinLabelWidth("MH1")).toBe(13.5);
    const view = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
        edits={{}}
        editing
        selectedKeys={new Set<string>()}
        onSelectKeys={() => {
          /* 不关心 */
        }}
        onMoveElements={() => {
          /* 不关心 */
        }}
        onResizeRect={() => {
          /* 不关心 */
        }}
      />,
    );
    const mh1 = [...view.container.querySelectorAll("text")].find(
      (node) => node.textContent === "MH1",
    );
    expect(mh1?.getAttribute("textLength")).toBe("13.5");
  });
});
