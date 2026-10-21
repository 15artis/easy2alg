import { describe, expect, it } from "vitest";
import { reattachPinsToBounds, reorientPin } from "../src/shared/symbol-pin";
import { pinLabelAnchors } from "../src/shared/symbol-labels";
import { applySymbolEdits, setPinPoints, symbolPinKey } from "../src/shared/symbol-edit";
import type {
  NormalizedSymbol,
  NormalizedSymbolPin,
  NormalizedSymbolSection,
} from "../src/shared/schemas";

/**
 * 用户 2026-10-21：把右侧引脚拖到左侧后，引脚**方向**必须翻过来（连接端朝外），
 * 上下同理。否则连接点落在本体内侧，Capture 里接不上线。
 */
const body = { minX: 0, minY: 0, maxX: 100, maxY: 60 };

const pin = (connection: { x: number; y: number }, bodyPoint: { x: number; y: number }): NormalizedSymbolPin => ({
  name: "P1",
  number: "1",
  connection,
  body: bodyPoint,
  length: 10,
  type: "passive",
  visible: true,
});

const snapOn = { enabled: true, grid: 10 };
const snapOff = { enabled: false, grid: 10 };

describe("pin reorientation", () => {
  it("右侧引脚原样摆放时不需要改", () => {
    expect(reorientPin(pin({ x: 110, y: 20 }, { x: 100, y: 20 }), body, snapOn)).toBeNull();
  });

  it("右侧引脚拖到左侧：连接端翻到左边、body 端贴左边缘", () => {
    // 用户整脚平移过界后：body 在 -10、connection 在 0（原样只平移，方向没变）
    const points = reorientPin(pin({ x: 0, y: 20 }, { x: -10, y: 20 }), body, snapOn);
    expect(points).not.toBeNull();
    expect(points!.body).toEqual({ x: 0, y: 20 });
    expect(points!.connection).toEqual({ x: -10, y: 20 });
  });

  it("右侧引脚拖到上边：变成竖直向上", () => {
    const points = reorientPin(pin({ x: 40, y: 0 }, { x: 40, y: -10 }), body, snapOn);
    expect(points).not.toBeNull();
    expect(points!.body).toEqual({ x: 40, y: 0 });
    expect(points!.connection).toEqual({ x: 40, y: -10 });
  });

  it("右侧引脚拖到下边：变成竖直向下", () => {
    const points = reorientPin(pin({ x: 40, y: 60 }, { x: 40, y: 70 }), body, snapOn);
    expect(points!.body).toEqual({ x: 40, y: 60 });
    expect(points!.connection).toEqual({ x: 40, y: 70 });
  });

  it("拖进本体内部：吸到最近的边（长度按原跨度保留）", () => {
    // 两点都在本体内，外端(5,30)离左边最近 → 重建到左边缘，跨度仍是 10
    const points = reorientPin(pin({ x: 15, y: 30 }, { x: 5, y: 30 }), body, snapOn);
    expect(points!.body).toEqual({ x: 0, y: 30 });
    expect(points!.connection).toEqual({ x: -10, y: 30 });
  });

  it("换边后垂直坐标落到当前档位", () => {
    const points = reorientPin(pin({ x: 0, y: 23 }, { x: -10, y: 23 }), body, snapOn);
    expect(points!.body.y).toBe(20);
    // 关闭吸附时保留实际值
    expect(reorientPin(pin({ x: 0, y: 23 }, { x: -10, y: 23 }), body, snapOff)!.body.y).toBe(23);
  });

  it("已经贴边且朝外时不做多余编辑", () => {
    expect(reorientPin(pin({ x: 10, y: 20 }, { x: 0, y: 20 }), body, snapOn)).toBeNull();
    expect(reorientPin(pin({ x: 40, y: 0 }, { x: 40, y: 10 }), body, snapOn)).toBeNull();
  });
});

describe("pin points edit", () => {
  const symbol = (): NormalizedSymbol => ({
    name: "TESTPART",
    refdesPrefix: "U",
    pcbFootprint: "",
    sections: [
      {
        name: "TESTPART",
        bounds: body,
        pins: [
          {
            ...pin({ x: 110, y: 20 }, { x: 100, y: 20 }),
            labelAnchor: {
              name: { x: 90, y: 20 },
              number: { x: 95, y: 20 },
            },
          },
        ],
        shapes: [
          { kind: "rect", min: { x: 0, y: 0 }, max: { x: 100, y: 60 }, cornerRadius: 0, filled: false },
        ],
      },
    ],
    sourceJson: "{}",
  });

  it("points 未带锚点时清掉旧锚点（避免沿用旧边位置）", () => {
    const edits = setPinPoints({}, symbolPinKey(0, 0), {
      body: { x: 0, y: 20 },
      connection: { x: -10, y: 20 },
    });
    const applied = applySymbolEdits(symbol(), edits);
    const next = applied.sections[0].pins[0];
    expect(next.body).toEqual({ x: 0, y: 20 });
    expect(next.connection).toEqual({ x: -10, y: 20 });
    expect(next.labelAnchor).toBeUndefined();
  });

  it("setPinPoints 清掉旧的位移，不会二次叠加", () => {
    const moved = { [symbolPinKey(0, 0)]: { offset: { dx: -110, dy: 0 } } };
    const edits = setPinPoints(moved, symbolPinKey(0, 0), {
      body: { x: 0, y: 20 },
      connection: { x: -10, y: 20 },
    });
    expect(edits[symbolPinKey(0, 0)]?.offset).toBeUndefined();
    const next = applySymbolEdits(symbol(), edits).sections[0].pins[0];
    expect(next.connection).toEqual({ x: -10, y: 20 });
  });
});

/**
 * 0.1.42：上下方向修正（用户 2026-10-21 第二次反馈）。
 * 左引脚往上拖时 x 仍在本体左侧，只比"超出量"会一直判成左侧；
 * 上下引脚的标签锚点也必须按新边重算，否则竖排名字横跨整个本体。
 */
describe("pin reorientation (vertical sides)", () => {
  const leftPinDraggedUp = (): NormalizedSymbolPin =>
    pin({ x: -10, y: -10 }, { x: 0, y: -10 });

  it("左引脚向上拖：按拖动方向判成上边，端点贴顶边", () => {
    const points = reorientPin(leftPinDraggedUp(), body, snapOn, "vertical");
    expect(points).not.toBeNull();
    expect(points!.body).toEqual({ x: 0, y: 0 });
    expect(points!.connection).toEqual({ x: 0, y: -10 });
  });

  it("同样的位置但水平拖动：仍判左侧，且 y 夹在本体高度内（不悬空）", () => {
    const points = reorientPin(leftPinDraggedUp(), body, snapOn, "horizontal");
    expect(points!.body).toEqual({ x: 0, y: 0 });
    expect(points!.connection).toEqual({ x: -10, y: 0 });
  });

  it("上边引脚的标签锚点按新边重算（名称在本体内、脚号在本体外）", () => {
    const points = reorientPin(leftPinDraggedUp(), body, snapOn, "vertical");
    expect(points!.labelAnchor).toBeDefined();
    const anchor = points!.labelAnchor!;
    expect(anchor.name.y).toBeGreaterThan(body.minY);
    expect(anchor.name.y).toBeLessThan(body.maxY);
    expect(anchor.number.y).toBeLessThan(body.minY);
  });

  it("上引脚拖到下边：方向翻成朝下", () => {
    const topPin: NormalizedSymbolPin = {
      ...pin({ x: 40, y: 60 }, { x: 40, y: 70 }),
    };
    // 原来的上引脚（conn 在上、body 在下）平移到下边后：conn 60 / body 70
    const points = reorientPin(topPin, body, snapOn, "vertical");
    expect(points!.body).toEqual({ x: 40, y: 60 });
    expect(points!.connection).toEqual({ x: 40, y: 70 });
  });

  it("applySymbolEdits 保留 points 里的标签锚点", () => {
    const section = {
      name: "TESTPART",
      bounds: body,
      pins: [pin({ x: 110, y: 20 }, { x: 100, y: 20 })],
      shapes: [
        { kind: "rect" as const, min: { x: 0, y: 0 }, max: { x: 100, y: 60 }, cornerRadius: 0, filled: false },
      ],
    };
    const symbol = {
      name: "TESTPART",
      refdesPrefix: "U",
      pcbFootprint: "",
      sections: [section],
      sourceJson: "{}",
    };
    const anchor = { name: { x: 0, y: 5 }, number: { x: 0, y: -5 } };
    const edits = setPinPoints({}, symbolPinKey(0, 0), {
      body: { x: 0, y: 0 },
      connection: { x: 0, y: -10 },
      labelAnchor: anchor,
    });
    const next = applySymbolEdits(symbol, edits).sections[0].pins[0];
    expect(next.labelAnchor).toEqual(anchor);
  });
});

/**
 * 0.1.42 第二批：本体改大小后引脚跟着边走（用户 2026-10-21 第三次反馈）。
 * 截图里 GPIO0-25 全部留在旧位置、缩进了新边框内侧。
 */
describe("reattach pins after body resize", () => {
  const bodyBox = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const bodySection = (): NormalizedSymbolSection => {
    const base = {
      name: "TESTPART",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
      pins: [
        pin({ x: -10, y: 10 }, { x: 0, y: 10 }),      // 左
        pin({ x: 110, y: 10 }, { x: 100, y: 10 }),    // 右
        pin({ x: 110, y: 20 }, { x: 100, y: 20 }),    // 右
        pin({ x: 110, y: 30 }, { x: 100, y: 30 }),    // 右
        pin({ x: 40, y: -10 }, { x: 40, y: 0 }),      // 上
      ],
      shapes: [
        { kind: "rect" as const, min: { x: 0, y: 0 }, max: { x: 100, y: 60 }, cornerRadius: 0, filled: false },
      ],
    };
    // 真实符号在解析期就带锚点；补上它，"没动的引脚"才不会因为补锚点而进 entries
    return {
      ...base,
      pins: base.pins.map((item) => ({ ...item, labelAnchor: pinLabelAnchors(item, bodyBox) })),
    };
  };

  it("右边缘拉大：右侧引脚跟着移到新边缘", () => {
    const entries = reattachPinsToBounds(bodySection(), 0, { minX: 0, minY: 0, maxX: 160, maxY: 60 }, snapOn);
    const right = entries.filter((entry) => entry.key === "p0:1" || entry.key === "p0:2" || entry.key === "p0:3");
    expect(right).toHaveLength(3);
    for (const entry of right) {
      expect(entry.points.body.x).toBe(160);
      expect(entry.points.connection.x).toBe(170);
    }
    // 左引脚 / 上引脚不动（左边缘、上边缘没动，锚点也不变）
    expect(entries.find((entry) => entry.key === "p0:0")).toBeUndefined();
    expect(entries.find((entry) => entry.key === "p0:4")).toBeUndefined();
  });

  it("左边缘右移：左侧引脚跟着走，右侧引脚不动", () => {
    const entries = reattachPinsToBounds(bodySection(), 0, { minX: 30, minY: 0, maxX: 100, maxY: 60 }, snapOn);
    const left = entries.find((entry) => entry.key === "p0:0");
    expect(left!.points.body).toEqual({ x: 30, y: 10 });
    expect(left!.points.connection).toEqual({ x: 20, y: 10 });
    expect(entries.find((entry) => entry.key === "p0:1")).toBeUndefined();
  });

  it("上边缘下移：上引脚跟着走", () => {
    const entries = reattachPinsToBounds(bodySection(), 0, { minX: 0, minY: 10, maxX: 100, maxY: 60 }, snapOn);
    const top = entries.find((entry) => entry.key === "p0:4");
    expect(top!.points.body).toEqual({ x: 40, y: 10 });
    expect(top!.points.connection).toEqual({ x: 40, y: 0 });
  });

  it("一排里出现重叠（间距小于一格）时：按顺序均匀铺开", () => {
    // 三个右引脚 y=10/15/20（间距 5 < 10 会叠），本体高度 60 够铺开
    const section = bodySection();
    const crowded = {
      ...section,
      pins: [
        section.pins[0],
        pin({ x: 110, y: 10 }, { x: 100, y: 10 }),
        pin({ x: 110, y: 15 }, { x: 100, y: 15 }),
        pin({ x: 110, y: 20 }, { x: 100, y: 20 }),
        section.pins[4],
      ],
    };
    const entries = reattachPinsToBounds(crowded, 0, { minX: 0, minY: 0, maxX: 100, maxY: 60 }, snapOn);
    const right = ["p0:1", "p0:2", "p0:3"].map(
      (key) => entries.find((entry) => entry.key === key)!.points,
    );
    const ys = right.map((points) => points.body.y).sort((x, y) => x - y);
    // 均匀铺在 0..60：0 / 30 / 60
    expect(ys).toEqual([0, 30, 60]);
    for (const points of right) {
      expect(points.body.x).toBe(100);
      expect(points.connection.x).toBe(110);
    }
  });

  it("间距仍然足够时不重排（保留用户摆好的不规则间距）", () => {
    const section = bodySection();
    // y=10/25/45：相邻间距 15/20 都 ≥ 10
    const spread = {
      ...section,
      pins: [
        section.pins[0],
        pin({ x: 110, y: 10 }, { x: 100, y: 10 }),
        pin({ x: 110, y: 25 }, { x: 100, y: 25 }),
        pin({ x: 110, y: 45 }, { x: 100, y: 45 }),
        section.pins[4],
      ],
    };
    const entries = reattachPinsToBounds(spread, 0, { minX: 0, minY: 0, maxX: 90, maxY: 60 }, snapOn);
    const moved = entries.filter((entry) => entry.key !== "p0:0" && entry.key !== "p0:4");
    for (const entry of moved) {
      expect(entry.points.body.x).toBe(90);
    }
    const ys = moved.map((entry) => entry.points.body.y).sort((a, b) => a - b);
    expect(ys).toEqual([10, 25, 45]);
  });

  it("沿边坐标超出缩短后的边长时被夹回来", () => {
    // 上引脚 x=40，本体右边缘缩到 30 → x 夹到 30
    const entries = reattachPinsToBounds(bodySection(), 0, { minX: 0, minY: 0, maxX: 30, maxY: 60 }, snapOn);
    const top = entries.find((entry) => entry.key === "p0:4");
    expect(top!.points.body.x).toBe(30);
    expect(top!.points.connection.y).toBe(-10);
  });
});
