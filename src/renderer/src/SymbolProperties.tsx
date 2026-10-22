import { useEffect, useState, type ReactElement } from "react";
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
}: {
  readonly element: ElementProps;
  readonly snap: SnapState;
  readonly onField: (field: ElementField, value: number) => void;
  /** 删除这条文本（用户 2026-10-22）；只有文本元素会传 */
  readonly onDelete?: () => void;
}): ReactElement => {
  const commit = (field: ElementField) => (value: number) => {
    // 位置与尺寸落在网格上；字号/旋转是离散值，不参与吸附
    const snapIt = snap.enabled && field !== "textHeight" && field !== "rotation";
    onField(field, snapIt ? snapValue(value, snap.grid) : value);
  };
  const step = snap.enabled ? snap.grid : 1;

  return (
    <div className="symbol-props" role="group" aria-label="元素属性" data-testid="symbol-props">
      <div className="symbol-props-title">
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
