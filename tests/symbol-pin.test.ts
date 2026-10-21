import { describe, expect, it } from "vitest";
import { reorientPin } from "../src/shared/symbol-pin";
import { applySymbolEdits, setPinPoints, symbolPinKey } from "../src/shared/symbol-edit";
import type { NormalizedSymbol, NormalizedSymbolPin } from "../src/shared/schemas";

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
