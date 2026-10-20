import type { RectEdges, SymbolShapeBounds } from "./symbol-edit";

/**
 * 符号编辑的网格 / 吸附内核（纯函数，无 DOM、无 React）。
 *
 * 用户 2026-10-20 定：只保留两档 —— **100 mil（10 单位，默认）与 50 mil（5 单位）**。
 * 背景网格、拖动吸附、方向键步长、rect 边吸附全部读同一份档位，避免"网格看着是 50、
 * 实际按 100 跳"这类不一致。
 */

/** 符号坐标里 1 单位 = 10 mil，所以 10 单位 = 100 mil、5 单位 = 50 mil。 */
export type SnapGrid = 5 | 10;

export const SNAP_GRIDS: readonly { readonly value: SnapGrid; readonly mil: 50 | 100 }[] = [
  { value: 10, mil: 100 },
  { value: 5, mil: 50 },
];

export const DEFAULT_SNAP_GRID: SnapGrid = 10;

/** 吸附开关 + 档位。拖动开始时冻结进 DragState，中途改档不会让当前拖动抖一下。 */
export type SnapState = {
  readonly enabled: boolean;
  readonly grid: number;
};

/** 网格间距（世界单位）→ 显示用 mil。 */
export const gridMil = (grid: number): number => Math.round(grid * 10);

/** 取整到最近的格点（半格向上）。 */
export const snapValue = (value: number, grid: number): number => {
  if (!(grid > 0)) {
    return value;
  }
  return Math.round(value / grid) * grid;
};

export const isOnGrid = (value: number, grid: number, epsilon = 1e-6): boolean =>
  grid > 0 && Math.abs(value - snapValue(value, grid)) <= epsilon;

/**
 * 一帧拖动位移的量化。
 *
 * `raw` 是**未量化**的累计位移（从按下点算起），`applied` 是已经下发给编辑层的累计位移。
 * 对 raw 取整再减去 applied —— 这样低档位下慢慢拖也不会因为逐帧取整而丢余量
 * （曾出现"拖 37px 只走 30px、剩下的 7px 永远补不回来"的问题）。
 */
export const snapDragDelta = (
  raw: { readonly dx: number; readonly dy: number },
  applied: { readonly dx: number; readonly dy: number },
  snap: SnapState,
): { readonly dx: number; readonly dy: number; readonly appliedX: number; readonly appliedY: number } => {
  const targetX = snap.enabled ? snapValue(raw.dx, snap.grid) : raw.dx;
  const targetY = snap.enabled ? snapValue(raw.dy, snap.grid) : raw.dy;
  return {
    dx: targetX - applied.dx,
    dy: targetY - applied.dy,
    appliedX: targetX,
    appliedY: targetY,
  };
};

/**
 * 本体改大小的吸附：只量化**被拖的边**的绝对坐标。
 *
 * 用绝对值而不是位移：拖到哪条格线就停在哪条格线，OrCAD 手感。首帧最多跳半格，
 * 未拖的边永远保持 origin 的值（否则框会自己长到另一边去）。
 */
export const snapRectBounds = (
  bounds: SymbolShapeBounds,
  dragged: RectEdges,
  grid: number,
): SymbolShapeBounds => {
  const minX = Math.min(bounds.min.x, bounds.max.x);
  const minY = Math.min(bounds.min.y, bounds.max.y);
  const maxX = Math.max(bounds.min.x, bounds.max.x);
  const maxY = Math.max(bounds.min.y, bounds.max.y);
  return {
    min: {
      x: dragged.left ? snapValue(minX, grid) : minX,
      y: dragged.top ? snapValue(minY, grid) : minY,
    },
    max: {
      x: dragged.right ? snapValue(maxX, grid) : maxX,
      y: dragged.bottom ? snapValue(maxY, grid) : maxY,
    },
  };
};

/**
 * 方向键步长（世界单位）。
 *
 * 吸附开：默认一格（档位）；Shift = 1 单位精调；Alt = 10 格粗调。
 * 吸附关：1 / 1 / 10 —— 与"自由拖动"的手感一致，最小值仍是 1（写库要求整数）。
 *
 * 保持**增量**而不是绝对落格：多选元素各自的原始余数不同（源库 145/155 半格），
 * 绝对落格会把它们挤到同一条线上、破坏相对间距。
 */
export const arrowStep = (
  snap: SnapState,
  modifiers: { readonly shift: boolean; readonly alt: boolean },
): number => {
  if (!snap.enabled) {
    return modifiers.alt ? 10 : 1;
  }
  if (modifiers.shift) {
    return 1;
  }
  return modifiers.alt ? snap.grid * 10 : snap.grid;
};

// ---------- 画布视口 / 包围盒 ----------

export type WorldBox = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

export type CanvasView = {
  readonly tx: number;
  readonly ty: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
};

/**
 * 视口覆盖的世界矩形（网格铺满可视区、缩放到选中都靠它）。
 * 屏幕点 px 对应的世界坐标 = (px - tx) / scale。
 */
export const worldRectOf = (view: CanvasView): WorldBox => {
  const scale = view.scale > 0 ? view.scale : 1;
  return {
    minX: -view.tx / scale,
    minY: -view.ty / scale,
    maxX: (view.width - view.tx) / scale,
    maxY: (view.height - view.ty) / scale,
  };
};

export const expandBox = (box: WorldBox, pad: number): WorldBox => ({
  minX: box.minX - pad,
  minY: box.minY - pad,
  maxX: box.maxX + pad,
  maxY: box.maxY + pad,
});

export const unionBoxes = (boxes: readonly WorldBox[]): WorldBox | null => {
  if (boxes.length === 0) {
    return null;
  }
  return boxes.reduce<WorldBox>(
    (acc, box) => ({
      minX: Math.min(acc.minX, box.minX),
      minY: Math.min(acc.minY, box.minY),
      maxX: Math.max(acc.maxX, box.maxX),
      maxY: Math.max(acc.maxY, box.maxY),
    }),
    boxes[0],
  );
};

/**
 * "缩放到某个包围盒"的纯数学部分（PanZoom 只负责把结果写进 state）。
 *
 * 与 PanZoom 的 fit 完全同构：取宽高比更小的那个缩放、乘 FIT_PADDING、居中。
 * 单独提出来是为了能在 node 环境直接单测，不依赖 ResizeObserver。
 */
export const fitBoxToView = (
  box: WorldBox,
  size: { readonly width: number; readonly height: number },
  padding: number,
  limits: { readonly min: number; readonly max: number } = { min: 0.02, max: 80 },
): { readonly scale: number; readonly tx: number; readonly ty: number } => {
  const width = Math.max(box.maxX - box.minX, 1e-6);
  const height = Math.max(box.maxY - box.minY, 1e-6);
  const raw = Math.min(size.width / width, size.height / height) * padding;
  const scale = Math.min(Math.max(raw, limits.min), limits.max);
  return {
    scale,
    tx: size.width / 2 - ((box.minX + box.maxX) / 2) * scale,
    ty: size.height / 2 - ((box.minY + box.maxY) / 2) * scale,
  };
};
