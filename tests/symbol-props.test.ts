import { describe, expect, it } from "vitest";
import {
  readElementProps,
  writeCircleRadius,
  writeElementHeight,
  writeElementWidth,
  writeElementX,
  writeElementY,
  writeLineEndpoint,
  writePinLength,
  writePinSide,
  writeSelectionStroke,
  writeTextHeight,
  writeTextRotation,
} from "../src/shared/symbol-property";
import {
  appendAddedTexts,
  applySymbolEdits,
  symbolPinKey,
  symbolShapeKey,
  type SymbolEdits,
} from "../src/shared/symbol-edit";
import type { NormalizedSymbol, NormalizedSymbolSection } from "../src/shared/schemas";

/**
 * 用户 2026-10-20：属性面板输入精确坐标。
 * 最关键的一条：已有 offset 时输入 100 必须写 `100 − 原始坐标`，不能在旧 offset 上累加。
 */
const section = (): NormalizedSymbolSection => ({
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
    { kind: "rect", min: { x: 10, y: 10 }, max: { x: 110, y: 70 }, cornerRadius: 0, filled: false },
    { kind: "text", text: "TXT", at: { x: 20, y: 40 }, rotation: 0, height: 10 },
  ],
});

const rectKey = symbolShapeKey(0, 0);
const textKey = symbolShapeKey(0, 1);

/** 把"一段"包成完整符号，便于用 applySymbolEdits 验证最终几何。 */
const baseSymbol = (raw: NormalizedSymbolSection): NormalizedSymbol => ({
  name: raw.name,
  refdesPrefix: "U",
  pcbFootprint: "",
  sections: [raw],
  sourceJson: "{}",
});

describe("element properties", () => {
  it("rect 读取 X/Y/宽/高（原始值 + 当前 offset/bounds）", () => {
    const edits: SymbolEdits = {
      [rectKey]: { offset: { dx: 7, dy: 3 }, bounds: { min: { x: 10, y: 10 }, max: { x: 130, y: 70 } } },
    };
    const props = readElementProps(section(), edits, rectKey)!;
    expect(props.kind).toBe("rect");
    if (props.kind !== "rect") {
      return;
    }
    expect(props.x).toBe(17);
    expect(props.y).toBe(13);
    expect(props.width).toBe(120);
    expect(props.height).toBe(60);
  });

  it("已有 offset 时输入 X=100，写的是绝对值而不是叠加", () => {
    const edits: SymbolEdits = { [rectKey]: { offset: { dx: 7, dy: 3 } } };
    const next = writeElementX(section(), edits, rectKey, 100);
    // 原始 minX=10 → dx 应为 90（不是 7+100）
    expect(next[rectKey]?.offset?.dx).toBe(90);
    // Y 的 offset 保持不变
    expect(next[rectKey]?.offset?.dy).toBe(3);
  });

  it("rect 改宽只写 bounds，不动 offset", () => {
    const edits: SymbolEdits = { [rectKey]: { offset: { dx: 7, dy: 3 } } };
    const next = writeElementWidth(section(), edits, rectKey, 50);
    expect(next[rectKey]?.offset).toEqual({ dx: 7, dy: 3 });
    expect(next[rectKey]?.bounds).toEqual({
      min: { x: 10, y: 10 },
      max: { x: 60, y: 70 },
    });
  });

  it("rect 改高只写 bounds.max.y", () => {
    const next = writeElementHeight(section(), {}, rectKey, 33);
    expect(next[rectKey]?.bounds).toEqual({
      min: { x: 10, y: 10 },
      max: { x: 110, y: 43 },
    });
  });

  it("宽/高有最小边长保护", () => {
    const next = writeElementWidth(section(), {}, rectKey, 2);
    expect(next[rectKey]?.bounds?.max.x).toBe(20);
  });

  it("文本：字号与旋转读写", () => {
    const props = readElementProps(section(), {}, textKey)!;
    expect(props.kind).toBe("text");
    if (props.kind !== "text") {
      return;
    }
    expect(props.height).toBe(10);
    expect(props.rotation).toBe(0);

    const bigger = writeTextHeight(section(), {}, textKey, 15);
    expect(readElementProps(section(), bigger, textKey)).toMatchObject({ height: 15 });

    const rotated = writeTextRotation(section(), {}, textKey, 270);
    expect(readElementProps(section(), rotated, textKey)).toMatchObject({ rotation: 270 });
  });

  it("文本旋转从 90 回到 0 也能正确表达（rotate 是相对圈数）", () => {
    const section90: NormalizedSymbolSection = {
      ...section(),
      shapes: [
        { kind: "rect", min: { x: 10, y: 10 }, max: { x: 110, y: 70 }, cornerRadius: 0, filled: false },
        { kind: "text", text: "TXT", at: { x: 20, y: 40 }, rotation: 90, height: 10 },
      ],
    };
    const next = writeTextRotation(section90, {}, textKey, 0);
    expect(next[textKey]?.rotate).toBe(3);
    expect(readElementProps(section90, next, textKey)).toMatchObject({ rotation: 0 });
  });

  it("引脚：X/Y 读写走 connection + offset", () => {
    const key = symbolPinKey(0, 0);
    expect(readElementProps(section(), {}, key)).toMatchObject({ x: -10, y: 20 });
    const next = writeElementX(section(), {}, key, 0);
    expect(next[key]?.offset?.dx).toBe(10);
    const both = writeElementY(section(), next, key, 0);
    expect(both[key]?.offset).toEqual({ dx: 10, dy: -20 });
  });

  it("非法值不改变编辑（不会写入 NaN）", () => {
    const edits: SymbolEdits = {};
    expect(writeElementX(section(), edits, rectKey, Number.NaN)).toBe(edits);
    expect(writeTextHeight(section(), edits, textKey, 0)).toBe(edits);
  });

  it("未知键返回 null", () => {
    expect(readElementProps(section(), {}, "0:99")).toBeNull();
  });
});

/**
 * 用户 2026-10-22：选中"添加文本"新建的文本时属性面板整块不出现
 * （面板读的是未套编辑的原始段，而新文本是在 applyEdits 里追加的）。
 */
describe("added text in property panel", () => {
  it("追加的文本也能读出属性（删除按钮依赖它）", () => {
    const base: NormalizedSymbol = {
      name: "TESTPART",
      refdesPrefix: "U",
      pcbFootprint: "",
      sections: [section()],
      sourceJson: "{}",
    };
    const withAdded = appendAddedTexts(base, [
      { kind: "text", id: "t1", section: 0, text: "文本", at: { x: 50, y: 30 }, height: 7 },
    ]);
    const raw = withAdded.sections[0];
    const key = symbolShapeKey(0, raw.shapes.length - 1);
    const props = readElementProps(raw, {}, key);
    expect(props).not.toBeNull();
    expect(props!.kind).toBe("text");
    expect(props!.x).toBe(50);
    expect(props!.y).toBe(30);
  });
});

/**
 * 用户 2026-11-11：属性编辑里改圆的半径、线段端点、引脚长度/方向、批量线宽。
 * 关键不变式：预览与写库读的是**同一份几何**，改了必须两边一起变。
 */
describe("editing geometry from the inspector (user 2026-11-11)", () => {
  const withParts = (): NormalizedSymbolSection => {
    const base = section();
    return {
      ...base,
      shapes: [
        ...base.shapes,
        {
          kind: "polyline",
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 10 },
            { x: 10, y: 20 },
          ],
          closed: true,
          primitive: { type: "ellipse", center: { x: 10, y: 10 }, rx: 5, ry: 5 },
          added: true,
        },
        {
          kind: "polyline",
          points: [
            { x: 0, y: 5 },
            { x: 30, y: 5 },
          ],
          closed: false,
          added: true,
        },
      ],
    };
  };
  const circleKey = symbolShapeKey(0, 2);
  const lineKey = symbolShapeKey(0, 3);

  it("圆半径：primitive 与采样点同步改", () => {
    const raw = withParts();
    const edits = writeCircleRadius(raw, {}, circleKey, 12);
    const applied = applySymbolEdits({ ...baseSymbol(raw) }, edits).sections[0];
    const circle = applied.shapes[2];
    expect(circle.kind).toBe("polyline");
    if (circle.kind !== "polyline" || circle.primitive?.type !== "ellipse") {
      return;
    }
    expect(circle.primitive.rx).toBe(12);
    expect(circle.primitive.ry).toBe(12);
    // 64 个采样点全部落在新半径上（写库用 primitive，点集只给框选/兜底）
    for (const point of circle.points) {
      expect(Math.hypot(point.x - 10, point.y - 10)).toBeCloseTo(12, 6);
    }
  });

  it("线段端点：写成绝对值，旧 offset 折进去后清零", () => {
    const raw = withParts();
    const moved = writeElementX(raw, {}, lineKey, 40); // offset.dx = 40
    const edited = writeLineEndpoint(raw, moved, lineKey, "lineX2", 100);
    expect(edited[lineKey]?.offset?.dx ?? 0).toBe(0);
    expect(edited[lineKey]?.endpoints).toEqual({
      from: { x: 40, y: 5 },
      to: { x: 100, y: 5 },
    });
  });

  it("引脚长度：连接端不动，本体端沿轴线伸缩", () => {
    const raw = section();
    const edited = writePinLength(raw, {}, symbolPinKey(0, 0), 25);
    const applied = applySymbolEdits(baseSymbol(raw), edited).sections[0];
    const pin = applied.pins[0];
    expect(pin.connection).toEqual({ x: -10, y: 20 });
    expect(Math.hypot(pin.connection.x - pin.body.x, pin.connection.y - pin.body.y)).toBeCloseTo(25, 6);
  });

  it("引脚方向：换到上方后连接端与长度都不变", () => {
    const raw = section();
    const edited = writePinSide(raw, {}, symbolPinKey(0, 0), "top");
    const applied = applySymbolEdits(baseSymbol(raw), edited).sections[0];
    const pin = applied.pins[0];
    expect(pin.connection).toEqual({ x: -10, y: 20 });
    expect(pin.body.x).toBe(-10);
    expect(pin.body.y).toBeGreaterThan(pin.connection.y);
  });

  it("批量线宽只作用于图形，文本不产生描边编辑", () => {
    const raw = withParts();
    const next = writeSelectionStroke(raw, {}, [rectKey, textKey, circleKey], { lineWidth: 2 });
    expect(next[rectKey]?.lineWidth).toBe(2);
    expect(next[circleKey]?.lineWidth).toBe(2);
    expect(next[textKey]).toBeUndefined();
  });

  /**
   * 用户 2026-11-11 报的 bug：线型切到虚线，下拉又变回"实线"。
   * 根因是读属性时只用原始 shape、没叠编辑值 —— 预览变了、面板没变。
   */
  it("线型/线宽改完再读，拿到的是新值而不是原始值", () => {
    const raw = withParts();
    const next = writeSelectionStroke(raw, {}, [rectKey, lineKey], { lineStyle: 1, lineWidth: 3 });
    expect(readElementProps(raw, next, rectKey)).toMatchObject({ lineWidth: 3, lineStyle: 1 });
    expect(readElementProps(raw, next, lineKey)).toMatchObject({ lineWidth: 3, lineStyle: 1 });
    // 预览/写库读的是同一份 shape，必须一起变（否则面板对、图不对）
    const applied = applySymbolEdits(baseSymbol(raw), next).sections[0];
    expect(applied.shapes[0]).toMatchObject({ lineStyle: 1, lineWidth: 3 });
    expect(applied.shapes[3]).toMatchObject({ lineStyle: 1, lineWidth: 3 });
  });

  it("改回实线（0）也能读到 0，不是回退到原始值", () => {
    const raw = withParts();
    const dashed = writeSelectionStroke(raw, {}, [rectKey], { lineStyle: 3 });
    const solid = writeSelectionStroke(raw, dashed, [rectKey], { lineStyle: 0 });
    expect(readElementProps(raw, solid, rectKey)).toMatchObject({ lineStyle: 0 });
  });
});
