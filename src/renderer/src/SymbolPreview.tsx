import { memo, useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import type { NormalizedSymbol, NormalizedSymbolPin } from "../../shared/schemas";
import {
  symbolPinKey,
  symbolShapeKey,
  type SymbolEdits,
} from "../../shared/symbol-edit";
import {
  bodyBoxOf,
  pinNameBox,
  pinNumberBox,
  pinSideOf,
  type SymbolBox,
} from "../../shared/symbol-labels";

/**
 * 原理图符号预览（OrCAD Capture 符号坐标系）。
 *
 * **y 轴向下**，与 Capture 符号编辑器一致（实测：源数据左侧引脚按 y 升序与实机
 * 截图的从上到下顺序完全相同），所以这里不做任何翻转 —— 预览看到的就是
 * 在 Capture 里打开的样子。
 *
 * 两种模式（用户 2026-10-16 要求二者互斥）：
 *  - 浏览（`editing=false`）：PanZoom 接管，滚轮缩放 / 拖动平移；
 *  - 编辑（`editing=true`）：PanZoom 让位，点选元素后拖动移动，键盘微调。
 */

const EDGE = "#2458d3";
const ACTIVE = "#e0862c";
const BODY_FILL = "#f2f6ff";
const PIN = "#4a5561";
const PIN_NAME = "#1f2937";
const PIN_NUMBER = "#8a94a0";
const TEXT = "#1d49b7";

/** 缩得太小时不画引脚文字：676 脚的器件在 5% 缩放下文字只会糊成一片。 */
const PIN_TEXT_MIN_SCALE = 0.12;
/** 世界单位下的字号。Capture 的引脚名/号同为 height≈9，这里照抄以便预览比例一致。 */
const PIN_FONT = 9;

/** 文字锚点与书写方向 —— 与 shared/symbol-labels.ts 的盒模型一一对应。 */
type LabelPlacement = {
  readonly x: number;
  readonly y: number;
  readonly rotate: number;
  readonly anchor: "start" | "end";
};

const placeLabel = (pin: NormalizedSymbolPin, box: SymbolBox): LabelPlacement => {
  switch (pinSideOf(pin)) {
    case "left":
      return { x: box.minX, y: pin.body.y, rotate: 0, anchor: "start" };
    case "right":
      return { x: box.maxX, y: pin.body.y, rotate: 0, anchor: "end" };
    default:
      return { x: pin.body.x, y: box.maxY, rotate: -90, anchor: "start" };
  }
};

const Label = ({
  text,
  placement,
  color,
}: {
  readonly text: string;
  readonly placement: LabelPlacement;
  readonly color: string;
}): ReactElement => (
  /* 不设 dominant-baseline：默认基线正好落在引脚线上，与 Capture 的画法一致
   * （实测 Capture 把引脚号/名的基线放在引脚线上，文字整体偏上；之前用 middle
   * 居中反而和 Capture 对不上 —— 用户 2026-10-16 指出）。 */
  <text
    x={placement.x}
    y={placement.y}
    fontSize={PIN_FONT}
    fill={color}
    textAnchor={placement.anchor}
    transform={
      placement.rotate === 0
        ? undefined
        : `rotate(${placement.rotate} ${placement.x} ${placement.y})`
    }
  >
    {text}
  </text>
);

/**
 * 引脚层单独 memo：手工调整只改图形元素，引脚数组引用不变（applySymbolEdits
 * 只重建被编辑的段），所以拖动时这一层能跳过大部分重渲染。
 */
const SymbolPins = memo(
  ({
    sectionIndex,
    pins,
    body,
    showText,
    editing,
    selectedKey,
    onSelect,
    onMove,
  }: {
    readonly sectionIndex: number;
    readonly pins: readonly NormalizedSymbolPin[];
    readonly body: SymbolBox;
    readonly showText: boolean;
    readonly editing: boolean;
    readonly selectedKey: string | null;
    readonly onSelect: (key: string | null) => void;
    readonly onMove: (key: string, dx: number, dy: number) => void;
  }): ReactElement => {
    const dragRef = useRef<{
      readonly key: string;
      readonly pointerId: number;
      lastX: number;
      lastY: number;
    } | null>(null);

    const startDrag =
      (key: string) =>
      (event: ReactPointerEvent<SVGGElement>): void => {
        if (!editing || event.button !== 0) {
          return;
        }
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
    const moveDrag = (event: ReactPointerEvent<SVGGElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      event.stopPropagation();
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      if (dx === 0 && dy === 0) {
        return;
      }
      dragRef.current = { ...drag, lastX: event.clientX, lastY: event.clientY };
      onMove(drag.key, dx, dy);
    };
    const endDrag = (event: ReactPointerEvent<SVGGElement>): void => {
      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }
    };

    return (
      <>
        {pins.map((pin, pinIndex) => {
          const key = symbolPinKey(sectionIndex, pinIndex);
          const active = selectedKey === key;
          return (
            <g
              key={`${key}-${pin.number}-${pin.connection.x}-${pin.connection.y}`}
              data-draggable={editing ? "true" : undefined}
              onPointerDown={editing ? startDrag(key) : undefined}
              onPointerMove={editing ? moveDrag : undefined}
              onPointerUp={editing ? endDrag : undefined}
              onPointerCancel={editing ? endDrag : undefined}
              style={editing ? { cursor: "move", pointerEvents: "all" } : undefined}
            >
              <line
                x1={pin.connection.x}
                y1={pin.connection.y}
                x2={pin.body.x}
                y2={pin.body.y}
                stroke={active ? ACTIVE : PIN}
                strokeWidth={active ? 3 : 2}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={pin.connection.x}
                cy={pin.connection.y}
                r={active ? 2.6 : 1.6}
                fill={active ? ACTIVE : PIN}
              />
              {showText ? (
                <>
                  <Label
                    text={pin.number}
                    placement={placeLabel(pin, pinNumberBox(pin, body))}
                    color={active ? ACTIVE : PIN_NUMBER}
                  />
                  <Label
                    text={pin.name}
                    placement={placeLabel(pin, pinNameBox(pin, body))}
                    color={active ? ACTIVE : PIN_NAME}
                  />
                </>
              ) : null}
              {/* 命中区：引脚线太细不好点，垫一条透明的粗线 */}
              {editing ? (
                <line
                  x1={pin.connection.x}
                  y1={pin.connection.y}
                  x2={pin.body.x}
                  y2={pin.body.y}
                  stroke="transparent"
                  strokeWidth={10}
                />
              ) : null}
            </g>
          );
        })}
      </>
    );
  },
);
SymbolPins.displayName = "SymbolPins";

export const SymbolPreview = ({
  symbol,
  sectionIndex,
  scale,
  edits,
  editing,
  selectedKey,
  onSelect,
  onMoveElement,
}: {
  readonly symbol: NormalizedSymbol;
  readonly sectionIndex: number;
  readonly scale: number;
  readonly edits: SymbolEdits;
  /** 编辑模式：元素可点选/拖动；浏览模式交给 PanZoom */
  readonly editing: boolean;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
  readonly onMoveElement: (key: string, dx: number, dy: number) => void;
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
      if (!editing || event.button !== 0) {
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
    onMoveElement(drag.key, dx, dy);
  };

  const endDrag = (event: ReactPointerEvent<SVGElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const dragProps = (key: string): Record<string, unknown> =>
    editing
      ? {
          "data-draggable": "true",
          onPointerDown: startDrag(key),
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          // pointer-events: all —— 本体框是 fill="none"，SVG 默认只命中"画出来的部分"，
          // 不加这个框内部点不中（实测 headless Chrome 里点上去落到了画布底板上）。
          style: { cursor: "move", pointerEvents: "all" },
        }
      : {};

  const showPinText = scale >= PIN_TEXT_MIN_SCALE;
  const body = bodyBoxOf(section);

  return (
    <g className="symbol-preview">
      {section.shapes.map((shape, shapeIndex) => {
        const key = symbolShapeKey(sectionIndex, shapeIndex);
        const active = selectedKey === key;
        const offset = edits[key];
        const moved = offset?.kind === "offset";
        const translate =
          moved && (offset.dx !== 0 || offset.dy !== 0)
            ? `translate(${offset.dx} ${offset.dy})`
            : undefined;
        const stroke = active ? ACTIVE : EDGE;
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
                strokeWidth={active ? 3 : 2}
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
                strokeWidth={active ? 3 : 2}
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
              fill={active ? ACTIVE : TEXT}
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

      <SymbolPins
        sectionIndex={sectionIndex}
        pins={section.pins}
        body={body}
        showText={showPinText}
        editing={editing}
        selectedKey={selectedKey}
        onSelect={onSelect}
        onMove={onMoveElement}
      />
    </g>
  );
};
