import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from "react";
import type { NormalizedSymbol, NormalizedSymbolPin } from "../../shared/schemas";
import {
  dragDelta,
  symbolPinKey,
  symbolShapeKey,
  type RectEdges,
  type SymbolEdits,
  type SymbolShapeBounds,
} from "../../shared/symbol-edit";
import {
  bodyBoxOf,
  estimateLabelWidth,
  pinNameBox,
  pinNumberBox,
  pinSideOf,
  type SymbolBox,
} from "../../shared/symbol-labels";

/**
 * 原理图符号预览（OrCAD Capture 符号坐标系）。
 *
 * **y 轴向下**，与 Capture 符号编辑器一致，所以这里不做任何翻转 ——
 * 预览看到的就是在 Capture 里打开的样子。
 *
 * 编辑模式（`editing=true`）的鼠标语义（用户 2026-10-16 定）：
 *  - **图形/引脚本体**：按住左键拖动 = 移动它；已选中多个时 = **一起移动**所选内容；
 *  - **本体框的线**：按住拖动 = **改本体大小**（抓哪条边改哪条，四角改两条）；
 *    框**内部空白不参与命中**，不会误抓；
 *  - **空白处**：由 PanZoom 接管 —— 拖出橡皮筋框选（图形 + 引脚），点一下取消选中；
 *  - 光标：编辑模式恢复默认箭头，只在框线上按方向显示 resize 光标。
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
/** 拖框线时判定"抓住了哪条边"的容差（屏幕像素，按缩放换算成世界单位）。 */
const EDGE_TOLERANCE_PX = 14;

/** 文字锚点与书写方向 —— 与 shared/symbol-labels.ts 的盒模型一一对应。 */
type LabelPlacement = {
  readonly x: number;
  readonly y: number;
  readonly rotate: number;
  readonly anchor: "start" | "end";
};

const placeLabel = (
  pin: NormalizedSymbolPin,
  box: SymbolBox,
  anchor: { readonly x: number; readonly y: number } | undefined,
): LabelPlacement => {
  switch (pinSideOf(pin)) {
    case "left":
      return { x: anchor?.x ?? box.minX, y: anchor?.y ?? pin.body.y, rotate: 0, anchor: "start" };
    case "right":
      return { x: anchor?.x ?? box.maxX, y: anchor?.y ?? pin.body.y, rotate: 0, anchor: "end" };
    default:
      return { x: anchor?.x ?? pin.body.x, y: anchor?.y ?? box.maxY, rotate: -90, anchor: "start" };
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
  /* 不设 dominant-baseline：默认基线正好落在引脚线上，与 Capture 的画法一致。 */
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

type RectBounds = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

type DragState =
  | {
      readonly mode: "move";
      readonly keys: readonly string[];
      readonly pointerId: number;
      readonly startX: number;
      readonly startY: number;
      lastX: number;
      lastY: number;
      /** 越过死区才算真的在拖（只是点一下 = 选中，不移动） */
      moved: boolean;
    }
  | {
      readonly mode: "resize";
      readonly key: string;
      readonly pointerId: number;
      readonly startX: number;
      readonly startY: number;
      readonly edges: RectEdges;
      readonly origin: RectBounds;
    };

/** 按下后移动不到这么多像素就当"点击选中"，不移动元素。 */
const DRAG_SLOP_PX = 3;

const resizeCursor = (edges: RectEdges): string => {
  const horizontal = edges.left || edges.right;
  const vertical = edges.top || edges.bottom;
  if (horizontal && vertical) {
    return (edges.left && edges.top) || (edges.right && edges.bottom)
      ? "nwse-resize"
      : "nesw-resize";
  }
  return horizontal ? "ew-resize" : "ns-resize";
};

/**
 * 把屏幕坐标换算成符号世界坐标。
 *
 * **必须用元素自己的 getScreenCTM()**（含祖先 `<g>` 的 translate+scale），
 * 用 `ownerSVGElement.getScreenCTM()` 拿到的是 svg 根坐标系（像素），
 * 判边全错 —— 实测拖右边线会被判成拖下边线，宽度纹丝不动。
 */
const worldPoint = (
  event: ReactPointerEvent<SVGElement>,
): { readonly x: number; readonly y: number } | null => {
  const element = event.currentTarget as SVGGraphicsElement;
  const matrix = element.getScreenCTM?.();
  if (matrix == null) {
    return null;
  }
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
};

/** 按容差判断抓住了哪几条边；都没命中就取最近的那条。 */
const edgesAt = (
  point: { readonly x: number; readonly y: number },
  bounds: RectBounds,
  tolerance: number,
): RectEdges => {
  const nearLeft = Math.abs(point.x - bounds.minX) <= tolerance;
  const nearRight = Math.abs(point.x - bounds.maxX) <= tolerance;
  const nearTop = Math.abs(point.y - bounds.minY) <= tolerance;
  const nearBottom = Math.abs(point.y - bounds.maxY) <= tolerance;
  if (nearLeft || nearRight || nearTop || nearBottom) {
    return { left: nearLeft, right: nearRight, top: nearTop, bottom: nearBottom };
  }
  const distances: readonly (readonly [keyof RectEdges, number])[] = [
    ["left", Math.abs(point.x - bounds.minX)],
    ["right", Math.abs(point.x - bounds.maxX)],
    ["top", Math.abs(point.y - bounds.minY)],
    ["bottom", Math.abs(point.y - bounds.maxY)],
  ];
  const nearest = [...distances].sort((a, b) => a[1] - b[1])[0][0];
  return {
    left: nearest === "left",
    right: nearest === "right",
    top: nearest === "top",
    bottom: nearest === "bottom",
  };
};

/**
 * 元素拖动 / 本体改大小 —— 图形与引脚共用一份实现。
 *
 * `scaleRef` 用 ref 而不是普通 prop：676 脚的器件里引脚层是 memo 的，把 scale
 * 当 prop 传会让每级缩放都重渲染整层引脚。
 */
const useElementDrag = (
  editing: boolean,
  scaleRef: RefObject<number>,
  selectedKeys: ReadonlySet<string>,
  onSelectKeys: (keys: readonly string[]) => void,
  onMoveElements: (keys: readonly string[], dx: number, dy: number) => void,
  onResizeRect: (key: string, bounds: SymbolShapeBounds, dragged: RectEdges) => void,
) => {
  const dragRef = useRef<DragState | null>(null);

  /**
   * 兜底：**任何** pointerup / pointercancel / 窗口失焦都要把拖动状态清掉。
   *
   * 只靠元素自己的 onPointerUp 不够 —— 指针捕捉可能已经丢了（元素被重新挂载、
   * 或松手时指针已经移出元素），那样 dragRef 会一直挂着，之后**不按键移动鼠标
   * 也会继续拖元素**（用户 2026-10-19 报的"鼠标移动让文本引脚一起跑"）。
   */
  useEffect(() => {
    const stop = (): void => {
      dragRef.current = null;
    };
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("blur", stop);
    };
  }, []);

  const startMove =
    (key: string) =>
    (event: ReactPointerEvent<SVGElement>): void => {
      if (!editing || event.button !== 0) {
        return;
      }
      // 按在元素上就是"移动元素"，别让 PanZoom 抢去框选
      event.stopPropagation();
      // 已选中的元素 → 整组一起移动；没选中 → 只选它自己（替换选中态）
      const alreadySelected = selectedKeys.has(key);
      const keys = alreadySelected ? [...selectedKeys] : [key];
      if (!alreadySelected) {
        onSelectKeys(keys);
      }
      dragRef.current = {
        mode: "move",
        keys,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };

  const startResize =
    (key: string, bounds: RectBounds) =>
    (event: ReactPointerEvent<SVGElement>): void => {
      if (!editing || event.button !== 0) {
        return;
      }
      event.stopPropagation();
      const point = worldPoint(event);
      const tolerance = EDGE_TOLERANCE_PX / (scaleRef.current > 0 ? scaleRef.current : 1);
      onSelectKeys([key]);
      dragRef.current = {
        mode: "resize",
        key,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        edges: point === null ? { left: false, right: true, top: false, bottom: false } : edgesAt(point, bounds, tolerance),
        origin: bounds,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };

  const move = useCallback(
    (event: ReactPointerEvent<SVGElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      // 左键已经松开了（哪怕没收到 pointerup）→ 立刻停手，绝不跟着鼠标走。
      if (event.buttons === 0) {
        dragRef.current = null;
        return;
      }
      event.stopPropagation();
      const scale = scaleRef.current > 0 ? scaleRef.current : 1;
      if (drag.mode === "move") {
        if (!drag.moved) {
          const travelled =
            Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
          // 死区内的抖动当"点击选中"，不动元素
          if (travelled <= DRAG_SLOP_PX) {
            return;
          }
          drag.moved = true;
        }
        if (event.clientX === drag.lastX && event.clientY === drag.lastY) {
          return;
        }
        const { dx, dy } = dragDelta(event.clientX - drag.lastX, event.clientY - drag.lastY, scale);
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        onMoveElements(drag.keys, dx, dy);
        return;
      }
      // 改大小：用"从按下点起算的绝对位移"算新四边，避免逐帧累加漂移
      const dx = (event.clientX - drag.startX) / scale;
      const dy = (event.clientY - drag.startY) / scale;
      const { origin, edges } = drag;
      onResizeRect(
        drag.key,
        {
          min: {
            x: edges.left ? origin.minX + dx : origin.minX,
            y: edges.top ? origin.minY + dy : origin.minY,
          },
          max: {
            x: edges.right ? origin.maxX + dx : origin.maxX,
            y: edges.bottom ? origin.maxY + dy : origin.maxY,
          },
        },
        edges,
      );
    },
    [onMoveElements, onResizeRect, scaleRef],
  );

  const end = useCallback((event: ReactPointerEvent<SVGElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /**
   * 框线命中区的 onPointerMove：拖动中走 resize，没在拖就按位置切换 resize 光标。
   *
   * **必须挂在这一层** —— startResize 把 pointer capture 设在命中区上，
   * 拖动期间所有 move 都派发给它；漏挂的话拖动事件一个都到不了（实测框改不动）。
   */
  const strokePointerMove = useCallback(
    (key: string, bounds: RectBounds) =>
      (event: ReactPointerEvent<SVGElement>): void => {
        const drag = dragRef.current;
        if (drag !== null && drag.mode === "resize" && drag.pointerId === event.pointerId) {
          move(event);
          return;
        }
        if (event.buttons !== 0) {
          return;
        }
        const point = worldPoint(event);
        if (point === null) {
          return;
        }
        const tolerance = EDGE_TOLERANCE_PX / (scaleRef.current > 0 ? scaleRef.current : 1);
        event.currentTarget.style.cursor = resizeCursor(edgesAt(point, bounds, tolerance));
      },
    [move, scaleRef],
  );

  return { startMove, startResize, move, end, strokePointerMove };
};

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
    selectedKeys,
    scaleRef,
    onSelectKeys,
    onMoveElements,
    onResizeRect,
  }: {
    readonly sectionIndex: number;
    readonly pins: readonly NormalizedSymbolPin[];
    readonly body: SymbolBox;
    readonly showText: boolean;
    readonly editing: boolean;
    readonly selectedKeys: ReadonlySet<string>;
    readonly scaleRef: RefObject<number>;
    readonly onSelectKeys: (keys: readonly string[]) => void;
    readonly onMoveElements: (keys: readonly string[], dx: number, dy: number) => void;
    readonly onResizeRect: (key: string, bounds: SymbolShapeBounds, dragged: RectEdges) => void;
  }): ReactElement => {
    const drag = useElementDrag(
      editing,
      scaleRef,
      selectedKeys,
      onSelectKeys,
      onMoveElements,
      onResizeRect,
    );

    return (
      <>
        {pins.map((pin, pinIndex) => {
          const key = symbolPinKey(sectionIndex, pinIndex);
          const active = selectedKeys.has(key);
          return (
            <g
              /* key 只用"段:脚"这个稳定键。以前把 connection 坐标也拼进 key，
               * 拖动时每帧坐标都变 → React 卸载重建 <g> → **指针捕捉被丢掉** →
               * 松手时收不到 pointerup，dragRef 一直挂着，之后不按键移动鼠标
               * 元素也会跟着跑（用户 2026-10-19 报的正是这个）。 */
              key={key}
              data-draggable={editing ? "true" : undefined}
              onPointerDown={editing ? drag.startMove(key) : undefined}
              onPointerMove={editing ? drag.move : undefined}
              onPointerUp={editing ? drag.end : undefined}
              onPointerCancel={editing ? drag.end : undefined}
              onLostPointerCapture={editing ? drag.end : undefined}
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
                    placement={placeLabel(pin, pinNumberBox(pin, body), pin.labelAnchor?.number)}
                    color={active ? ACTIVE : PIN_NUMBER}
                  />
                  <Label
                    text={pin.name}
                    placement={placeLabel(pin, pinNameBox(pin, body), pin.labelAnchor?.name)}
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
  selectedKeys,
  onSelectKeys,
  onMoveElements,
  onResizeRect,
}: {
  readonly symbol: NormalizedSymbol;
  readonly sectionIndex: number;
  readonly scale: number;
  readonly edits: SymbolEdits;
  /** 编辑模式：按住左键拖动元素 / 拖框线改大小；浏览模式交给 PanZoom */
  readonly editing: boolean;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectKeys: (keys: readonly string[]) => void;
  readonly onMoveElements: (keys: readonly string[], dx: number, dy: number) => void;
  readonly onResizeRect: (key: string, bounds: SymbolShapeBounds, dragged: RectEdges) => void;
}): ReactElement => {
  const section = symbol.sections[Math.min(sectionIndex, symbol.sections.length - 1)];

  // 拖动要除以缩放，但 scale 不能当 prop 传进 memo 的引脚层（见 useElementDrag）
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const drag = useElementDrag(
    editing,
    scaleRef,
    selectedKeys,
    onSelectKeys,
    onMoveElements,
    onResizeRect,
  );

  const moveProps = (key: string): Record<string, unknown> =>
    editing
      ? {
          "data-draggable": "true",
          onPointerDown: drag.startMove(key),
          onPointerMove: drag.move,
          onPointerUp: drag.end,
          onPointerCancel: drag.end,
          onLostPointerCapture: drag.end,
          // 光标恢复默认箭头（用户 2026-10-16 要求）；框线单独用 resize 光标
          style: { cursor: "default" },
        }
      : {};

  const showPinText = scale >= PIN_TEXT_MIN_SCALE;
  const body = bodyBoxOf(section);

  return (
    <g className="symbol-preview">
      {section.shapes.map((shape, shapeIndex) => {
        const key = symbolShapeKey(sectionIndex, shapeIndex);
        const active = selectedKeys.has(key);
        const edit = edits[key];
        const offset = edit?.offset;
        const translate =
          offset !== undefined && (offset.dx !== 0 || offset.dy !== 0)
            ? `translate(${offset.dx} ${offset.dy})`
            : undefined;
        const stroke = active ? ACTIVE : EDGE;
        if (shape.kind === "rect") {
          // 本体四边：编辑记录里的 bounds 优先（框线拖动改过大小）
          const stored = edit?.bounds;
          const minX = Math.min(stored?.min.x ?? shape.min.x, stored?.max.x ?? shape.max.x);
          const minY = Math.min(stored?.min.y ?? shape.min.y, stored?.max.y ?? shape.max.y);
          const width = Math.abs((stored?.max.x ?? shape.max.x) - (stored?.min.x ?? shape.min.x));
          const height = Math.abs((stored?.max.y ?? shape.max.y) - (stored?.min.y ?? shape.min.y));
          const bounds: RectBounds = { minX, minY, maxX: minX + width, maxY: minY + height };
          return (
            <g key={key} transform={translate} {...moveProps(key)}>
              <rect
                x={minX}
                y={minY}
                width={width}
                height={height}
                rx={shape.cornerRadius}
                fill={shape.filled ? BODY_FILL : "none"}
                stroke={stroke}
                strokeWidth={active ? 3 : 2}
                vectorEffect="non-scaling-stroke"
              />
              {editing ? (
                /* 命中区只覆盖**框线**：框内部空白不参与命中，免得把里面元素的点击全吃掉
                 * （用户 2026-10-16 要求）；抓住框线拖动 = 改本体大小。 */
                <rect
                  data-hit="stroke"
                  x={minX}
                  y={minY}
                  width={width}
                  height={height}
                  rx={shape.cornerRadius}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={9}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={drag.startResize(key, bounds)}
                  onPointerMove={drag.strokePointerMove(key, bounds)}
                  onPointerUp={drag.end}
                  onPointerCancel={drag.end}
                  onLostPointerCapture={drag.end}
                />
              ) : null}
            </g>
          );
        }
        if (shape.kind === "polyline") {
          const points = shape.points.map((point) => `${point.x},${point.y}`).join(" ");
          const closed = shape.closed
            ? `${points} ${shape.points[0].x},${shape.points[0].y}`
            : points;
          return (
            <g key={key} transform={translate} {...moveProps(key)}>
              <polyline
                points={closed}
                fill="none"
                stroke={stroke}
                strokeWidth={active ? 3 : 2}
                vectorEffect="non-scaling-stroke"
              />
              {editing ? (
                <polyline
                  points={closed}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={9}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </g>
          );
        }
        /* 文字（CommentText）：glyph 本身的命中区太窄，垫一个透明矩形把整块文字都变成
         * 可点区域，这样"想再拖同一个标签"就不会抓到别的东西。宽度按模型估算再放
         * 35% + 12 单位余量 —— 预览用的是源字号，实际渲染比模型略宽。 */
        const hitWidth = estimateLabelWidth(shape.text) * (shape.height / PIN_FONT) * 1.35 + 12;
        const hitHeight = shape.height * 1.4 + 6;
        return (
          <g key={key} transform={translate} {...moveProps(key)}>
            <g
              transform={
                shape.rotation === 0
                  ? undefined
                  : `rotate(${-shape.rotation} ${shape.at.x} ${shape.at.y})`
              }
            >
              {editing ? (
                <rect
                  x={shape.at.x - 4}
                  y={shape.at.y - shape.height}
                  width={hitWidth}
                  height={hitHeight}
                  fill="transparent"
                />
              ) : null}
              <text
                x={shape.at.x}
                y={shape.at.y}
                fontSize={shape.height}
                fill={active ? ACTIVE : TEXT}
              >
                {shape.text}
              </text>
            </g>
          </g>
        );
      })}

      <SymbolPins
        sectionIndex={sectionIndex}
        pins={section.pins}
        body={body}
        showText={showPinText}
        editing={editing}
        selectedKeys={selectedKeys}
        scaleRef={scaleRef}
        onSelectKeys={onSelectKeys}
        onMoveElements={onMoveElements}
        onResizeRect={onResizeRect}
      />
    </g>
  );
};
