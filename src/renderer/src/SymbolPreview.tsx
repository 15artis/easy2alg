import { memo, useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import type { NormalizedSymbol, NormalizedSymbolPin, Point } from "../../shared/schemas";
import { symbolShapeKey, type SymbolEdits } from "../../shared/symbol-edit";

/**
 * 原理图符号预览（OrCAD Capture 符号坐标系）。
 *
 * **y 轴向下**，与 Capture 符号编辑器一致（实测：源数据左侧引脚按 y 升序与实机
 * 截图的从上到下顺序完全相同），所以这里不做任何翻转 —— 预览看到的就是
 * 在 Capture 里打开的样子。
 *
 * 带 `data-draggable` 的图形元素可以在预览里直接拖动（见 shared/symbol-edit.ts），
 * 拖动增量按当前缩放折回世界单位。
 */

const EDGE = "#2458d3";
const BODY_FILL = "#f2f6ff";
const PIN = "#4a5561";
const PIN_NAME = "#1f2937";
const PIN_NUMBER = "#8a94a0";
const TEXT = "#1d49b7";

/** 缩得太小时不画引脚文字：676 脚的器件在 5% 缩放下文字只会糊成一片。 */
const PIN_TEXT_MIN_SCALE = 0.12;
const PIN_FONT = 8;
const PIN_NUMBER_FONT = 6;

const pinIsVertical = (pin: NormalizedSymbolPin): boolean =>
  Math.abs(pin.connection.x - pin.body.x) < 1e-9;

const arrow = (dx: number, dy: number): Point => ({
  x: Math.abs(dx) < 1e-9 ? 0 : Math.sign(dx),
  y: Math.abs(dy) < 1e-9 ? 0 : Math.sign(dy),
});

/**
 * 引脚层单独 memo：手工调整只改图形元素，引脚数组引用不变（applySymbolEdits
 * 只重建 shapes），所以拖动时这一层完全跳过重渲染 —— 676 脚器件不做这层隔离
 * 会在每次 pointermove 重建两千个 SVG 节点。
 */
const SymbolPins = memo(
  ({
    pins,
    showText,
  }: {
    readonly pins: readonly NormalizedSymbolPin[];
    readonly showText: boolean;
  }): ReactElement => (
    <>
      {pins.map((pin) => {
        const vertical = pinIsVertical(pin);
        const dir = arrow(pin.body.x - pin.connection.x, pin.body.y - pin.connection.y);
        const gap = 5;
        const numberOutside = { x: pin.body.x - dir.x * gap, y: pin.body.y - dir.y * gap };
        const nameInside = { x: pin.body.x + dir.x * gap, y: pin.body.y + dir.y * gap };
        const anchorNumber = vertical ? (dir.y > 0 ? "end" : "start") : dir.x > 0 ? "end" : "start";
        const anchorName = vertical ? (dir.y > 0 ? "start" : "end") : dir.x > 0 ? "start" : "end";
        return (
          <g key={`pin-${pin.number}-${pin.connection.x}-${pin.connection.y}`}>
            <line
              x1={pin.connection.x}
              y1={pin.connection.y}
              x2={pin.body.x}
              y2={pin.body.y}
              stroke={PIN}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={pin.connection.x} cy={pin.connection.y} r={1.6} fill={PIN} />
            {showText ? (
              <>
                <text
                  x={numberOutside.x}
                  y={numberOutside.y + PIN_NUMBER_FONT * 0.35}
                  fontSize={PIN_NUMBER_FONT}
                  fill={PIN_NUMBER}
                  textAnchor={anchorNumber}
                  transform={
                    vertical ? `rotate(-90 ${numberOutside.x} ${numberOutside.y})` : undefined
                  }
                >
                  {pin.number}
                </text>
                <text
                  x={nameInside.x}
                  y={nameInside.y + PIN_FONT * 0.35}
                  fontSize={PIN_FONT}
                  fill={PIN_NAME}
                  textAnchor={anchorName}
                  transform={vertical ? `rotate(-90 ${nameInside.x} ${nameInside.y})` : undefined}
                >
                  {pin.name}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
    </>
  ),
);
SymbolPins.displayName = "SymbolPins";

export const SymbolPreview = ({
  symbol,
  sectionIndex,
  scale,
  edits,
  selectedKey,
  onSelect,
  onMoveShape,
}: {
  readonly symbol: NormalizedSymbol;
  readonly sectionIndex: number;
  readonly scale: number;
  readonly edits: SymbolEdits;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
  readonly onMoveShape: (key: string, dx: number, dy: number) => void;
}): ReactElement => {
  const section = symbol.sections[Math.min(sectionIndex, symbol.sections.length - 1)];
  const dragRef = useRef<{
    readonly key: string;
    readonly pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);

  const startDrag =
    (key: string) =>
    (event: ReactPointerEvent<SVGElement>): void => {
      if (event.button !== 0) {
        return;
      }
      // 阻止 PanZoom 把这次按下当成平移
      event.stopPropagation();
      onSelect(key);
      dragRef.current = {
        key,
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };

  const moveDrag = (event: ReactPointerEvent<SVGElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    event.stopPropagation();
    const dx = (event.clientX - drag.lastX) / scale;
    const dy = (event.clientY - drag.lastY) / scale;
    if (dx === 0 && dy === 0) {
      return;
    }
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    onMoveShape(drag.key, dx, dy);
  };

  const endDrag = (event: ReactPointerEvent<SVGElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const dragProps = (key: string): Record<string, unknown> => ({
    "data-draggable": "true",
    onPointerDown: startDrag(key),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    style: { cursor: "move" },
  });

  const showPinText = scale >= PIN_TEXT_MIN_SCALE;

  return (
    <g className="symbol-preview">
      {section.shapes.map((shape, shapeIndex) => {
        const key = symbolShapeKey(sectionIndex, shapeIndex);
        const active = selectedKey === key;
        const offset = edits[key];
        const moved = offset !== undefined;
        const translate =
          moved && (offset.dx !== 0 || offset.dy !== 0)
            ? `translate(${offset.dx} ${offset.dy})`
            : undefined;
        const stroke = active ? "#e0862c" : EDGE;
        if (shape.kind === "rect") {
          const x = Math.min(shape.min.x, shape.max.x);
          const y = Math.min(shape.min.y, shape.max.y);
          return (
            <g key={key} transform={translate} {...dragProps(key)}>
              <rect
                x={x}
                y={y}
                width={Math.abs(shape.max.x - shape.min.x)}
                height={Math.abs(shape.max.y - shape.min.y)}
                rx={shape.cornerRadius}
                fill={shape.filled ? BODY_FILL : "none"}
                stroke={stroke}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        }
        if (shape.kind === "polyline") {
          const points = shape.points.map((point) => `${point.x},${point.y}`).join(" ");
          return (
            <g key={key} transform={translate} {...dragProps(key)}>
              <polyline
                points={shape.closed ? `${points} ${shape.points[0].x},${shape.points[0].y}` : points}
                fill="none"
                stroke={stroke}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        }
        return (
          <g key={key} transform={translate} {...dragProps(key)}>
            <text
              x={shape.at.x}
              y={shape.at.y}
              fontSize={shape.height}
              fill={active ? "#e0862c" : TEXT}
              transform={
                shape.rotation === 0
                  ? undefined
                  : `rotate(${-shape.rotation} ${shape.at.x} ${shape.at.y})`
              }
            >
              {shape.text}
            </text>
          </g>
        );
      })}

      <SymbolPins pins={section.pins} showText={showPinText} />
    </g>
  );
};
