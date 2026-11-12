import { describe, expect, it } from "vitest";
import type { NormalizedSymbol } from "../src/shared/schemas";
import {
  accumulateFontSize,
  accumulateLabelShift,
  accumulateOffset,
  accumulateRotation,
  addedItemToShape,
  appendAddedItems,
  appendAddedTexts,
  applySymbolEdits,
  constrainDrawPoint,
  dragDelta,
  EMPTY_SYMBOL_EDITS,
  hasSymbolEdits,
  isSymbolPinKey,
  isSymbolPinLabelKey,
  parseSymbolEditKey,
  parseSymbolPinLabelKey,
  selectionToAddedItems,
  setPinText,
  setRectBounds,
  setTextHidden,
  setTextContent,
  symbolPinKey,
  symbolPinLabelKey,
  symbolShapeKey,
  translateAddedItem,
  translateSymbolShape,
} from "../src/shared/symbol-edit";
import { sanitizeLibraryName } from "../src/shared/naming";

const symbol = (): NormalizedSymbol => ({
  name: "TESTPART",
  refdesPrefix: "U",
  pcbFootprint: "TESTPART",
  sections: [
    {
      name: "SEC0",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      pins: [
        {
          name: "P1",
          number: "1",
          connection: { x: -10, y: 20 },
          body: { x: 0, y: 20 },
          length: 10,
          type: "passive" as const,
          visible: true,
        },
      ],
      shapes: [
        { kind: "rect", min: { x: 0, y: 0 }, max: { x: 100, y: 100 }, cornerRadius: 0, filled: false },
        {
          kind: "polyline",
          points: [
            { x: 0, y: 50 },
            { x: 100, y: 50 },
          ],
          closed: false,
        },
        { kind: "text", text: "LABEL", at: { x: 10, y: 20 }, rotation: 0, height: 12 },
      ],
    },
    {
      name: "SEC1",
      bounds: { minX: 0, minY: 0, maxX: 50, maxY: 50 },
      pins: [],
      shapes: [
        { kind: "text", text: "OTHER", at: { x: 5, y: 5 }, rotation: 0, height: 12 },
      ],
    },
  ],
  sourceJson: "{}",
});

describe("symbol shape translation", () => {
  it("moves rect / polyline / text by the same offset", () => {
    const base = symbol().sections[0].shapes;
    expect(translateSymbolShape(base[0], 3, -4)).toEqual({
      kind: "rect",
      min: { x: 3, y: -4 },
      max: { x: 103, y: 96 },
      cornerRadius: 0,
      filled: false,
    });
    expect(translateSymbolShape(base[1], 3, -4)).toEqual({
      kind: "polyline",
      points: [
        { x: 3, y: 46 },
        { x: 103, y: 46 },
      ],
      closed: false,
    });
    expect(translateSymbolShape(base[2], 3, -4)).toEqual({
      kind: "text",
      text: "LABEL",
      at: { x: 13, y: 16 },
      rotation: 0,
      height: 12,
    });
    // 旋转角度不随平移改变
    const textShape = base[2];
    expect(textShape.kind).toBe("text");
    if (textShape.kind !== "text") return;
    expect(translateSymbolShape({ ...textShape, rotation: 90 }, 1, 1)).toMatchObject({
      rotation: 90,
    });
  });

  it("applies edits only to the addressed section/shape", () => {
    const base = symbol();
    const moved = applySymbolEdits(base, {
      [symbolShapeKey(0, 2)]: { offset: { dx: 40, dy: -7 } },
      [symbolShapeKey(1, 0)]: { offset: { dx: 1, dy: 2 } },
    });
    // 目标元素移动
    expect(moved.sections[0].shapes[2]).toMatchObject({ at: { x: 50, y: 13 } });
    expect(moved.sections[1].shapes[0]).toMatchObject({ at: { x: 6, y: 7 } });
    // 同段其它元素不动
    expect(moved.sections[0].shapes[0]).toEqual(base.sections[0].shapes[0]);
    expect(moved.sections[0].shapes[1]).toEqual(base.sections[0].shapes[1]);
    // 原对象不被就地修改（state 里要保持不可变）
    expect(base.sections[0].shapes[2]).toMatchObject({ at: { x: 10, y: 20 } });
  });

  it("returns the same object when there is nothing to apply", () => {
    const base = symbol();
    expect(applySymbolEdits(base, EMPTY_SYMBOL_EDITS)).toBe(base);
    expect(hasSymbolEdits(EMPTY_SYMBOL_EDITS)).toBe(false);
    expect(hasSymbolEdits({ [symbolShapeKey(0, 0)]: { offset: { dx: 0, dy: 0 } } })).toBe(true);
  });
});

describe("library name sanitizing", () => {
  it("upper-cases and strips characters Allegro/Capture reject", () => {
    expect(sanitizeLibraryName("pex8748-baca")).toBe("PEX8748-BACA");
    expect(sanitizeLibraryName("PEX8748 CA80BC G")).toBe("PEX8748-CA80BC-G");
    // 非 ASCII（这里是 ×）先被剥掉再补分隔符 —— 与 main 侧 naming.ts 的行为一致
    expect(sanitizeLibraryName("  FCBGA-676_L27.0×27.0  ")).toBe("FCBGA-676_L27-027-0");
    expect(sanitizeLibraryName("PEX--8748__")).toBe("PEX-8748");
    expect(sanitizeLibraryName("封装名")).toBe("");
  });

  it("caps the length so Allegro accepts the name", () => {
    expect(sanitizeLibraryName("A".repeat(60))).toHaveLength(31);
  });
});

describe("symbol edit model (v0.1.20)", () => {
  it("moves a pin's connection and body together", () => {
    const moved = applySymbolEdits(symbol(), {
      [symbolPinKey(0, 0)]: { offset: { dx: 7, dy: -3 } },
    });
    expect(moved.sections[0].pins[0].connection).toEqual({ x: -3, y: 17 });
    expect(moved.sections[0].pins[0].body).toEqual({ x: 7, y: 17 });
    // 引脚长度不变
    expect(moved.sections[0].pins[0].length).toBe(10);
    // 图形不受影响
    expect(moved.sections[0].shapes).toEqual(symbol().sections[0].shapes);
  });

  it("keeps pin and shape keys in separate namespaces", () => {
    // 图形键 "0:0" 与引脚键 "p0:0" 必须互不干扰 —— 两侧都用 0 开头很容易撞
    const moved = applySymbolEdits(symbol(), {
      [symbolShapeKey(0, 0)]: { offset: { dx: 1, dy: 1 } },
      [symbolPinKey(0, 0)]: { offset: { dx: 2, dy: 2 } },
    });
    expect(moved.sections[0].shapes[0]).toMatchObject({ min: { x: 1, y: 1 } });
    expect(moved.sections[0].pins[0].connection).toEqual({ x: -8, y: 22 });
    expect(isSymbolPinKey(symbolPinKey(0, 0))).toBe(true);
    expect(parseSymbolEditKey(symbolPinKey(2, 5))).toEqual({ section: 2, index: 5 });
    expect(parseSymbolEditKey(symbolShapeKey(3, 4))).toEqual({ section: 3, index: 4 });
  });

  it("rotates text by 90° steps and applies font scale", () => {
    const rotated = applySymbolEdits(symbol(), {
      [symbolShapeKey(0, 2)]: { rotate: 1 },
      [symbolShapeKey(1, 0)]: { fontSize: 1.5 },
    });
    const text0 = rotated.sections[0].shapes[2];
    expect(text0.kind === "text" && text0.rotation).toBe(90);
    const text1 = rotated.sections[1].shapes[0];
    expect(text1.kind === "text" && text1.height).toBe(18);
  });

  it("ignores rotation / font edits on non-text shapes", () => {
    const edited = applySymbolEdits(symbol(), {
      [symbolShapeKey(0, 0)]: { rotate: 1 },
    });
    expect(edited.sections[0].shapes[0]).toEqual(symbol().sections[0].shapes[0]);
  });

  it("accumulates edits and clears a zero offset", () => {
    let edits = accumulateOffset(EMPTY_SYMBOL_EDITS, symbolShapeKey(0, 0), 5, 5);
    edits = accumulateOffset(edits, symbolShapeKey(0, 0), -5, 0);
    expect(edits[symbolShapeKey(0, 0)]).toEqual({ offset: { dx: 0, dy: 5 } });
    edits = accumulateOffset(edits, symbolShapeKey(0, 0), 0, -5);
    // 回到原点就该把记录删掉，不然"重置调整"按钮会一直显示
    expect(hasSymbolEdits(edits)).toBe(false);
  });

  it("wraps rotation and clamps font scale", () => {
    let edits = EMPTY_SYMBOL_EDITS;
    for (let i = 0; i < 4; i += 1) {
      edits = accumulateRotation(edits, symbolShapeKey(0, 2));
    }
    // 转满一圈 = 回到原样：复合模型下这条编辑整个消失（等价状态不留记录）
    expect(edits[symbolShapeKey(0, 2)]).toBeUndefined();
    expect(hasSymbolEdits(edits)).toBe(false);

    let sized = EMPTY_SYMBOL_EDITS;
    for (let i = 0; i < 40; i += 1) {
      sized = accumulateFontSize(sized, symbolShapeKey(0, 2), 1.15);
    }
    expect(sized[symbolShapeKey(0, 2)]?.fontSize).toBeLessThanOrEqual(4);

    let shrunk = EMPTY_SYMBOL_EDITS;
    for (let i = 0; i < 40; i += 1) {
      shrunk = accumulateFontSize(shrunk, symbolShapeKey(0, 2), 1 / 1.15);
    }
    expect(shrunk[symbolShapeKey(0, 2)]?.fontSize).toBeGreaterThanOrEqual(0.4);
  });

  /**
   * 复合编辑：一个元素可以**同时**有位移 / 旋转 / 字号 / 本体四边。
   * 早期是"一种编辑一个键"，先挪再转会把位移丢掉 —— 用户 2026-10-16 要求
   * "改完大小还能微调位置"，所以改成按项目分字段。
   */
  describe("复合编辑（互不覆盖）", () => {
    const key = symbolShapeKey(0, 2);

    it("位移 + 旋转 + 字号 共存", () => {
      let edits = accumulateOffset(EMPTY_SYMBOL_EDITS, key, 5, 5);
      edits = accumulateRotation(edits, key);
      edits = accumulateFontSize(edits, key, 1.5);
      expect(edits[key]).toEqual({ offset: { dx: 5, dy: 5 }, rotate: 1, fontSize: 1.5 });

      const applied = applySymbolEdits(symbol(), edits);
      const text = applied.sections[0].shapes[2];
      expect(text.kind === "text" && text.at).toEqual({ x: 15, y: 25 });
      expect(text.kind === "text" && text.rotation).toBe(90);
      expect(text.kind === "text" && text.height).toBe(18);
    });

    it("本体四边（改大小）+ 位移 共存：先改大小再挪，两者都在", () => {
      const rectKey = symbolShapeKey(0, 0);
      let edits = setRectBounds(EMPTY_SYMBOL_EDITS, rectKey, {
        min: { x: 0, y: 0 },
        max: { x: 200, y: 50 },
      });
      edits = accumulateOffset(edits, rectKey, 10, 0);

      const rect = applySymbolEdits(symbol(), edits).sections[0].shapes[0];
      expect(rect.kind === "rect" && rect.min).toEqual({ x: 10, y: 0 });
      expect(rect.kind === "rect" && rect.max).toEqual({ x: 210, y: 50 });
    });

    it("改大小不会把值反过来，也不会压成一条线", () => {
      const rectKey = symbolShapeKey(0, 0);
      // 拖过头：左右边对调
      const flipped = setRectBounds(EMPTY_SYMBOL_EDITS, rectKey, {
        min: { x: 120, y: 0 },
        max: { x: 20, y: 50 },
      });
      expect(flipped[rectKey]?.bounds).toEqual({ min: { x: 20, y: 0 }, max: { x: 120, y: 50 } });
      // 压到几乎没宽度 → 只把**被拖的边**按最小边长顶回去，另一边不动
      const squashedRight = setRectBounds(
        EMPTY_SYMBOL_EDITS,
        rectKey,
        { min: { x: 0, y: 0 }, max: { x: 1, y: 50 } },
        { left: false, right: true, top: false, bottom: false },
      );
      expect(squashedRight[rectKey]?.bounds).toEqual({ min: { x: 0, y: 0 }, max: { x: 10, y: 50 } });
      const squashedLeft = setRectBounds(
        EMPTY_SYMBOL_EDITS,
        rectKey,
        { min: { x: 0, y: 0 }, max: { x: 1, y: 50 } },
        { left: true, right: false, top: false, bottom: false },
      );
      expect(squashedLeft[rectKey]?.bounds).toEqual({ min: { x: -9, y: 0 }, max: { x: 1, y: 50 } });
    });

    it("各项回到默认值就把整条编辑删掉", () => {
      let edits = accumulateOffset(EMPTY_SYMBOL_EDITS, key, 5, 0);
      expect(edits[key]).toBeDefined();
      edits = accumulateOffset(edits, key, -5, 0);
      expect(edits[key]).toBeUndefined();
      expect(hasSymbolEdits(edits)).toBe(false);
    });
  });

  /**
   * 拖动位移必须除以预览缩放：内容挂在 scale(s) 的 <g> 上，鼠标走 N 像素
   * 等于世界坐标走 N/s。曾经引脚那一份漏了除法 → 缩放后引脚与图形拖动不同速。
   */
  describe("dragDelta（屏幕像素 → 世界单位）", () => {
    it("100% 时原样返回", () => {
      expect(dragDelta(10, -4, 1)).toEqual({ dx: 10, dy: -4 });
    });

    it("放大 2 倍时位移减半（画面上的跟随距离才一致）", () => {
      expect(dragDelta(10, -4, 2)).toEqual({ dx: 5, dy: -2 });
    });

    it("缩小到 25% 时位移放大 4 倍", () => {
      expect(dragDelta(10, 4, 0.25)).toEqual({ dx: 40, dy: 16 });
    });

    it("缩放值异常（0/负）时退化为原样，不产生 Infinity", () => {
      expect(dragDelta(10, 4, 0)).toEqual({ dx: 10, dy: 4 });
      expect(dragDelta(10, 4, -3)).toEqual({ dx: 10, dy: 4 });
    });
  });
});

describe("text content edit (user 2026-10-21)", () => {
  it("setTextContent 替换文本，其它编辑字段保留", () => {
    const key = symbolShapeKey(0, 0);
    const edits = setTextContent({ [key]: { offset: { dx: 5, dy: 0 } } }, key, "NEW");
    expect(edits[key]).toEqual({ offset: { dx: 5, dy: 0 }, text: "NEW" });
  });

  it("applySymbolEdits 用替换文本渲染", () => {
    const key = symbolShapeKey(0, 2);
    const applied = applySymbolEdits(symbol(), { [key]: { text: "REPLACED" } });
    const shape = applied.sections[0].shapes[2];
    expect(shape.kind === "text" ? shape.text : "").toBe("REPLACED");
  });

  it("空串保留为编辑（清空显示是有意义的操作）", () => {
    const key = symbolShapeKey(0, 0);
    const edits = setTextContent(EMPTY_SYMBOL_EDITS, key, "");
    expect(hasSymbolEdits(edits)).toBe(true);
    expect(hasSymbolEdits(setTextContent(EMPTY_SYMBOL_EDITS, key, undefined as never))).toBe(false);
  });
});

describe("append added texts (user 2026-10-21)", () => {
  it("追加到指定段末尾，编辑键按新下标生效", () => {
    const withAdded = appendAddedTexts(symbol(), [
      { kind: "text", id: "t1", section: 0, text: "文本", at: { x: 50, y: 50 }, height: 7 },
    ]);
    const shapes = withAdded.sections[0].shapes;
    expect(shapes).toHaveLength(4);
    const last = shapes[3];
    expect(last.kind === "text" ? last.text : "").toBe("文本");
    // 追加的形状用普通形状键即可编辑（拖动 / 改字）
    const applied = applySymbolEdits(withAdded, {
      [symbolShapeKey(0, 3)]: { text: "标注A", offset: { dx: 10, dy: 0 } },
    });
    const edited = applied.sections[0].shapes[3];
    expect(edited.kind === "text" ? edited.text : "").toBe("标注A");
    expect(edited.kind === "text" ? edited.at.x : 0).toBe(60);
  });

  it("没有追加时不改引用", () => {
    const base = symbol();
    expect(appendAddedTexts(base, undefined)).toBe(base);
    expect(appendAddedTexts(base, [])).toBe(base);
  });
});

describe("pin text edit (user 2026-10-22)", () => {
  it("setPinText 改引脚名并保留其它编辑", () => {
    const key = symbolPinKey(0, 0);
    const edits = setPinText({ [key]: { offset: { dx: 3, dy: 0 } } }, key, "name", "VIN");
    expect(edits[key]).toEqual({ offset: { dx: 3, dy: 0 }, pinText: { name: "VIN" } });
  });

  it("applySymbolEdits 用新引脚名/脚号渲染", () => {
    const key = symbolPinKey(0, 0);
    const applied = applySymbolEdits(symbol(), {
      [key]: { pinText: { name: "VBUS", number: "A1" } },
    });
    const pin = applied.sections[0].pins[0];
    expect(pin.name).toBe("VBUS");
    expect(pin.number).toBe("A1");
  });

  it("只改 name 时 number 保持原值", () => {
    const key = symbolPinKey(0, 0);
    const applied = applySymbolEdits(symbol(), { [key]: { pinText: { name: "X" } } });
    expect(applied.sections[0].pins[0].number).toBe("1");
  });
});

describe("hide comment text (user 2026-10-22)", () => {
  it("setTextHidden 标记隐藏；恢复时移除该字段", () => {
    const key = symbolShapeKey(0, 2);
    const hidden = setTextHidden({}, key, true);
    expect(hidden[key]?.hidden).toBe(true);
    expect(hasSymbolEdits(hidden)).toBe(true);
    expect(setTextHidden(hidden, key, false)).toEqual({});
  });

  it("applySymbolEdits 给文本打上 hidden（保留下标）", () => {
    const key = symbolShapeKey(0, 2);
    const applied = applySymbolEdits(symbol(), setTextHidden({}, key, true));
    const shapes = applied.sections[0].shapes;
    expect(shapes).toHaveLength(3);
    expect(shapes[2].kind === "text" ? shapes[2].hidden : undefined).toBe(true);
  });
});

/**
 * 用户 2026-10-22：对齐左侧引脚时，引脚本体被挪下边框。
 * 正确行为：只挪标签，引脚端点原地不动。
 */
describe("label-only shift", () => {
  const withAnchor = (): NormalizedSymbol => {
    const base = symbol();
    const pin = base.sections[0].pins[0];
    return {
      ...base,
      sections: [
        {
          ...base.sections[0],
          pins: [
            {
              ...pin,
              labelAnchor: { name: { x: 5, y: 20 }, number: { x: -5, y: 20 } },
            },
          ],
        },
      ],
    };
  };

  it("只平移 labelAnchor，连接端与本体端不变", () => {
    const key = symbolPinKey(0, 0);
    const applied = applySymbolEdits(withAnchor(), accumulateLabelShift({}, key, 6, -2));
    const pin = applied.sections[0].pins[0];
    expect(pin.connection).toEqual({ x: -10, y: 20 });
    expect(pin.body).toEqual({ x: 0, y: 20 });
    expect(pin.labelAnchor).toEqual({ name: { x: 11, y: 18 }, number: { x: 1, y: 18 } });
  });

  it("相对位移会累加", () => {
    const key = symbolPinKey(0, 0);
    const once = accumulateLabelShift({}, key, 3, 0);
    const twice = accumulateLabelShift(once, key, 2, 1);
    expect(twice[key]?.labelShift).toEqual({ dx: 5, dy: 1 });
  });
});

/**
 * 用户 2026-11-10：单击引脚标签不能把整条引脚一起激活，标签文本要能单独移动。
 * 标签键 `t<段>:<脚>:<name|number>` 与引脚键 `p<段>:<脚>` 完全独立。
 */
describe("independent pin label move", () => {
  const withAnchor = (): NormalizedSymbol => {
    const base = symbol();
    const pin = base.sections[0].pins[0];
    return {
      ...base,
      sections: [
        {
          ...base.sections[0],
          pins: [
            { ...pin, labelAnchor: { name: { x: 5, y: 20 }, number: { x: -5, y: 20 } } },
          ],
        },
      ],
    };
  };

  it("只挪被点到的那个标签，引脚两端与另一个标签不动", () => {
    const applied = applySymbolEdits(
      withAnchor(),
      accumulateOffset({}, symbolPinLabelKey(0, 0, "name"), 7, -3),
    );
    const pin = applied.sections[0].pins[0];
    expect(pin.connection).toEqual({ x: -10, y: 20 });
    expect(pin.body).toEqual({ x: 0, y: 20 });
    expect(pin.labelAnchor).toEqual({ name: { x: 12, y: 17 }, number: { x: -5, y: 20 } });
  });

  it("名字与脚号各走各的键", () => {
    const edits = accumulateOffset(
      accumulateOffset({}, symbolPinLabelKey(0, 0, "name"), 4, 0),
      symbolPinLabelKey(0, 0, "number"),
      -2,
      6,
    );
    const pin = applySymbolEdits(withAnchor(), edits).sections[0].pins[0];
    expect(pin.labelAnchor).toEqual({ name: { x: 9, y: 20 }, number: { x: -7, y: 26 } });
  });

  it("标签键不会被当成整条引脚", () => {
    const labelKey = symbolPinLabelKey(2, 5, "number");
    expect(isSymbolPinKey(labelKey)).toBe(false);
    expect(isSymbolPinLabelKey(labelKey)).toBe(true);
    expect(parseSymbolPinLabelKey(labelKey)).toEqual({ section: 2, pinIndex: 5, kind: "number" });
    // 属性面板/命中盒按引脚取元素：标签键解出的 index 就是引脚序号
    expect(parseSymbolEditKey(labelKey)).toEqual({ section: 2, index: 5 });
  });
});

/**
 * 用户 2026-11-11：「再添加啊支持线段，圆，矩形 任意画线」。
 * 三种图形共用 from/to 两点表达，展开成普通图形后预览与写库走同一条路径。
 */
describe("drawn shapes (user 2026-11-11)", () => {
  it("线段展开成两点折线", () => {
    const shape = addedItemToShape({
      kind: "line",
      id: "d1",
      section: 0,
      from: { x: 10, y: 20 },
      to: { x: 60, y: 40 },
    });
    expect(shape.kind).toBe("polyline");
    if (shape.kind !== "polyline") {
      return;
    }
    expect(shape.points).toEqual([
      { x: 10, y: 20 },
      { x: 60, y: 40 },
    ]);
    expect(shape.closed).toBe(false);
    expect(shape.added).toBe(true);
  });

  it("矩形归一化对角点（从右下往左上拖也一样）", () => {
    const shape = addedItemToShape({
      kind: "rect",
      id: "d2",
      section: 0,
      from: { x: 60, y: 40 },
      to: { x: 10, y: 20 },
    });
    expect(shape).toMatchObject({
      kind: "rect",
      min: { x: 10, y: 20 },
      max: { x: 60, y: 40 },
      filled: false,
      added: true,
    });
  });

  /**
   * 圆必须带 `primitive`：写库靠它出原生 `<Ellipse>`，
   * 靠采样点的话半径 3 的小圆会被整数取整成八边形（见 symbol-labels 的注释）。
   */
  it("圆展开成闭合折线 + 椭圆参数", () => {
    const shape = addedItemToShape({
      kind: "circle",
      id: "d3",
      section: 0,
      from: { x: 30, y: 30 },
      to: { x: 40, y: 30 },
    });
    expect(shape.kind).toBe("polyline");
    if (shape.kind !== "polyline") {
      return;
    }
    expect(shape.closed).toBe(true);
    expect(shape.points).toHaveLength(64);
    expect(shape.primitive).toEqual({
      type: "ellipse",
      center: { x: 30, y: 30 },
      rx: 10,
      ry: 10,
    });
    // 采样点确实是半径 10 的圆
    for (const point of shape.points) {
      expect(Math.hypot(point.x - 30, point.y - 30)).toBeCloseTo(10, 6);
    }
  });

  it("按加入顺序追加到段末尾：文本与图形混排也不打乱下标", () => {
    const withAdded = appendAddedItems(symbol(), [
      { kind: "text", id: "t1", section: 0, text: "A", at: { x: 1, y: 1 }, height: 7 },
      { kind: "line", id: "d1", section: 0, from: { x: 2, y: 2 }, to: { x: 3, y: 3 } },
      { kind: "text", id: "t2", section: 0, text: "B", at: { x: 4, y: 4 }, height: 7 },
    ]);
    const shapes = withAdded.sections[0].shapes;
    const tail = shapes.slice(shapes.length - 3);
    expect(tail.map((shape) => shape.kind)).toEqual(["text", "polyline", "text"]);
    expect(tail.map((shape) => shape.added)).toEqual([true, true, true]);
  });

  it("平移同时挪 from 与 to", () => {
    const moved = translateAddedItem(
      { kind: "circle", id: "d3", section: 0, from: { x: 30, y: 30 }, to: { x: 40, y: 30 } },
      10,
      -5,
    );
    expect(moved.kind).toBe("circle");
    if (moved.kind === "text") {
      return;
    }
    expect(moved.from).toEqual({ x: 40, y: 25 });
    expect(moved.to).toEqual({ x: 50, y: 25 });
  });

  it("Shift 约束：线段锁水平/竖直/45°，矩形锁正方形", () => {
    const from = { x: 0, y: 0 };
    // 明显偏水平的位移 → 锁水平
    expect(constrainDrawPoint("line", from, { x: 100, y: 8 }, true)).toEqual({ x: 100, y: 0 });
    // 明显偏竖直 → 锁竖直
    expect(constrainDrawPoint("line", from, { x: 6, y: 90 }, true)).toEqual({ x: 0, y: 90 });
    // 差不多 → 45°
    expect(constrainDrawPoint("line", from, { x: 40, y: 44 }, true)).toEqual({ x: 42, y: 42 });
    // 矩形取长边做正方形，两条边同长、方向跟着拖
    expect(constrainDrawPoint("rect", from, { x: 80, y: 20 }, true)).toEqual({ x: 80, y: 80 });
    expect(constrainDrawPoint("rect", from, { x: 20, y: 80 }, true)).toEqual({ x: 80, y: 80 });
    // 不按 Shift 原样返回
    expect(constrainDrawPoint("rect", from, { x: 80, y: 20 }, false)).toEqual({ x: 80, y: 20 });
  });

  it("软删除的图形保留在下标里，但不再参与包围盒/框选", () => {
    const withAdded = appendAddedItems(symbol(), [
      { kind: "rect", id: "d1", section: 0, from: { x: 10, y: 10 }, to: { x: 20, y: 20 } },
    ]);
    const index = withAdded.sections[0].shapes.length - 1;
    const hidden = applySymbolEdits(withAdded, { [symbolShapeKey(0, index)]: { hidden: true } });
    expect(hidden.sections[0].shapes[index].hidden).toBe(true);
  });
});

/** 用户 2026-11-11：「文本支持复制粘贴」—— 复制/再制取的是"屏幕上看到的那一份"。 */
describe("selectionToAddedItems (copy & paste)", () => {
  const makeId = (prefix: string): string => `${prefix}1`;

  const withDrawn = (): NormalizedSymbol =>
    appendAddedItems(symbol(), [
      { kind: "circle", id: "d1", section: 0, from: { x: 30, y: 30 }, to: { x: 40, y: 30 } },
      { kind: "line", id: "d2", section: 0, from: { x: 5, y: 5 }, to: { x: 15, y: 9 } },
    ]);

  it("复制文本：内容、位置、字号、旋转原样带过来", () => {
    const section = symbol().sections[0];
    const textIndex = section.shapes.findIndex((shape) => shape.kind === "text");
    const items = selectionToAddedItems(section, 0, [symbolShapeKey(0, textIndex)], makeId);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe("text");
    if (item.kind !== "text") {
      return;
    }
    expect(item.text).toBe(section.shapes[textIndex].kind === "text" ? section.shapes[textIndex].text : "");
    expect(item.at).toEqual({ x: 10, y: 20 });
    expect(item.rotation).toBe(0);
  });

  it("引脚与引脚标签都不参与复制（会凭空多脚）", () => {
    const section = symbol().sections[0];
    expect(
      selectionToAddedItems(
        section,
        0,
        [symbolPinKey(0, 0), symbolPinLabelKey(0, 0, "name"), symbolPinLabelKey(0, 0, "number")],
        makeId,
      ),
    ).toHaveLength(0);
  });

  it("源库图形不复制（多段折线压成线段会失真）", () => {
    const section = symbol().sections[0];
    const rectIndex = section.shapes.findIndex((shape) => shape.kind === "rect");
    expect(selectionToAddedItems(section, 0, [symbolShapeKey(0, rectIndex)], makeId)).toHaveLength(0);
  });

  it("复制用户画的圆：从 primitive 反推圆心与半径", () => {
    const section = withDrawn().sections[0];
    const circleIndex = section.shapes.length - 2;
    const items = selectionToAddedItems(section, 0, [symbolShapeKey(0, circleIndex)], makeId);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe("circle");
    if (item.kind !== "circle") {
      return;
    }
    expect(item.from).toEqual({ x: 30, y: 30 });
    expect(item.to).toEqual({ x: 40, y: 30 });
  });

  it("复制用户画的线段：取首末点", () => {
    const section = withDrawn().sections[0];
    const lineIndex = section.shapes.length - 1;
    const items = selectionToAddedItems(section, 0, [symbolShapeKey(0, lineIndex)], makeId);
    expect(items[0]).toMatchObject({
      kind: "line",
      from: { x: 5, y: 5 },
      to: { x: 15, y: 9 },
    });
  });

  it("已删除（hidden）的文本不再被复制", () => {
    const base = symbol();
    const section = base.sections[0];
    const textIndex = section.shapes.findIndex((shape) => shape.kind === "text");
    const hiddenSection = {
      ...section,
      shapes: section.shapes.map((shape, index) =>
        index === textIndex ? { ...shape, hidden: true } : shape,
      ),
    };
    expect(selectionToAddedItems(hiddenSection, 0, [symbolShapeKey(0, textIndex)], makeId)).toHaveLength(0);
  });
});
