// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SymbolPreview } from "../src/renderer/src/SymbolPreview";
import {
  SYMBOL_LABEL_AXIS_CENTER,
  SYMBOL_LABEL_AXIS_GAP,
  SYMBOL_PIN_FONT,
  bodyBoxOf,
  pinLabelPlacement,
  pinLabelWidth,
  pinLabelVisible,
} from "../src/shared/symbol-labels";
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
  it("name 与 number 相同时两条都画 —— Capture 本来就是画两遍", () => {
    // 用户 2026-11-10 用 OrCAD 截图对照预览：实机脚上有「本体内的 name + 引脚外的
    // number」两份，预览只画一份就成了假的。IsNumberVisible 在实机不生效，只能跟着实机走。
    expect(pinLabelVisible(symbol.sections[0].pins[0], "name")).toBe(true);
    expect(pinLabelVisible(symbol.sections[0].pins[0], "number")).toBe(true);
    expect(renderTexts().filter((text) => text === "7")).toHaveLength(2);
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

/**
 * 用户 2026-11-10 第二次报的："引脚没有在三角形中间位置和出现空白"。
 *
 * C3699281（DO-214AA 的 TVS）本体是两个三角形，引脚从上下两端顶在**顶点**上，
 * 名字就落在三角形里面。OrCAD 实测（3.53 px/单位）：三角中轴 x=104，名字 bbox
 * x 94..113、字心 103.5 —— Capture 是**压着轴线居中**画的；预览却把基线放在轴线上，
 * 整个字挂到左边、三角形中间空着。
 */
describe("引脚文字以引脚轴线为中线", () => {
  // 与 C3699281 同构：本体 x1..20 / y0..34，上引脚从 (10,-11) 顶到顶点 (10,4)
  const tvs: NormalizedSymbol = {
    name: "SACB5.0",
    refdesPrefix: "D",
    pcbFootprint: "DO-214AA",
    sections: [
      {
        name: "SACB5.0",
        bounds: { minX: 1, minY: -11, maxX: 20, maxY: 49 },
        pins: [
          {
            name: "1",
            number: "1",
            connection: { x: 10, y: -11 },
            body: { x: 10, y: 4 },
            length: 15,
            type: "unspecified",
            visible: true,
          },
          {
            name: "2",
            number: "2",
            connection: { x: 10, y: 49 },
            body: { x: 10, y: 34 },
            length: 15,
            type: "unspecified",
            visible: true,
          },
        ],
        shapes: [
          { kind: "polyline", points: [{ x: 4, y: 14 }, { x: 10, y: 4 }, { x: 17, y: 14 }], closed: true },
          { kind: "polyline", points: [{ x: 16, y: 24 }, { x: 10, y: 34 }, { x: 3, y: 24 }], closed: true },
        ],
      },
    ],
    sourceJson: "{}",
  };
  const body = bodyBoxOf(tvs.sections[0]);

  it("上下引脚的名字压在轴线上（基线右移半个字高）", () => {
    for (const pin of tvs.sections[0].pins) {
      const name = pinLabelPlacement(pin, "name", body);
      expect(name.rotate).toBe(-90);
      expect(name.x).toBe(10 + SYMBOL_LABEL_AXIS_CENTER);
      // 字形从基线往左长，字心正好落回 x=10
      const center = name.x - SYMBOL_PIN_FONT * 0.36;
      expect(Math.abs(center - 10)).toBeLessThan(0.5);
    }
  });

  it("脚号让到轴线左侧 4 单位，不再压在引脚线上", () => {
    for (const pin of tvs.sections[0].pins) {
      expect(pinLabelPlacement(pin, "number", body).x).toBe(10 - SYMBOL_LABEL_AXIS_GAP);
    }
  });

  it("横排引脚的名字竖直居中（基线比引脚线低半个字高）", () => {
    const left = tvs.sections[0].pins[0];
    const horizontal = { ...left, connection: { x: -20, y: 20 }, body: { x: 0, y: 20 } };
    expect(pinLabelPlacement(horizontal, "name", body).y).toBe(20 + SYMBOL_LABEL_AXIS_CENTER);
    expect(pinLabelPlacement(horizontal, "number", body).y).toBe(20 - SYMBOL_LABEL_AXIS_GAP);
  });
});
