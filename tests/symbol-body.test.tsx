// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SymbolPreview } from "../src/renderer/src/SymbolPreview";
import { parseEasyEdaSymbol } from "../src/main/conversion/easyeda-symbol";
import type { NormalizedSymbol } from "../src/shared/schemas";

/**
 * 用户 2026-11-10 报："预览没有显示圆和一个水平的线，应该解析不完整导致的"。
 *
 * 实际不是漏解析 —— C7498154（SMA-KWE）的小圆和短线都解析出来了，是**本体矩形被
 * 当成实心**、铺了一层不透明底色把先画的图形盖住了。真实数据里 `R` 的填充开关
 * （第 9 个字段）全是 0（空心），旧代码却拿它跟字符串 "none" 比，恒为 true。
 */
describe("本体填充位", () => {
  const parse = (shape: string[]) =>
    parseEasyEdaSymbol(
      { head: { c_para: { name: "BOX", pre: "U?" } }, shape },
      { lcscId: "C000009", fallbackName: "BOX", pcbFootprint: "BOX" },
    )!;

  it("fillFlag=0 的矩形是空心（真实库里 48 个 R 全是这种）", () => {
    // 与 C7498154 同格式：R~x~y~rx~ry~w~h~stroke~strokeWidth~fillFlag~fillColor~id~locked
    const symbol = parse([
      "R~387~290~~~27~20~#880000~1~0~none~gge124~0~",
      "PL~402 300 410 300~#880000~1~0~none~gge7~0",
    ]);
    const rect = symbol.sections[0].shapes.find((shape) => shape.kind === "rect");
    expect(rect?.kind).toBe("rect");
    if (rect?.kind !== "rect") throw new Error("应为矩形");
    expect(rect.filled).toBe(false);
  });

  it("fillFlag=1 才算出实心", () => {
    const symbol = parse(["R~0~0~~~20~10~#880000~1~1~#ff0000~g1~0~"]);
    const rect = symbol.sections[0].shapes[0];
    if (rect.kind !== "rect") throw new Error("应为矩形");
    expect(rect.filled).toBe(true);
  });

  it("空心本体不挡住里面先画的圆与短线", () => {
    const symbol: NormalizedSymbol = {
      name: "SMA",
      refdesPrefix: "J",
      pcbFootprint: "",
      sections: [
        {
          name: "SMA",
          bounds: { minX: 0, minY: 0, maxX: 30, maxY: 20 },
          pins: [],
          shapes: [
            // 圆（解析成 48 边形折线）先画
            { kind: "polyline", points: [{ x: 12, y: 8 }, { x: 14, y: 8 }, { x: 14, y: 12 }], closed: true },
            { kind: "polyline", points: [{ x: 12, y: 10 }, { x: 20, y: 10 }], closed: false },
            // 本体后画，且是空心
            {
              kind: "rect",
              min: { x: 0, y: 0 },
              max: { x: 30, y: 20 },
              cornerRadius: 0,
              filled: false,
            },
          ],
        },
      ],
      sourceJson: "{}",
    };
    const view = render(
      <SymbolPreview
        symbol={symbol}
        sectionIndex={0}
        scale={1}
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
    // 本体不带填充，里面的折线才看得见
    const rect = view.container.querySelector("rect");
    expect(rect?.getAttribute("fill")).toBe("none");
    const polylines = [...view.container.querySelectorAll("polyline")];
    expect(polylines.length).toBeGreaterThanOrEqual(2);
  });
});
