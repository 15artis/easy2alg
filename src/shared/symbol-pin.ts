import type { NormalizedSymbolPin } from "./schemas";
import type { SymbolPinPoints } from "./symbol-edit";
import { snapValue, type SnapState } from "./symbol-snap";
import { pinLabelAnchors, type SymbolBox } from "./symbol-labels";

/**
 * 引脚换边重定向（用户 2026-10-21，0.1.42 修正上下方向）。
 *
 * 规则：**引脚永远贴在本体边上、朝外**。松手时按当前点位判断应属于哪条边，
 * 然后重建两个端点与标签锚点：
 *  - 外端 = 连接端（离本体中心更远的那个点，拖过界后原来哪个点已经不重要）
 *  - 内端 = 贴在本体边上的点，垂直方向坐标保留并**夹到边的跨度内**
 *    （否则左引脚上拖会变成"悬在本体上方的一根横脚"）
 *  - 长度 = 原两点在轴向的最大跨度（不小于 1）
 *  - 标签锚点按新边重算 —— 上下引脚的名称是竖排的，缺锚点会横跨整个符号
 *
 * 边归属优先看**拖动方向**：左引脚被往上拖时 x 仍在本体左侧，只比"超出量"会
 * 一直判成左侧（用户看到的就是"放到上下侧不正常"）。拖得更偏竖直就优先上下边。
 */

export type PinSide = "left" | "right" | "top" | "bottom";
export type DragBias = "horizontal" | "vertical";

type Point = { readonly x: number; readonly y: number };

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

const centerOf = (body: SymbolBox): Point => ({
  x: (body.minX + body.maxX) / 2,
  y: (body.minY + body.maxY) / 2,
});

/** 离本体中心更远的那个端点 —— 它应该是连接端。 */
const outerPointOf = (pin: NormalizedSymbolPin, body: SymbolBox): Point => {
  const center = centerOf(body);
  return distance(pin.connection, center) >= distance(pin.body, center)
    ? pin.connection
    : pin.body;
};

const innerPointOf = (pin: NormalizedSymbolPin, body: SymbolBox): Point =>
  outerPointOf(pin, body) === pin.connection ? pin.body : pin.connection;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * 判断外端点应归属哪条边；已经贴边且方向正确时返回 null。
 *
 * `bias` 来自本次拖动的方向，只用来**打破拐角处的平局**（例如左引脚往上拖，
 * 左侧与上侧的超出量可能一样大）。
 */
const sideOfOuterPoint = (
  outer: Point,
  body: SymbolBox,
  bias: DragBias,
  tolerance = 0.5,
): PinSide | null => {
  const overshoot: readonly (readonly [PinSide, number])[] = [
    ["left", body.minX - outer.x],
    ["right", outer.x - body.maxX],
    ["top", body.minY - outer.y],
    ["bottom", outer.y - body.maxY],
  ];
  const outside = overshoot.filter(([, value]) => value > tolerance);
  if (outside.length > 0) {
    const preferred: readonly PinSide[] =
      bias === "vertical" ? ["top", "bottom"] : ["left", "right"];
    const preferredHits = outside.filter(([side]) => preferred.includes(side));
    const pool = preferredHits.length > 0 ? preferredHits : outside;
    return [...pool].sort((a, b) => b[1] - a[1])[0][0];
  }
  // 端点落在本体内部：吸到最近的一条边（引脚不应悬在体内）
  const inside: readonly (readonly [PinSide, number])[] = [
    ["left", outer.x - body.minX],
    ["right", body.maxX - outer.x],
    ["top", outer.y - body.minY],
    ["bottom", body.maxY - outer.y],
  ];
  const nearest = [...inside].sort((a, b) => a[1] - b[1])[0];
  return nearest[1] > tolerance ? nearest[0] : null;
};

const samePoint = (a: Point, b: Point): boolean =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/**
 * 返回重定向后的端点 + 标签锚点；不需要改时返回 null。
 * 吸附开启时，沿边的坐标会落到当前档位。
 */
export const reorientPin = (
  pin: NormalizedSymbolPin,
  body: SymbolBox,
  snap: SnapState,
  bias: DragBias = "horizontal",
): SymbolPinPoints | null => {
  const outer = outerPointOf(pin, body);
  const side = sideOfOuterPoint(outer, body, bias);
  if (side === null) {
    return null;
  }
  const inner = innerPointOf(pin, body);
  const span = Math.max(
    Math.abs(pin.connection.x - pin.body.x),
    Math.abs(pin.connection.y - pin.body.y),
    1,
  );
  const along = (value: number): number => (snap.enabled ? snapValue(value, snap.grid) : value);
  const horizontal = side === "left" || side === "right";

  const points: SymbolPinPoints = horizontal
    ? {
        body: {
          x: side === "left" ? body.minX : body.maxX,
          y: clamp(along(inner.y), body.minY, body.maxY),
        },
        connection: {
          x: (side === "left" ? body.minX : body.maxX) + (side === "left" ? -span : span),
          y: clamp(along(inner.y), body.minY, body.maxY),
        },
      }
    : {
        body: {
          x: clamp(along(inner.x), body.minX, body.maxX),
          y: side === "top" ? body.minY : body.maxY,
        },
        connection: {
          x: clamp(along(inner.x), body.minX, body.maxX),
          y: (side === "top" ? body.minY : body.maxY) + (side === "top" ? -span : span),
        },
      };

  if (samePoint(points.body, pin.body) && samePoint(points.connection, pin.connection)) {
    return null;
  }
  // 上下引脚的名称/脚号是竖排的：必须按新边重算锚点，否则文字会从本体另一端拉过来
  return {
    ...points,
    labelAnchor: pinLabelAnchors({ ...pin, ...points }, body),
  };
};
