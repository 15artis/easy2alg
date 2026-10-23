import { useId, type ReactElement } from "react";
import { worldRectOf, type CanvasView } from "../../shared/symbol-snap";

/**
 * 原理图符号画布的**世界坐标网格**（用户 2026-10-20）。
 *
 * 与 `.engineering-canvas` 的 CSS 渐变网格不同：那层是屏幕像素、缩放后与符号坐标
 * 完全脱节（看着有格、其实对不上）。这里的格子铺在 PanZoom 的世界 `<g>` 里，
 * 间距 = 当前档位（10 单位 = 100 mil / 5 单位 = 50 mil），滚轮缩放时贴住符号原点。
 *
 * 两级网格：细格 = 档位本身；粗格 = 档位 × 10（1000 mil / 500 mil），方便读数。
 * 线宽用 `1 / scale` 补偿，屏幕上线宽恒定 1px。
 */

const MINOR_COLOR = "#d3ddeb";
const MAJOR_COLOR = "#b3c2d4";
/** 屏幕像素：格子小于它就不画（5 单位档在 2% 缩放下会密到卡死浏览器）。 */
const MIN_GRID_PX = 3;

export const SymbolGrid = ({
  view,
  grid,
  visible,
}: {
  readonly view: CanvasView;
  /** 世界单位：10 = 100 mil，5 = 50 mil */
  readonly grid: number;
  readonly visible: boolean;
}): ReactElement | null => {
  // useId 产物形如 ":r1:"，在 url(#id) 与测试选择器里都不安全，先清洗
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!visible || !(grid > 0)) {
    return null;
  }
  const scale = view.scale > 0 ? view.scale : 1;
  const minorPx = grid * scale;
  const majorPx = minorPx * 10;
  const showMinor = minorPx >= MIN_GRID_PX;
  const showMajor = majorPx >= MIN_GRID_PX;
  if (!showMinor && !showMajor) {
    return null;
  }

  const world = worldRectOf(view);
  const stroke = 1 / scale;
  const minorId = `grid-minor-${uid}`;
  const majorId = `grid-major-${uid}`;

  return (
    <g className="symbol-grid" aria-hidden="true" pointerEvents="none">
      <defs>
        {showMinor ? (
          <pattern id={minorId} patternUnits="userSpaceOnUse" width={grid} height={grid}>
            <path
              d={`M ${grid} 0 L 0 0 0 ${grid}`}
              fill="none"
              stroke={MINOR_COLOR}
              strokeWidth={stroke}
            />
          </pattern>
        ) : null}
        {showMajor ? (
          <pattern id={majorId} patternUnits="userSpaceOnUse" width={grid * 10} height={grid * 10}>
            {showMinor ? <rect width={grid * 10} height={grid * 10} fill={`url(#${minorId})`} /> : null}
            <path
              d={`M ${grid * 10} 0 L 0 0 0 ${grid * 10}`}
              fill="none"
              stroke={MAJOR_COLOR}
              strokeWidth={stroke}
            />
          </pattern>
        ) : null}
      </defs>
      <rect
        data-testid="symbol-grid"
        x={world.minX}
        y={world.minY}
        width={world.maxX - world.minX}
        height={world.maxY - world.minY}
        fill={showMajor ? `url(#${majorId})` : `url(#${minorId})`}
      />
    </g>
  );
};
