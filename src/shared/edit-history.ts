import { EMPTY_SYMBOL_EDITS, type AddedSymbolItem, type SymbolEdits } from "./symbol-edit";

/**
 * 原理图符号编辑的**撤销 / 重做**栈（用户 2026-10-16 要求"编辑支持退回步骤"）。
 *
 * 快照 = `SymbolEdits` + `addedItems`（用户 2026-11-11）：
 * 符号编辑本身就是不可变结构（`accumulateOffset` / `applySymbolEdits` 都返回新对象），
 * 所以"退回一步"= 把旧快照放回去，不需要写反向操作。快照很小，限长 80 步足够。
 *
 * **`addedItems` 必须在快照里**：手画的线段/圆/矩形、粘贴出来的副本、新增文本都只存在于
 * 这个数组（追加时会展开成段末的 shapes，下标就是编辑键）。只回滚 `symbolEdits` 的话，
 * Ctrl+Z 撤不掉刚画的东西，却会把更早的编辑退掉 —— 看起来像"撤销坏了"。
 *
 * 每台器件一条栈：来回切器件不会把别人的历史搅在一起。
 */

/** 最多保留多少步 */
export const EDIT_HISTORY_LIMIT = 80;

/** 一步编辑之前的完整快照。 */
export type SymbolSnapshot = {
  readonly symbolEdits: SymbolEdits;
  /** 用户新增元素（文本 / 手画图形 / 粘贴副本）；源库元素不在这里 */
  readonly addedItems: readonly AddedSymbolItem[];
};

/**
 * 空快照的 `addedItems` 是**同一个常量引用** —— 比较"这一步有没有真改动"用的是引用比较，
 * 每次 `[]` 新建数组会让"没动过"永远被判成改过（每次点击都攒一个撤销点）。
 */
export const EMPTY_ADDED_ITEMS: readonly AddedSymbolItem[] = [];

export const EMPTY_SYMBOL_SNAPSHOT: SymbolSnapshot = {
  symbolEdits: EMPTY_SYMBOL_EDITS,
  addedItems: EMPTY_ADDED_ITEMS,
};

export type EditHistory = {
  readonly undo: readonly SymbolSnapshot[];
  readonly redo: readonly SymbolSnapshot[];
};

export const EMPTY_EDIT_HISTORY: EditHistory = { undo: [], redo: [] };

/** 两份快照是否指向同一状态（不可变结构，引用相等即未改动）。 */
export const sameSnapshot = (a: SymbolSnapshot, b: SymbolSnapshot): boolean =>
  a.symbolEdits === b.symbolEdits && a.addedItems === b.addedItems;

/** 记一个撤销点 —— 新的编辑会让重做栈作废。 */
export const pushUndo = (history: EditHistory, before: SymbolSnapshot): EditHistory => ({
  undo: [...history.undo, before].slice(-EDIT_HISTORY_LIMIT),
  redo: [],
});

/**
 * 退回一步。返回新的栈与要恢复的快照；没得退返回 null。
 * 当前状态会进入重做栈。
 */
export const undoOnce = (
  history: EditHistory,
  current: SymbolSnapshot,
): { readonly history: EditHistory; readonly snapshot: SymbolSnapshot } | null => {
  const before = history.undo[history.undo.length - 1];
  if (before === undefined) {
    return null;
  }
  return {
    history: {
      undo: history.undo.slice(0, -1),
      redo: [...history.redo, current].slice(-EDIT_HISTORY_LIMIT),
    },
    snapshot: before,
  };
};

/** 前进一步（undoOnce 的对称操作）。 */
export const redoOnce = (
  history: EditHistory,
  current: SymbolSnapshot,
): { readonly history: EditHistory; readonly snapshot: SymbolSnapshot } | null => {
  const next = history.redo[history.redo.length - 1];
  if (next === undefined) {
    return null;
  }
  return {
    history: {
      undo: [...history.undo, current].slice(-EDIT_HISTORY_LIMIT),
      redo: history.redo.slice(0, -1),
    },
    snapshot: next,
  };
};

export const canUndo = (history: EditHistory): boolean => history.undo.length > 0;
export const canRedo = (history: EditHistory): boolean => history.redo.length > 0;
