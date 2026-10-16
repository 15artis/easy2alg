import type { SymbolEdits } from "./symbol-edit";

/**
 * 原理图符号编辑的**撤销 / 重做**栈（用户 2026-10-16 要求"编辑支持退回步骤"）。
 *
 * 只存 `SymbolEdits` 快照（每次编辑**前**的状态）：符号编辑本身就是不可变结构
 * （`accumulateOffset` / `applySymbolEdits` 都返回新对象），所以"退回一步"= 把旧快照
 * 放回去，不需要写反向操作。快照很小（几十个键），限长 80 步足够。
 *
 * 每台器件一条栈：来回切器件不会把别人的历史搅在一起。
 */

/** 最多保留多少步 */
export const EDIT_HISTORY_LIMIT = 80;

export type EditHistory = {
  readonly undo: readonly SymbolEdits[];
  readonly redo: readonly SymbolEdits[];
};

export const EMPTY_EDIT_HISTORY: EditHistory = { undo: [], redo: [] };

/** 记一个撤销点 —— 新的编辑会让重做栈作废。 */
export const pushUndo = (history: EditHistory, before: SymbolEdits): EditHistory => ({
  undo: [...history.undo, before].slice(-EDIT_HISTORY_LIMIT),
  redo: [],
});

/**
 * 退回一步。返回新的栈与要恢复的编辑状态；没得退返回 null。
 * 当前状态会进入重做栈。
 */
export const undoOnce = (
  history: EditHistory,
  current: SymbolEdits,
): { readonly history: EditHistory; readonly edits: SymbolEdits } | null => {
  const before = history.undo[history.undo.length - 1];
  if (before === undefined) {
    return null;
  }
  return {
    history: {
      undo: history.undo.slice(0, -1),
      redo: [...history.redo, current].slice(-EDIT_HISTORY_LIMIT),
    },
    edits: before,
  };
};

/** 前进一步（undoOnce 的对称操作）。 */
export const redoOnce = (
  history: EditHistory,
  current: SymbolEdits,
): { readonly history: EditHistory; readonly edits: SymbolEdits } | null => {
  const next = history.redo[history.redo.length - 1];
  if (next === undefined) {
    return null;
  }
  return {
    history: {
      undo: [...history.undo, current].slice(-EDIT_HISTORY_LIMIT),
      redo: history.redo.slice(0, -1),
    },
    edits: next,
  };
};

export const canUndo = (history: EditHistory): boolean => history.undo.length > 0;
export const canRedo = (history: EditHistory): boolean => history.redo.length > 0;
