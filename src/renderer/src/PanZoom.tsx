import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { fitBoxToView } from "../../shared/symbol-snap";

export type PanZoomBounds = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

type View = { readonly scale: number; readonly tx: number; readonly ty: number };

const MIN_SCALE = 0.02;
const MAX_SCALE = 80;
const FIT_PADDING = 0.86;
/** 带这个属性的元素自己消化拖拽（用于符号的手工调整），不会被当成平移。 */
const DRAGGABLE_SELECTOR = "[data-draggable]";

/**
 * 可缩放 / 可平移的 SVG 画布。
 *
 * 世界坐标 = SVG 用户单位（不设 viewBox，因此外层用户单位就是像素），
 * 内容整体挂在 `<g transform="translate(tx ty) scale(s)">` 上，缩放平移只改
 * 这一个 transform，内容不用重算。
 *
 * 交互：滚轮以光标为中心缩放；**中键按住拖动 = 平移画布**；右下角有 −/＋/适应 按钮。
 * 标了 `data-draggable` 的子元素会自行处理 pointerdown（并 stopPropagation），
 * 不会被这里的逻辑抢走 —— 按在元素上是"移动/改大小"，按在空白处才是画布的事。
 *
 * 按"光标底下是什么"分流（不按全局模式分流）：
 *  - 按在元素上：元素自己消化；
 *  - 空白处 + 传了 `onMarquee`（符号编辑模式）：左键拖出**橡皮筋框选**
 *    （用户 2026-10-16 要求"支持框选内容一起移动"），光标保持默认箭头；
 *  - 其余（含 PCB 预览）：左键拖动 = 平移画布；中键任何模式下都能平移。
 *
 * 缩放与平移在编辑模式下同样可用（用户要求"编辑时允许符号缩放"）。
 */

/** 橡皮筋框（世界坐标）。 */
export type MarqueeBox = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

/**
 * 命令式接口（用户 2026-10-20："缩放到选中"）。
 * 只暴露最小命令面，视图状态仍由组件内部管理。
 */
export type PanZoomHandle = {
  readonly fitAll: () => void;
  readonly fitTo: (box: PanZoomBounds) => void;
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
};
export const PanZoom = ({
  bounds,
  resetKey,
  children,
  ariaLabel,
  onBackgroundClick,
  onMarquee,
  ref,
}: {
  readonly bounds: PanZoomBounds;
  /** 变化时自动适应窗口（切换器件 / 切换分页） */
  readonly resetKey: string;
  readonly children: (view: {
    readonly scale: number;
    readonly tx: number;
    readonly ty: number;
    readonly width: number;
    readonly height: number;
  }) => ReactNode;
  readonly ariaLabel: string;
  /** 在空白处按下并原地松开（没有拖动）时触发，用于取消选中。 */
  readonly onBackgroundClick?: () => void;
  /**
   * 空白处左键拖出橡皮筋框选。世界坐标盒；拖动中 `done=false`，松手时 `done=true`
   * （框太小视作点击：传 `null` 并触发 onBackgroundClick 取消选中）。
   * 传了它，左键空白拖动就不再是平移 —— 平移走中键。
   */
  readonly onMarquee?: (box: MarqueeBox | null, done: boolean) => void;
  readonly ref?: Ref<PanZoomHandle>;
}): ReactElement => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const panRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly tx: number;
    readonly ty: number;
    /** 这次按下是框选、平移还是（未用）其它 */
    readonly mode: "marquee" | "pan";
    /** 是否已经越过点击死区 */
    moved: boolean;
  } | null>(null);
  /** 正在拖的橡皮筋框（世界坐标）—— 只用于画出来 */
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect !== undefined) {
        setSize({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fitToBox = useCallback(
    (box: PanZoomBounds) => {
      setView(fitBoxToView(box, size, FIT_PADDING, { min: MIN_SCALE, max: MAX_SCALE }));
    },
    [size.height, size.width],
  );

  const fit = useCallback(() => fitToBox(bounds), [fitToBox, bounds]);

  /**
   * 自动"适应窗口"只在**换器件/换分页**（resetKey）与容器尺寸变化时跑。
   *
   * 不能把 `fit` 直接挂到 bounds 上：符号预览的 bounds 是**内容包围盒**，拖动一个
   * 元素它就变 → 每动一下视图就重新居中+改缩放，画面在光标底下跳（实测 headless
   * 里拖动 60px 时画布自己缩到 95.7% 并漂移）。用户手动按「适应」时仍走 `fit`。
   */
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const sizeKey = `${Math.round(size.width)}x${Math.round(size.height)}`;
  useLayoutEffect(() => {
    fitRef.current();
  }, [resetKey, sizeKey]);

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    setView((current) => {
      const scale = Math.min(Math.max(current.scale * factor, MIN_SCALE), MAX_SCALE);
      const ratio = scale / current.scale;
      return {
        scale,
        tx: px - (px - current.tx) * ratio,
        ty: py - (py - current.ty) * ratio,
      };
    });
  }, []);

  const zoomCenter = useCallback(
    (factor: number) => zoomAt(factor, size.width / 2, size.height / 2),
    [size.height, size.width, zoomAt],
  );

  /** 复位 = 回到 100% 并把内容摆到画布中心（区别于"适应窗口"的自动缩放）。 */
  const reset = useCallback(() => {
    setView({
      scale: 1,
      tx: size.width / 2 - (bounds.minX + bounds.maxX) / 2,
      ty: size.height / 2 - (bounds.minY + bounds.maxY) / 2,
    });
  }, [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, size.height, size.width]);

  useImperativeHandle(
    ref,
    () => ({
      fitAll: fit,
      fitTo: fitToBox,
      zoomBy: (factor: number) => zoomCenter(factor),
      reset: () => reset(),
    }),
    [fit, fitToBox, zoomCenter, reset],
  );

  // React 的 onWheel 在部分环境是 passive，preventDefault 会被忽略 → 手挂原生监听。
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) {
      return;
    }
    const handler = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      // deltaMode 1 = 按行滚动，换算成像素量级
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      zoomAt(Math.exp(-delta * 0.0016), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener("wheel", handler, { passive: false });
    return () => element.removeEventListener("wheel", handler);
  }, [zoomAt]);

  /** 按下到抬起之间不超过这个像素位移就算"点击空白处"（而非拖动）。 */
  const CLICK_SLOP = 3;

  /** 屏幕坐标 → 世界坐标（与滚轮缩放同一套换算）。 */
  const toWorld = (clientX: number, clientY: number): { readonly x: number; readonly y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return {
      x: (clientX - left - view.tx) / view.scale,
      y: (clientY - top - view.ty) / view.scale,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    // 左键(0)与中键(1)都能拖动；中键永远是平移画布
    if (event.button !== 0 && event.button !== 1) {
      return;
    }
    const target = event.target as Element | null;
    if (target?.closest(DRAGGABLE_SELECTOR) != null) {
      return;
    }
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tx: view.tx,
      ty: view.ty,
      // 左键 + 调用方要框选 → 框选；其余（含中键）→ 平移
      mode: event.button === 0 && onMarquee !== undefined ? "marquee" : "pan",
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) {
      return;
    }
    // 左键已经松开（没收到 pointerup 的兜底）→ 停手，别让画布/框选跟着鼠标跑。
    if (event.buttons === 0) {
      panRef.current = null;
      setMarquee(null);
      return;
    }
    const travelled = Math.abs(event.clientX - pan.startX) + Math.abs(event.clientY - pan.startY);
    if (pan.mode === "marquee") {
      // 死区：点击（按下即抬起）不算框选，交给 endPan 当取消选中处理
      if (!pan.moved && travelled <= CLICK_SLOP) {
        return;
      }
      pan.moved = true;
      const from = toWorld(pan.startX, pan.startY);
      const to = toWorld(event.clientX, event.clientY);
      const box: MarqueeBox = {
        minX: Math.min(from.x, to.x),
        minY: Math.min(from.y, to.y),
        maxX: Math.max(from.x, to.x),
        maxY: Math.max(from.y, to.y),
      };
      setMarquee(box);
      onMarquee?.(box, false);
      return;
    }
    if (!pan.moved && travelled <= CLICK_SLOP) {
      return;
    }
    pan.moved = true;
    setView((current) => ({
      ...current,
      tx: pan.tx + (event.clientX - pan.startX),
      ty: pan.ty + (event.clientY - pan.startY),
    }));
  };

  const endPan = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) {
      return;
    }
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const travelled =
      Math.abs(event.clientX - pan.startX) + Math.abs(event.clientY - pan.startY);
    if (pan.mode === "marquee") {
      setMarquee(null);
      if (pan.moved) {
        const from = toWorld(pan.startX, pan.startY);
        const to = toWorld(event.clientX, event.clientY);
        onMarquee?.(
          {
            minX: Math.min(from.x, to.x),
            minY: Math.min(from.y, to.y),
            maxX: Math.max(from.x, to.x),
            maxY: Math.max(from.y, to.y),
          },
          true,
        );
        return;
      }
      // 没拖动 = 点在空白处 → 取消选中
      onMarquee?.(null, true);
    }
    if (event.button === 0 && travelled <= CLICK_SLOP) {
      onBackgroundClick?.();
    }
  };

  const percent = Math.round(view.scale * 100);
  return (
    <div className="panzoom" ref={containerRef}>
      <svg
        className="panzoom-svg"
        width={size.width}
        height={size.height}
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onLostPointerCapture={endPan}
      >
        {/* 透明底板：让 .engineering-canvas 的网格纹理透出来 */}
        <rect x={0} y={0} width={size.width} height={size.height} fill="transparent" />
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          {children({
            scale: view.scale,
            tx: view.tx,
            ty: view.ty,
            width: size.width,
            height: size.height,
          })}
          {/* 橡皮筋框：画在世界坐标里，线宽用 non-scaling-stroke 不随缩放变粗 */}
          {marquee === null ? null : (
            <rect
              className="marquee"
              x={marquee.minX}
              y={marquee.minY}
              width={Math.max(marquee.maxX - marquee.minX, 0)}
              height={Math.max(marquee.maxY - marquee.minY, 0)}
            />
          )}
        </g>
      </svg>
      <div className="panzoom-controls">
        <button type="button" onClick={() => zoomCenter(1 / 1.35)} aria-label="缩小" title="缩小">
          −
        </button>
        <span>{percent >= 1000 ? ">999%" : `${percent}%`}</span>
        <button type="button" onClick={() => zoomCenter(1.35)} aria-label="放大" title="放大">
          ＋
        </button>
        <button type="button" className="panzoom-fit" onClick={fit} title="缩放到刚好看见全部内容">
          适应
        </button>
        <button type="button" className="panzoom-fit" onClick={reset} title="复位：回到 100% 并居中" data-testid="panzoom-reset">
          复位
        </button>
      </div>
    </div>
  );
};
