// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SymbolPreview } from "../src/renderer/src/SymbolPreview";
import { bodyBoxOf, pinLabelPlacement, pinLabelWidth, pinLabelVisible, pinNamesSuppressed } from "../src/shared/symbol-labels";
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

  it("字宽按 Capture 的等宽值钉死，渲染宽度与盒模型一致", () => {    expect(pinLabelWidth("MH1")).toBe(13.5);
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

/**
 * 2026-11-10 第二次返工：逐脚 `IsNumberVisible=0` 在这台 Capture 上不生效，
 * 名字和脚号照旧各画一遍 → 本体内侧一个数字、引脚旁又一个，SMA-KWE 的四个脚
 * 直接糊成一坨。能真正关掉的只有**整段**的 `<IsPinNamesVisible>`。
 *
 * 规则：name 全等于 number 时关掉名字、只留脚号（文字本来就相同）；
 * 名字带语义（GND/GPIO7）的段不关。
 */
describe("整段关掉引脚名", () => {
  const numbered = (names: readonly string[]): NormalizedSymbol => ({
    name: "SMA",
    refdesPrefix: "J",
    pcbFootprint: "",
    sections: [
      {
        name: "SMA",
        bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
        pins: names.map((name, index) => ({
          name,
          number: String(index + 1),
          connection: { x: -20, y: 10 * (index + 1) },
          body: { x: 0, y: 10 * (index + 1) },
          length: 20,
          type: "passive" as const,
          visible: true,
        })),
        shapes: [
          { kind: "rect", min: { x: 0, y: 0 }, max: { x: 20, y: 20 }, cornerRadius: 0, filled: false },
        ],
      },
    ],
    sourceJson: "{}",
  });

  const labelX = (target: NormalizedSymbol): readonly (string | null)[] => {
    const view = render(
      <SymbolPreview
        symbol={target}
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
    return [...view.container.querySelectorAll("text")].map((node) => node.getAttribute("x"));
  };

  it("name 全等于 number → 整段关名字，脚号画到本体外侧", () => {
    const target = numbered(["1", "2"]);
    const section = target.sections[0];
    expect(pinNamesSuppressed(section)).toBe(true);
    // 只画两个（一个脚一个），且落在 number 的锚点上（本体外侧），不是 name 的
    const xs = labelX(target);
    expect(xs).toHaveLength(2);
    const expected = section.pins.map(
      (pin) => String(pinLabelPlacement(pin, "number", bodyBoxOf(section)).x),
    );
    expect(xs).toEqual(expected);
  });

  it("名字带语义（不等于脚号）→ 名字照画", () => {
    const target = numbered(["GND", "2"]);
    expect(pinNamesSuppressed(target.sections[0])).toBe(false);
    const texts: string[] = [];
    const view = render(
      <SymbolPreview
        symbol={target}
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
    for (const node of view.container.querySelectorAll("text")) {
      texts.push(node.textContent ?? "");
    }
    expect(texts).toContain("GND");
    expect(texts).toContain("2");
  });
});
