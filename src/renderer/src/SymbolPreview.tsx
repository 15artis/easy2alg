import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from "react";
import type { NormalizedSymbol, NormalizedSymbolPin } from "../../shared/schemas";
import {
  dragDelta,
  isSymbolPinKey,
  parseSymbolEditKey,
  parseSymbolPinLabelKey,
  symbolPinKey,
  symbolPinLabelKey,
  symbolShapeKey,
  type SymbolPinPoints,
  type RectEdges,
  type SymbolEdits,
  type SymbolShapeBounds,
} from "../../shared/symbol-edit";
import { SYMBOL_PIN_GRID } from "../../shared/symbol-layout";
import { reorientPin, type DragBias } from "../../shared/symbol-pin";
import {
  snapDragDelta,
  snapRectBounds,
  type SnapState,
} from "../../shared/symbol-snap";
import type { SelectionMode } from "./selection";
import {
  bodyBoxOf,
  estimateLabelWidth,
  estimateMultilineWidth,
  pinLabelBoxOf,
  pinLabelPlacement,
  pinLabelVisible,
  pinLabelWidth,
  pinNamesSuppressed,
  pinSideOf,
  symbolFontHeight,
  symbolTextLines,
  SYMBOL_TEXT_LINE_STEP,
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

const Label = ({
  text,
  placement,
  color,
  onDoubleClick,
}: {
  readonly text: string;
  readonly placement: LabelPlacement;
  readonly color: string;
  readonly onDoubleClick?: () => void;
}): ReactElement => (
  /* 不设 dominant-baseline：默认基线正好落在引脚线上，与 Capture 的画法一致。
   * textLength 把字宽钉死成盒模型用的等宽值 —— 浏览器字体比 Capture 的 stroke
   * 字体宽，不钉的话 "MH1" 会向左伸出去压住隔壁引脚的 name。 */
  <text
    x={placement.x}
    y={placement.y}
    fontSize={PIN_FONT}
    fill={color}
    textAnchor={placement.anchor}
    textLength={pinLabelWidth(text)}
    lengthAdjust="spacingAndGlyphs"
    transform={
      placement.rotate === 0
        ? undefined
        : `rotate(${placement.rotate} ${placement.x} ${placement.y})`
    }
    onDoubleClick={onDoubleClick}
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
      /** 累计位移（世界单位，未吸附） */
      rawX: number;
      rawY: number;
      /** 已经下发给 onMoveElements 的累计位移（吸附后） */
      appliedX: number;
      appliedY: number;
      /** 按下瞬间冻结的吸附设置：中途改档位不会让当前拖动抖一下 */
      readonly snap: SnapState;
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
      readonly snap: SnapState;
    };

/** 按下后移动不到这么多像素就当"点击选中"，不移动元素。 */
const DRAG_SLOP_PX = 3;

/**
 * 双击识别（用户 2026-10-22）。**不能依赖浏览器的 dblclick**：
 * 按下元素时我们调了 `setPointerCapture`，Chromium 会把随后的 click/dblclick
 * 重定向到捕捉元素，子节点（`<text>` 标签）上的 onDoubleClick 永远收不到。
 * 所以自己在 pointerdown 层按"同元素 + 时间窗 + 位移容差"判双击。
 *
 * 时间窗 600ms / 位移 16px（用户 2026-11-09 报"双击文本无法编辑了"）：
 * 原来的 400ms / 8px 比 Windows 默认的双击速度（500ms）还紧 —— 手稍慢一点就判不上，
 * 而这条路径是文本编辑唯一可靠的入口，于是双击彻底没反应。
 * 位移同时放宽到 16px：符号缩到 30% 时一个汉字只有十几像素，8px 的手抖就等于整个字。
 */
const DOUBLE_TAP_MS = 600;
const DOUBLE_TAP_SLOP_PX = 16;

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
 * 把焦点放到行内编辑器上 —— 双击文本 / 引脚标签共用。
 *
 * **不能只 focus 一次**（用户 2026-11-09 报"双击文本无法编辑"）：双击是在
 * pointerdown 层识别的，input 插入 DOM 之后浏览器才做这次按下的默认焦点处理，
 * 目标 `<text>` 不可聚焦 → 焦点被丢给 body，同步的 focus() 随即被覆盖，
 * 表现就是输入框画出来了、却一个字都打不进去。
 *
 * 三重保险：立即 focus → 下一拍 setTimeout（覆盖默认动作）→ 本次 pointerup
 * （按下与抬起位置不同时，默认焦点处理会晚到 pointerup 之后）。
 */
const useInlineEditorFocus = (
  open: boolean,
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
): void => {
  useEffect(() => {
    if (!open) {
      return;
    }
    const input = inputRef.current;
    if (input === null) {
      return;
    }
    const focus = (): void => {
      if (input.isConnected) {
        input.focus();
      }
    };
    focus();
    const timer = window.setTimeout(focus, 0);
    window.addEventListener("pointerup", focus, { once: true, capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerup", focus, true);
    };
  }, [open, inputRef]);
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
  onSelectKeys: (keys: readonly string[], mode?: SelectionMode) => void,
  onMoveElements: (keys: readonly string[], dx: number, dy: number) => void,
  onResizeRect: (key: string, bounds: SymbolShapeBounds, dragged: RectEdges) => void,
  snap: SnapState,
  onMoveEnd?: (keys: readonly string[], delta: { readonly dx: number; readonly dy: number }) => void,
  /**
   * 双击（pointerdown 层识别）。返回 true = 已被消费（打开行内编辑器），
   * false = 这个元素没有可编辑内容，按普通点击继续走选中/拖动。
   */
  onDoubleTap?: (
    key: string,
    point: { readonly x: number; readonly y: number } | null,
  ) => boolean,
) => {
  const dragRef = useRef<DragState | null>(null);
  /** 松手回调（引脚换边重定向）走 ref：capture 监听只挂一次，不能因回调换引用重装。 */
  const onMoveEndRef = useRef(onMoveEnd);
  onMoveEndRef.current = onMoveEnd;
  const onDoubleTapRef = useRef(onDoubleTap);
  onDoubleTapRef.current = onDoubleTap;
  /** 上一次按下的元素与位置（判双击用） */
  const lastTapRef = useRef<{
    readonly key: string;
    readonly time: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);

  /**
   * 兜底：**任何** pointerup / pointercancel / 窗口失焦都要把拖动状态清掉。
   *
   * 只靠元素自己的 onPointerUp 不够 —— 指针捕捉可能已经丢了（元素被重新挂载、
   * 或松手时指针已经移出元素），那样 dragRef 会一直挂着，之后**不按键移动鼠标
   * 也会继续拖元素**（用户 2026-10-19 报的"鼠标移动让文本引脚一起跑"）。
   */
  useEffect(() => {
    /** 松手：先结算"引脚换边"，再清拖动状态（window capture 先于元素自己的 handler）。 */
    const stop = (): void => {
      const drag = dragRef.current;
      if (drag !== null && drag.mode === "move" && drag.moved) {
        onMoveEndRef.current?.(drag.keys, { dx: drag.rawX, dy: drag.rawY });
      }
      dragRef.current = null;
    };
    const clear = (): void => {
      dragRef.current = null;
    };
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("blur", clear);
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
      /**
       * 双击 = 就地改字（不动拖动状态）。
       *
       * **必须排在修饰键分支之前**（用户 2026-11-09 实测"只有 Ctrl/Shift + 双击能编辑"）：
       * 原先 Ctrl/Shift 分支直接 return，双击识别根本走不到；那条路径上没设 pointer
       * capture，浏览器原生的 dblclick 反而能落到子节点上 —— 于是只有带修饰键才改得动字。
       */
      const now = Date.now();
      const previous = lastTapRef.current;
      const isDoubleTap =
        previous !== null &&
        previous.key === key &&
        now - previous.time <= DOUBLE_TAP_MS &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= DOUBLE_TAP_SLOP_PX;
      lastTapRef.current = isDoubleTap
        ? null
        : { key, time: now, x: event.clientX, y: event.clientY };
      if (isDoubleTap) {
        const handled = onDoubleTapRef.current?.(key, worldPoint(event)) ?? false;
        if (handled) {
          /* 阻止 pointerdown 的默认焦点处理：浏览器会把焦点交给 body（`<text>` 不可聚焦），
           * 那一步紧跟在事件处理器之后执行，会把行内输入框刚拿到的焦点抢走 ——
           * 用户看到输入框却一个字都打不进去（2026-11-09）。 */
          event.preventDefault();
          return;
        }
      }
      // 修饰键只改选中态、不启动拖动（Ctrl=切换、Shift=追加；OrCAD 也是这个手感）
      const mode: SelectionMode =
        event.ctrlKey || event.metaKey ? "toggle" : event.shiftKey ? "add" : "replace";
      if (mode !== "replace") {
        onSelectKeys([key], mode);
        return;
      }
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
        rawX: 0,
        rawY: 0,
        appliedX: 0,
        appliedY: 0,
        snap,
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
        snap,
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
        const { dx: stepDx, dy: stepDy } = dragDelta(
          event.clientX - drag.lastX,
          event.clientY - drag.lastY,
          scale,
        );
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        // 整组按同一份位移量化（引脚、文本、图形、本体一视同仁）。
        // 只量化引脚会让文本留在原处，反而把标签与引脚拉出间距 —— 所以组内一致。
        drag.rawX += stepDx;
        drag.rawY += stepDy;
        const delta = snapDragDelta(
          { dx: drag.rawX, dy: drag.rawY },
          { dx: drag.appliedX, dy: drag.appliedY },
          drag.snap,
        );
        drag.appliedX = delta.appliedX;
        drag.appliedY = delta.appliedY;
        if (delta.dx === 0 && delta.dy === 0) {
          return;
        }
        onMoveElements(drag.keys, delta.dx, delta.dy);
        return;
      }
      // 改大小：用"从按下点起算的绝对位移"算新四边，避免逐帧累加漂移
      const dx = (event.clientX - drag.startX) / scale;
      const dy = (event.clientY - drag.startY) / scale;
      const { origin, edges } = drag;
      const rawBounds: SymbolShapeBounds = {
        min: {
          x: edges.left ? origin.minX + dx : origin.minX,
          y: edges.top ? origin.minY + dy : origin.minY,
        },
        max: {
          x: edges.right ? origin.maxX + dx : origin.maxX,
          y: edges.bottom ? origin.maxY + dy : origin.maxY,
        },
      };
      onResizeRect(
        drag.key,
        drag.snap.enabled ? snapRectBounds(rawBounds, edges, drag.snap.grid) : rawBounds,
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
    snap,
    onMoveEnd,
    onDoubleTap,
    onEditPinLabel,
    namesSuppressed,
  }: {
    readonly sectionIndex: number;
    readonly pins: readonly NormalizedSymbolPin[];
    readonly body: SymbolBox;
    readonly showText: boolean;
    /** 整段名字被 `<IsPinNamesVisible=0>` 关掉（见 `pinNamesSuppressed`） */
    readonly namesSuppressed: boolean;
    readonly editing: boolean;
    readonly selectedKeys: ReadonlySet<string>;
    readonly scaleRef: RefObject<number>;
    readonly onSelectKeys: (keys: readonly string[], mode?: SelectionMode) => void;
    readonly onMoveElements: (keys: readonly string[], dx: number, dy: number) => void;
    readonly onResizeRect: (key: string, bounds: SymbolShapeBounds, dragged: RectEdges) => void;
    readonly snap: SnapState;
    readonly onMoveEnd?: (
      keys: readonly string[],
      delta: { readonly dx: number; readonly dy: number },
    ) => void;
    /** 双击（pointerdown 层识别）→ 就地改字；true = 已打开编辑器 */
    readonly onDoubleTap?: (
      key: string,
      point: { readonly x: number; readonly y: number } | null,
    ) => boolean;
    /** 双击引脚名/脚号 → 就地改字（用户 2026-10-22） */
    readonly onEditPinLabel?: (
      pinIndex: number,
      kind: "name" | "number",
      text: string,
    ) => void;
  }): ReactElement => {
    const drag = useElementDrag(
      editing,
      scaleRef,
      selectedKeys,
      onSelectKeys,
      onMoveElements,
      onResizeRect,
      snap,
      onMoveEnd,
      onDoubleTap,
    );

    /**
     * 标签的交互 props（用户 2026-11-10）。
     *
     * 标签是**独立元素**：点它只激活它自己、拖动只挪它自己，引脚线保持不动。
     * 必须渲染成引脚 `<g>` 的**兄弟节点**而不是子节点 —— 子节点的 pointerdown 会
     * 冒泡到引脚，表现就是"点标签 = 整条引脚被选中"，这正是要修掉的行为。
     */
    const labelProps = (labelKey: string): Record<string, unknown> =>
      editing
        ? {
            "data-draggable": "true",
            onPointerDown: drag.startMove(labelKey),
            onPointerMove: drag.move,
            onPointerUp: drag.end,
            onPointerCancel: drag.end,
            onLostPointerCapture: drag.end,
            style: { cursor: "default" },
          }
        : {};

    return (
      <>
        {pins.map((pin, pinIndex) => {
          const key = symbolPinKey(sectionIndex, pinIndex);
          const active = selectedKeys.has(key);
          const nameKey = symbolPinLabelKey(sectionIndex, pinIndex, "name");
          const numberKey = symbolPinLabelKey(sectionIndex, pinIndex, "number");
          /* 名字被整段关掉时只留脚号（与写库的 IsPinNamesVisible 一一对应）：
           * 这类符号的 name 就是 number，少画一条才是 Capture 里真实的样子。 */
          const showName = !namesSuppressed && pinLabelVisible(pin, "name");
          const showNumber = namesSuppressed
            ? pin.number.trim() !== ""
            : pinLabelVisible(pin, "number");
          return (
            <g
              /* key 只用"段:脚"这个稳定键。以前把 connection 坐标也拼进 key，
               * 拖动时每帧坐标都变 → React 卸载重建 <g> → **指针捕捉被丢掉** →
               * 松手时收不到 pointerup，dragRef 一直挂着，之后不按键移动鼠标
               * 元素也会跟着跑（用户 2026-10-19 报的正是这个）。 */
              key={key}
            >
              <g
                data-pin="true"
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
              {/* 标签：画在引脚命中线之后（上层），点文字优先命中文字 */}
              {showText ? (
                <>
                  {showNumber
                    ? (() => {
                        const box = pinLabelBoxOf(pin, "number", body);
                        return (
                          <g key={numberKey} {...labelProps(numberKey)}>
                            <rect
                              x={box.minX}
                              y={box.minY}
                              width={box.maxX - box.minX}
                              height={box.maxY - box.minY}
                              fill="transparent"
                            />
                            <Label
                              text={pin.number}
                              placement={pinLabelPlacement(pin, "number", body)}
                              color={selectedKeys.has(numberKey) ? ACTIVE : PIN_NUMBER}
                              onDoubleClick={
                                onEditPinLabel === undefined
                                  ? undefined
                                  : () => onEditPinLabel(pinIndex, "number", pin.number)
                              }
                            />
                          </g>
                        );
                      })()
                    : null}
                  {showName
                    ? (() => {
                        const box = pinLabelBoxOf(pin, "name", body);
                        return (
                          <g key={nameKey} {...labelProps(nameKey)}>
                            <rect
                              x={box.minX}
                              y={box.minY}
                              width={box.maxX - box.minX}
                              height={box.maxY - box.minY}
                              fill="transparent"
                            />
                            <Label
                              text={pin.name}
                              placement={pinLabelPlacement(pin, "name", body)}
                              color={selectedKeys.has(nameKey) ? ACTIVE : PIN_NAME}
                              onDoubleClick={
                                onEditPinLabel === undefined
                                  ? undefined
                                  : () => onEditPinLabel(pinIndex, "name", pin.name)
                              }
                            />
                          </g>
                        );
                      })()
                    : null}
                </>
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
  onReorientPins,
  onTextEdit,
  textEditRequest,
  onPinTextEdit,
  snap = { enabled: true, grid: SYMBOL_PIN_GRID },
}: {
  readonly symbol: NormalizedSymbol;
  readonly sectionIndex: number;
  readonly scale: number;
  readonly edits: SymbolEdits;
  /** 编辑模式：按住左键拖动元素 / 拖框线改大小；浏览模式交给 PanZoom */
  readonly editing: boolean;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectKeys: (keys: readonly string[], mode?: SelectionMode) => void;
  readonly onMoveElements: (keys: readonly string[], dx: number, dy: number) => void;
  readonly onResizeRect: (key: string, bounds: SymbolShapeBounds, dragged: RectEdges) => void;
  /**
   * 网格吸附（用户 2026-10-20）。省略时沿用旧行为：100 mil 吸附开启 ——
   * 现有测试与调用点不传也不会变。
   */
  readonly snap?: SnapState;
  /**
   * 拖动结束后重定向过的引脚（用户 2026-10-21）：拖到本体另一侧时引脚要翻方向。
   * 返回绝对端点，App 写成 `points` 编辑。
   */
  readonly onReorientPins?: (
    entries: readonly { readonly key: string; readonly points: SymbolPinPoints }[],
  ) => void;
  /** 双击文本提交新内容（用户 2026-10-21）；未传 = 不可编辑 */
  readonly onTextEdit?: (key: string, text: string) => void;
  /** 「添加文本」后请求打开行内编辑（nonce 变化即触发） */
  readonly textEditRequest?: { readonly key: string; readonly nonce: number } | null;
  /** 双击引脚标签提交新名/脚号（用户 2026-10-22） */
  readonly onPinTextEdit?: (
    key: string,
    kind: "name" | "number",
    text: string,
  ) => void;
}): ReactElement => {
  const section = symbol.sections[Math.min(sectionIndex, symbol.sections.length - 1)];

  // 拖动要除以缩放，但 scale 不能当 prop 传进 memo 的引脚层（见 useElementDrag）
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  /** 松手时结算：被拖过本体边界的引脚按"贴边朝外"重建两点。 */
  const finishMove = useCallback(
    (keys: readonly string[], delta: { readonly dx: number; readonly dy: number }): void => {
      if (onReorientPins === undefined) {
        return;
      }
      const body = bodyBoxOf(section);
      // 拖得更偏竖直 → 优先判成上下边（否则左引脚上拖会一直留在左侧）
      const bias: DragBias =
        Math.abs(delta.dy) > Math.abs(delta.dx) ? "vertical" : "horizontal";
      const entries: { key: string; points: SymbolPinPoints }[] = [];
      for (const key of keys) {
        if (!isSymbolPinKey(key)) {
          continue;
        }
        const { index } = parseSymbolEditKey(key);
        const pin = section.pins[index];
        if (pin === undefined) {
          continue;
        }
        const points = reorientPin(pin, body, snap, bias);
        if (points !== null) {
          entries.push({ key, points });
        }
      }
      if (entries.length > 0) {
        onReorientPins(entries);
      }
    },
    [section, snap, onReorientPins],
  );

  /**
   * 双击结算：注释文本 → 改内容；引脚 → 按落点离名字/脚号哪个近，改那一个。
   * 走 ref 包装保证引用稳定（SymbolPins 是 memo 的，每帧换回调会把引脚层打穿）。
   */
  const handleDoubleTapRef = useRef<
    (key: string, point: { readonly x: number; readonly y: number } | null) => boolean
  >(() => false);
  handleDoubleTapRef.current = (key, point) => {
    // 直接点在某一个标签上：双击就是要改这个标签，不用再按落点猜是名还是号
    const labelKey = parseSymbolPinLabelKey(key);
    if (labelKey !== null) {
      const labelPin = section.pins[labelKey.pinIndex];
      if (onPinTextEdit === undefined || labelPin === undefined) {
        return false;
      }
      setPinEdit({
        pinIndex: labelKey.pinIndex,
        kind: labelKey.kind,
        text: labelKey.kind === "name" ? labelPin.name : labelPin.number,
      });
      return true;
    }
    const { index } = parseSymbolEditKey(key);
    if (isSymbolPinKey(key)) {
      if (onPinTextEdit === undefined) {
        return false;
      }
      const pin = section.pins[index];
      if (pin === undefined) {
        return false;
      }
      const body = bodyBoxOf(section);
      const centerOfBox = (box: { minX: number; minY: number; maxX: number; maxY: number }) => ({
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
      });
      // 用**标签实际绘制的盒**（含锚点位移）判近，与命中区一致
      const nameCenter = centerOfBox(pinLabelBoxOf(pin, "name", body));
      const numberCenter = centerOfBox(pinLabelBoxOf(pin, "number", body));
      let kind: "name" | "number" = "name";
      if (point !== null) {
        const toNumber = Math.hypot(point.x - numberCenter.x, point.y - numberCenter.y);
        const toName = Math.hypot(point.x - nameCenter.x, point.y - nameCenter.y);
        kind = toNumber < toName ? "number" : "name";
      }
      setPinEdit({ pinIndex: index, kind, text: kind === "name" ? pin.name : pin.number });
      return true;
    }
    const shape = section.shapes[index];
    if (shape !== undefined && shape.kind === "text" && onTextEdit !== undefined && shape.hidden !== true) {
      setTextDraft(shape.text);
      setTextEditKey(key);
      return true;
    }
    return false;
  };
  const onDoubleTap = useCallback(
    (key: string, point: { readonly x: number; readonly y: number } | null): boolean =>
      handleDoubleTapRef.current(key, point),
    [],
  );

  const drag = useElementDrag(
    editing,
    scaleRef,
    selectedKeys,
    onSelectKeys,
    onMoveElements,
    onResizeRect,
    snap,
    finishMove,
    onDoubleTap,
  );

  /** 双击文本的行内编辑（用户 2026-10-21）。foreignObject 里放 textarea，随世界坐标缩放。 */
  const [textEditKey, setTextEditKey] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const textInputElement = useRef<HTMLTextAreaElement | null>(null);
  /** 双击引脚名/脚号的行内编辑（用户 2026-10-22） */
  const [pinEdit, setPinEdit] = useState<{
    readonly pinIndex: number;
    readonly kind: "name" | "number";
    readonly text: string;
  } | null>(null);
  const pinInputElement = useRef<HTMLInputElement | null>(null);
  const openPinEdit = useCallback((pinIndex: number, kind: "name" | "number", text: string): void => {
    setPinEdit({ pinIndex, kind, text });
  }, []);
  useInlineEditorFocus(pinEdit !== null, pinInputElement);
  useEffect(() => {
    if (!editing) {
      setPinEdit(null);
    }
  }, [editing]);
  useInlineEditorFocus(textEditKey !== null, textInputElement);
  useEffect(() => {
    if (textEditKey === null) {
      return;
    }
    // 换段 / 换器件 / 退出编辑模式后，正在编辑的文本可能已经不存在
    const index = Number(textEditKey.split(":")[1] ?? -1);
    const shape = section.shapes[index];
    if (!editing || shape === undefined || shape.kind !== "text") {
      setTextEditKey(null);
    }
  }, [editing, section, textEditKey]);

  // 「添加文本」请求：打开对应形状的行内编辑器，草稿预填形状当前文本
  const requestNonce = textEditRequest === undefined || textEditRequest === null ? -1 : textEditRequest.nonce;
  const requestKey = textEditRequest === undefined || textEditRequest === null ? null : textEditRequest.key;
  /**
   * 只认 nonce 变化，**不能把 section 放进依赖**：提交后 symbol 变了 → section 换了引用
   * → effect 重跑 → 编辑器立刻又打开，看起来就像"Enter 提交不了、只有 Esc 能退出"
   * （用户 2026-10-22 报的）。nonce 用 ref 去重，shape 从当次 render 的 section 读。
   */
  const handledRequestRef = useRef(-1);
  useEffect(() => {
    if (requestKey === null || requestNonce < 0 || handledRequestRef.current === requestNonce) {
      return;
    }
    handledRequestRef.current = requestNonce;
    const shape = section.shapes[Number(requestKey.split(":")[1] ?? -1)];
    if (shape === undefined || shape.kind !== "text") {
      return;
    }
    setTextDraft(shape.text);
    setTextEditKey(requestKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, requestNonce]);

  const commitTextEdit = useCallback((): void => {
    if (textEditKey !== null && onTextEdit !== undefined) {
      /* 换行原样保留（用户 2026-11-09）：只统一 CRLF、去掉末尾多余空行，
       * 中间的空行是用户排版的一部分，不能折叠。 */
      onTextEdit(textEditKey, textDraft.replace(/\r\n?/g, "\n").replace(/\n+$/, ""));
    }
    setTextEditKey(null);
  }, [onTextEdit, textDraft, textEditKey]);

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
        if (shape.kind === "text" && shape.hidden === true) {
          return null; // 用户删除的注释文本：保留下标、不画
        }
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
                /* 可见的填充面**不参与命中**（用户 2026-10-21）：框内空白按下左键
                 * 要交给 PanZoom 去框选里面的引脚/文本，而不是把整个本体拖走。
                 * 本体的交互只走下面那条 9px 框线命中区（点线选中 + 拖线改大小）。 */
                pointerEvents="none"
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
         * 可点区域，这样"想再拖同一个标签"就不会抓到别的东西。
         *
         * 字号必须走 `symbolFontHeight` —— 写 .olb 时用的就是它，**预览按源字号画、
         * 写库按 0.75 折算**会让 Capture 里每条标注都比预览小一号（用户 2026-10-19 反馈）。 */
        const fontHeight = symbolFontHeight(shape.height);
        /** 行距（用户 2026-11-09 支持换行）：与 `tspan` 的 dy、命中盒高度共用一份。 */
        const lineStep = fontHeight * SYMBOL_TEXT_LINE_STEP;
        const lines = symbolTextLines(shape.text);
        const hitWidth = Math.max(
          estimateMultilineWidth(shape.text) * (fontHeight / PIN_FONT) * 1.35 + 12,
          24,
        );
        const hitHeight = fontHeight * 1.4 + 6 + lineStep * (lines.length - 1);
        const doubleClick =
          editing && onTextEdit !== undefined
            ? (event: ReactMouseEvent<SVGElement>): void => {
                // 双击 = 就地改字（OrCAD 同款操作）；别让 PanZoom 把它当空白点击
                event.stopPropagation();
                setTextDraft(shape.text);
                setTextEditKey(key);
              }
            : undefined;
        if (textEditKey === key) {
          /** 编辑器随草稿行数一起长高，不出现滚动条（SVG 里的滚动条会跟着缩放，很丑）。 */
          const draftLines = symbolTextLines(textDraft);
          const draftWidth =
            estimateMultilineWidth(textDraft) * (fontHeight / PIN_FONT) * 1.35 + 24;
          return (
            <g key={key} transform={translate}>
              <g
                transform={
                  shape.rotation === 0
                    ? undefined
                    : `rotate(${-shape.rotation} ${shape.at.x} ${shape.at.y})`
                }
              >
                <foreignObject
                  x={shape.at.x - 4}
                  y={shape.at.y - fontHeight}
                  width={Math.max(hitWidth, draftWidth, 80)}
                  height={lineStep * draftLines.length + 8}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <div style={{ display: "contents" }}>
                    <textarea
                      ref={textInputElement}
                      value={textDraft}
                      rows={draftLines.length}
                      onChange={(event) => setTextDraft(event.target.value)}
                      onBlur={commitTextEdit}
                      onKeyDown={(event) => {
                        /**
                         * **Enter = 换行**（用户 2026-11-09 要求"文本支持换行编辑"）。
                         * 提交改成 Ctrl/⌘+Enter 或点到别处（失焦）；Esc 取消。
                         */
                        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                          event.preventDefault();
                          commitTextEdit();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setTextEditKey(null);
                        }
                        // 别让全局快捷键（方向键挪元素、Delete 删元素）吃到输入
                        event.stopPropagation();
                      }}
                      spellCheck={false}
                      title="Enter 换行，Ctrl+Enter 确认，Esc 取消"
                      style={{
                        width: "100%",
                        height: "100%",
                        boxSizing: "border-box",
                        fontSize: `${fontHeight}px`,
                        // 行距按像素写死，和 SVG 里的 tspan 对齐
                        lineHeight: `${lineStep}px`,
                        padding: "2px 3px",
                        margin: 0,
                        resize: "none",
                        overflow: "hidden",
                        whiteSpace: "pre",
                        color: TEXT,
                        background: "white",
                        border: "1px solid #e0862c",
                        outline: "none",
                        fontFamily: "inherit",
                        // .panzoom-svg 为了框选禁了文本选择，别让输入框继承（否则框里选不了字）
                        userSelect: "text",
                        WebkitUserSelect: "text",
                      }}
                      data-testid="text-editor"
                    />
                  </div>
                </foreignObject>
              </g>
            </g>
          );
        }
        return (
          <g key={key} transform={translate} {...moveProps(key)}>
            <g
              transform={
                shape.rotation === 0
                  ? undefined
                  : `rotate(${-shape.rotation} ${shape.at.x} ${shape.at.y})`
              }
              onDoubleClick={doubleClick}
            >
              {editing ? (
                <rect
                  x={shape.at.x - 4}
                  y={shape.at.y - fontHeight}
                  width={hitWidth}
                  height={hitHeight}
                  fill="transparent"
                />
              ) : null}
              <text
                x={shape.at.x}
                y={shape.at.y}
                fontSize={fontHeight}
                fill={active ? ACTIVE : TEXT}
              >
                {/* 多行：一行一个 tspan，dy 按行距递进（用户 2026-11-09） */}
                {lines.map((line, lineIndex) => (
                  <tspan key={lineIndex} x={shape.at.x} dy={lineIndex === 0 ? 0 : lineStep}>
                    {line.length === 0 ? " " : line}
                  </tspan>
                ))}
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
        namesSuppressed={pinNamesSuppressed(section)}
        editing={editing}
        selectedKeys={selectedKeys}
        scaleRef={scaleRef}
        onSelectKeys={onSelectKeys}
        onMoveElements={onMoveElements}
        onResizeRect={onResizeRect}
        snap={snap}
        onMoveEnd={finishMove}
        onDoubleTap={onDoubleTap}
        onEditPinLabel={onPinTextEdit === undefined ? undefined : openPinEdit}
      />

      {/* 引脚名/脚号的行内编辑：位置跟着标签锚点，旋转跟着边（上下引脚竖排） */}
      {editing && pinEdit !== null
        ? (() => {
            const pin = section.pins[pinEdit.pinIndex];
            if (pin === undefined) {
              return null;
            }
            const placement = pinLabelPlacement(pin, pinEdit.kind, body);
            const width = Math.max(40, estimateLabelWidth(pinEdit.text) * 1.4 + 16);
            const commitPinEdit = (): void => {
              if (onPinTextEdit !== undefined) {
                onPinTextEdit(
                  symbolPinKey(sectionIndex, pinEdit.pinIndex),
                  pinEdit.kind,
                  pinEdit.text.replace(/[\r\n]+/g, " "),
                );
              }
              setPinEdit(null);
            };
            return (
              <foreignObject
                x={placement.anchor === "end" ? placement.x - width : placement.x - 3}
                y={placement.y - PIN_FONT * 1.15}
                width={width}
                height={PIN_FONT * 1.7}
                transform={
                  placement.rotate === 0
                    ? undefined
                    : `rotate(${placement.rotate} ${placement.x} ${placement.y})`
                }
                onPointerDown={(event) => event.stopPropagation()}
              >
                <input
                  ref={pinInputElement}
                  value={pinEdit.text}
                  onChange={(event) => setPinEdit({ ...pinEdit, text: event.target.value })}
                  onBlur={commitPinEdit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitPinEdit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setPinEdit(null);
                    }
                  }}
                  spellCheck={false}
                  style={{
                    width: "100%",
                    height: "100%",
                    fontSize: `${PIN_FONT}px`,
                    lineHeight: 1,
                    padding: "0 3px",
                    color: pinEdit.kind === "name" ? PIN_NAME : PIN_NUMBER,
                    background: "white",
                    border: "1px solid #e0862c",
                    outline: "none",
                    fontFamily: "inherit",
                    userSelect: "text",
                    WebkitUserSelect: "text",
                  }}
                  data-testid="pin-label-editor"
                />
              </foreignObject>
            );
          })()
        : null}
    </g>
  );
};
