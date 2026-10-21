import type { NormalizedSymbolPin } from "./schemas";
import type { SymbolPinPoints } from "./symbol-edit";
import { snapValue, type SnapState } from "./symbol-snap";
import type { SymbolBox } from "./symbol-labels";

/**
 * 引脚换边重定向（用户 2026-10-21）。
 *
 * 问题：把右侧引脚拖到左侧后，引脚只是被平移，方向仍然朝右 —— 连接端（圆点）
 * 落在本体内侧、引脚线从外往内画，Capture 里根本接不上。
 *
 * 规则：**引脚永远贴在本体边上、朝外**。松手时按当前点位判断应属于哪条边，
 * 然后重建两个端点：
 *  - 外端 = 连接端（离本体中心更远的那个点，拖过界后原来哪个点已经不重要）
 *  - 内端 = 贴在本体边上的点，垂直方向坐标保留
 *  - 长度 = 原两点在轴向的最大跨度（不小于 1）
 */

export type PinSide = "left" | "right" | "top" | "bottom";

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

/** 判断外端点应归属哪条边；已经贴边（不需要改）时返回 null。 */
const sideOfOuterPoint = (outer: Point, body: SymbolBox, tolerance = 0.5): PinSide | null => {
  const overshoot: readonly (readonly [PinSide, number])[] = [
    ["left", body.minX - outer.x],
    ["right", outer.x - body.maxX],
    ["top", body.minY - outer.y],
    ["bottom", outer.y - body.maxY],
  ];
  const best = [...overshoot].sort((a, b) => b[1] - a[1])[0];
  if (best[1] > tolerance) {
    return best[0];
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
 * 返回重定向后的端点；不需要改（已在正确的边上、且方向朝外）时返回 null。
 * 吸附开启时，垂直方向的坐标会落到当前档位。
 */
export const reorientPin = (
  pin: NormalizedSymbolPin,
  body: SymbolBox,
  snap: SnapState,
): SymbolPinPoints | null => {
  const outer = outerPointOf(pin, body);
  const side = sideOfOuterPoint(outer, body);
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
        body: { x: side === "left" ? body.minX : body.maxX, y: along(inner.y) },
        connection: {
          x: (side === "left" ? body.minX : body.maxX) + (side === "left" ? -span : span),
          y: along(inner.y),
        },
      }
    : {
        body: { x: along(inner.x), y: side === "top" ? body.minY : body.maxY },
        connection: {
          x: along(inner.x),
          y: (side === "top" ? body.minY : body.maxY) + (side === "top" ? -span : span),
        },
      };

  if (samePoint(points.body, pin.body) && samePoint(points.connection, pin.connection)) {
    return null;
  }
  return points;
};
