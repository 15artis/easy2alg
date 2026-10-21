import type { NormalizedSymbolPin, NormalizedSymbolSection } from "./schemas";
import { symbolPinKey, type SymbolPinPoints } from "./symbol-edit";
import { snapValue, type SnapState } from "./symbol-snap";
import { pinLabelAnchors, pinSideOf, type SymbolBox } from "./symbol-labels";

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

// ---------- 本体改大小后，让引脚跟着重新贴边 ----------

export type PinAttachEntry = {
  readonly key: string;
  readonly points: SymbolPinPoints;
};

const normalizeBox = (box: SymbolBox): SymbolBox => ({
  minX: Math.min(box.minX, box.maxX),
  minY: Math.min(box.minY, box.maxY),
  maxX: Math.max(box.minX, box.maxX),
  maxY: Math.max(box.minY, box.maxY),
});

const sameOptionalPoint = (a: Point | undefined, b: Point | undefined): boolean =>
  a === undefined || b === undefined ? a === b : samePoint(a, b);

/**
 * 本体改大小后重建所有引脚的贴边几何（用户 2026-10-21）。
 *
 * - 每条边上的引脚跟着边移动（右边缘右移 → 右侧引脚的 body/connection 一起右移）
 * - 沿边坐标夹到新的边长内；夹完如果有重叠，**按顺序把这一排均匀铺开**
 *   （间距至少一个网格；边太短铺不开时也只能尽量均匀，至少不会叠在同一个点上）
 * - 标签锚点按新本体重算（上下引脚的竖排名字才不会跑到别处）
 *
 * 只返回真有变化的引脚；`edges` 用不到，保留参数是为了将来做"只重排被拖边"的优化。
 */
export const reattachPinsToBounds = (
  section: NormalizedSymbolSection,
  sectionIndex: number,
  bounds: SymbolBox,
  snap: SnapState,
): PinAttachEntry[] => {
  const body = normalizeBox(bounds);
  const along = (value: number): number => (snap.enabled ? snapValue(value, snap.grid) : value);
  const sides: readonly PinSide[] = ["left", "right", "top", "bottom"];

  // ① 每个引脚按它当前所属的边重建
  const rebuilt = section.pins.map((pin) => {
    const side = pinSideOf(pin);
    const horizontal = side === "left" || side === "right";
    const span = Math.max(
      Math.abs(pin.connection.x - pin.body.x),
      Math.abs(pin.connection.y - pin.body.y),
      1,
    );
    const perpendicular = clamp(
      horizontal ? pin.body.y : pin.body.x,
      horizontal ? body.minY : body.minX,
      horizontal ? body.maxY : body.maxX,
    );
    const points: SymbolPinPoints = horizontal
      ? {
          body: { x: side === "left" ? body.minX : body.maxX, y: perpendicular },
          connection: {
            x: (side === "left" ? body.minX : body.maxX) + (side === "left" ? -span : span),
            y: perpendicular,
          },
        }
      : {
          body: { x: perpendicular, y: side === "top" ? body.minY : body.maxY },
          connection: {
            x: perpendicular,
            y: (side === "top" ? body.minY : body.maxY) + (side === "top" ? -span : span),
          },
        };
    return { side, points };
  });

  // ② 同一排里出现重叠 → 按顺序均匀铺开
  const minGap = snap.enabled ? Math.max(snap.grid, 1) : 1;
  for (const side of sides) {
    const indices = rebuilt
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.side === side)
      .sort(
        (a, b) =>
          (side === "left" || side === "right"
            ? a.item.points.body.y - b.item.points.body.y
            : a.item.points.body.x - b.item.points.body.x),
      );
    if (indices.length < 2) {
      continue;
    }
    const coordinate = (index: number): number =>
      side === "left" || side === "right"
        ? rebuilt[index].points.body.y
        : rebuilt[index].points.body.x;
    const ordered = indices.map(({ index }) => coordinate(index));
    const overlapping = ordered.some(
      (value, position) => position > 0 && value - ordered[position - 1] < minGap - 1e-6,
    );
    if (!overlapping) {
      continue;
    }
    const low = side === "left" || side === "right" ? body.minY : body.minX;
    const high = side === "left" || side === "right" ? body.maxY : body.maxX;
    const step = (high - low) / (indices.length - 1);
    indices.forEach(({ index }, position) => {
      const value = along(low + step * position);
      const points = rebuilt[index].points;
      rebuilt[index] = {
        side,
        points:
          side === "left" || side === "right"
            ? {
                body: { ...points.body, y: value },
                connection: { ...points.connection, y: value },
              }
            : {
                body: { ...points.body, x: value },
                connection: { ...points.connection, x: value },
              },
      };
    });
  }

  // ③ 生成 entries：锚点按新边重算，只保留真有变化的
  const entries: PinAttachEntry[] = [];
  section.pins.forEach((pin, index) => {
    const next = rebuilt[index].points;
    const anchor = pinLabelAnchors({ ...pin, ...next }, body);
    const geometryChanged =
      !samePoint(next.body, pin.body) || !samePoint(next.connection, pin.connection);
    const anchorChanged =
      !sameOptionalPoint(anchor.name, pin.labelAnchor?.name) ||
      !sameOptionalPoint(anchor.number, pin.labelAnchor?.number);
    if (!geometryChanged && !anchorChanged) {
      return;
    }
    entries.push({
      key: symbolPinKey(sectionIndex, index),
      points: { ...next, labelAnchor: anchor },
    });
  });
  return entries;
};
