import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

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
 * 交互：滚轮以光标为中心缩放；**空白处按住鼠标左键拖动即平移**；右下角有 −/＋/适应 按钮。
 * 标了 `data-draggable` 的子元素会自行处理 pointerdown（并 stopPropagation），
 * 不会被平移抢走 —— 按在元素上是"移动元素"，按在空白处才是"移动画布"，二者不会同时触发。
 */
export const PanZoom = ({
  bounds,
  resetKey,
  children,
  ariaLabel,
  zoomable = true,
  onBackgroundClick,
}: {
  readonly bounds: PanZoomBounds;
  /** 变化时自动适应窗口（切换器件 / 切换分页） */
  readonly resetKey: string;
  readonly children: (view: { readonly scale: number }) => ReactNode;
  readonly ariaLabel: string;
  /**
   * false = 「编辑」模式：**滚轮缩放**让位给元素编辑（用户 2026-10-16 要求编辑与缩放互斥）；
   * 平移不受影响（空白处照样左键拖动），否则编辑大符号时视图动不了。
   * 缩放在编辑模式下仍可用右下角的 −/＋ 按钮。
   */
  readonly zoomable?: boolean;
  /** 在空白处按下并原地松开（没有拖动）时触发，用于取消选中。 */
  readonly onBackgroundClick?: () => void;
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
  } | null>(null);

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

  const fit = useCallback(() => {
    const width = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const height = Math.max(bounds.maxY - bounds.minY, 1e-6);
    const scale = Math.min(size.width / width, size.height / height) * FIT_PADDING;
    setView({
      scale,
      tx: size.width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
      ty: size.height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
    });
  }, [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, size.width, size.height]);

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

  // React 的 onWheel 在部分环境是 passive，preventDefault 会被忽略 → 手挂原生监听。
  useEffect(() => {
    const element = containerRef.current;
    if (element === null || !zoomable) {
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
  }, [zoomAt, zoomable]);

  /** 按下到抬起之间不超过这个像素位移就算"点击空白处"（而非拖动平移）。 */
  const CLICK_SLOP = 3;

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    // 左键(0)与中键(1)都能拖动画布；编辑模式下同样可用（编辑与缩放互斥，但不与平移互斥）。
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
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) {
      return;
    }
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
    if (event.button === 0 && travelled <= CLICK_SLOP) {
      onBackgroundClick?.();
    }
  };

  const percent = Math.round(view.scale * 100);
  return (
    <div className={`panzoom${zoomable ? "" : " editing"}`} ref={containerRef}>
      <svg
        className="panzoom-svg"
        width={size.width}
        height={size.height}
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {/* 透明底板：让 .engineering-canvas 的网格纹理透出来 */}
        <rect x={0} y={0} width={size.width} height={size.height} fill="transparent" />
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          {children({ scale: view.scale })}
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
