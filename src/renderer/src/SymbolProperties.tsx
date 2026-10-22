import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { ElementField, ElementProps } from "../../shared/symbol-property";
import { snapValue, type SnapState } from "../../shared/symbol-snap";

/**
 * 精确属性面板（用户 2026-10-20）。
 *
 * 只做受控展示 + 提交，读/写换算全部在 `shared/symbol-property.ts`（纯函数、可单测）。
 * 提交时机：Enter 或失焦 —— 逐键提交会一个输入框攒出一堆撤销点。
 * 吸附开启时 X/Y/宽/高 会先落到当前档位（10 或 5 单位）。
 */

const NumberField = ({
  label,
  value,
  step,
  onCommit,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly step: number;
  readonly onCommit: (value: number) => void;
  readonly testId: string;
}): ReactElement => {
  const display = String(Math.round(value * 100) / 100);
  const [text, setText] = useState(display);
  useEffect(() => {
    setText(display);
  }, [display]);

  const commit = (): void => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(display);
      return;
    }
    onCommit(parsed);
  };

  return (
    <label className="symbol-prop">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setText(display);
            event.currentTarget.blur();
          }
        }}
        data-testid={testId}
      />
    </label>
  );
};

export const SymbolProperties = ({
  element,
  snap,
  onField,
  onDelete,
  position,
  onMove,
}: {
  readonly element: ElementProps;
  readonly snap: SnapState;
  readonly onField: (field: ElementField, value: number) => void;
  /** 删除这条文本（用户 2026-10-22）；只有文本元素会传 */
  readonly onDelete?: () => void;
  /** 面板位置（相对画布左上角像素）；null = 默认右上角（用户 2026-10-22：可拖动并持久化） */
  readonly position?: { readonly x: number; readonly y: number } | null;
  /** 拖动结束 / 双击标题复位时回调；传 null = 回到默认位置 */
  readonly onMove?: (position: { x: number; y: number } | null) => void;
}): ReactElement => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState<{ x: number; y: number } | null>(position ?? null);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly originX: number;
    readonly originY: number;
    readonly maxX: number;
    readonly maxY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    setLive(position ?? null);
  }, [position?.x, position?.y]);

  /** 画布尺寸变化（或持久化的位置超出画布）时夹回可视范围。 */
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null || live === null) {
      return;
    }
    const canvas = panel.closest(".engineering-canvas");
    if (canvas === null) {
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const x = Math.min(Math.max(live.x, 0), Math.max(canvasRect.width - panelRect.width, 0));
    const y = Math.min(Math.max(live.y, 0), Math.max(canvasRect.height - panelRect.height, 0));
    if (x !== live.x || y !== live.y) {
      setLive({ x, y });
    }
  }, [live]);

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (onMove === undefined) {
        return;
      }
      const panel = panelRef.current;
      if (panel === null) {
        return;
      }
      event.preventDefault();
      const canvas = panel.closest(".engineering-canvas");
      const canvasRect = canvas?.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const originX = live?.x ?? panelRect.left - (canvasRect?.left ?? 0);
      const originY = live?.y ?? panelRect.top - (canvasRect?.top ?? 0);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX,
        originY,
        maxX: Math.max((canvasRect?.width ?? 0) - panelRect.width, 0),
        maxY: Math.max((canvasRect?.height ?? 0) - panelRect.height, 0),
        moved: false,
      };
      setLive({ x: originX, y: originY });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [live, onMove],
  );

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    drag.moved = true;
    setLive({
      x: Math.min(Math.max(drag.originX + event.clientX - drag.startX, 0), drag.maxX),
      y: Math.min(Math.max(drag.originY + event.clientY - drag.startY, 0), drag.maxY),
    });
  }, []);

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      dragRef.current = null;
      if (!drag.moved) {
        // 只是点了一下标题，没真的拖动：恢复原样，不写设置
        setLive(position ?? null);
        return;
      }
      // 松手才落盘：拖动过程每帧写设置会把 settings.json 打爆
      onMove?.({
        x: Math.min(Math.max(drag.originX + event.clientX - drag.startX, 0), drag.maxX),
        y: Math.min(Math.max(drag.originY + event.clientY - drag.startY, 0), drag.maxY),
      });
    },
    [onMove, position],
  );

  /** 双击标题 = 回到默认位置（右上角）。 */
  const resetPosition = useCallback((): void => {
    dragRef.current = null;
    setLive(null);
    onMove?.(null);
  }, [onMove]);
  const commit = (field: ElementField) => (value: number) => {
    // 位置与尺寸落在网格上；字号/旋转是离散值，不参与吸附
    const snapIt = snap.enabled && field !== "textHeight" && field !== "rotation";
    onField(field, snapIt ? snapValue(value, snap.grid) : value);
  };
  const step = snap.enabled ? snap.grid : 1;

  return (
    <div
      className={`symbol-props${dragRef.current === null ? "" : " dragging"}`}
      role="group"
      aria-label="元素属性"
      data-testid="symbol-props"
      ref={panelRef}
      style={live === null ? undefined : { left: live.x, top: live.y, right: "auto" }}
    >
      <div
        className="symbol-props-title"
        data-testid="symbol-props-title"
        title="拖动移动面板，双击回到默认位置"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetPosition}
      >
        {element.kind === "rect" ? "本体" : element.kind === "text" ? "文本" : "元素"}
      </div>
      <div className="symbol-props-grid">
        <NumberField label="X" value={element.x} step={step} onCommit={commit("x")} testId="prop-x" />
        <NumberField label="Y" value={element.y} step={step} onCommit={commit("y")} testId="prop-y" />
        {element.kind === "rect" ? (
          <>
            <NumberField
              label="宽"
              value={element.width}
              step={step}
              onCommit={commit("width")}
              testId="prop-width"
            />
            <NumberField
              label="高"
              value={element.height}
              step={step}
              onCommit={commit("height")}
              testId="prop-height"
            />
          </>
        ) : null}
        {element.kind === "text" ? (
          <>
            <NumberField
              label="字号"
              value={element.height}
              step={1}
              onCommit={commit("textHeight")}
              testId="prop-text-height"
            />
            <label className="symbol-prop">
              <span>旋转</span>
              <select
                value={element.rotation}
                onChange={(event) => onField("rotation", Number(event.target.value))}
                data-testid="prop-rotation"
              >
                <option value={0}>0°</option>
                <option value={90}>90°</option>
                <option value={180}>180°</option>
                <option value={270}>270°</option>
              </select>
            </label>
          </>
        ) : null}
      </div>
      {onDelete === undefined ? null : (
        <button
          type="button"
          className="symbol-props-delete"
          onClick={onDelete}
          title="删除这条文本（Ctrl+Z 可撤回）"
          data-testid="prop-delete"
        >
          删除文本
        </button>
      )}
    </div>
  );
};
