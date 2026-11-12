import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  EDIT_HISTORY_LIMIT,
  EMPTY_ADDED_ITEMS,
  EMPTY_EDIT_HISTORY,
  EMPTY_SYMBOL_SNAPSHOT,
  pushUndo,
  redoOnce,
  sameSnapshot,
  undoOnce,
  type SymbolSnapshot,
} from "../src/shared/edit-history";
import {
  accumulateOffset,
  EMPTY_SYMBOL_EDITS,
  symbolShapeKey,
  type AddedSymbolItem,
  type SymbolEdits,
} from "../src/shared/symbol-edit";

/**
 * 撤销栈（用户 2026-10-16 要求"编辑支持退回步骤"）。
 * 快照 = SymbolEdits + addedItems（用户 2026-11-11：手画的图形也要能撤销）。
 */
const shape = (edits: SymbolEdits, key: string, dx: number, dy: number): SymbolEdits =>
  accumulateOffset(edits, key, dx, dy);

const snap = (
  symbolEdits: SymbolEdits,
  addedItems: readonly AddedSymbolItem[] = EMPTY_ADDED_ITEMS,
): SymbolSnapshot => ({ symbolEdits, addedItems });

const line: AddedSymbolItem = {
  kind: "line",
  id: "d1",
  section: 0,
  from: { x: 0, y: 0 },
  to: { x: 10, y: 0 },
};

describe("edit history（撤销 / 重做）", () => {
  const key = symbolShapeKey(0, 1);

  it("空栈退不动也重做不了", () => {
    expect(canUndo(EMPTY_EDIT_HISTORY)).toBe(false);
    expect(canRedo(EMPTY_EDIT_HISTORY)).toBe(false);
    expect(undoOnce(EMPTY_EDIT_HISTORY, EMPTY_SYMBOL_SNAPSHOT)).toBeNull();
    expect(redoOnce(EMPTY_EDIT_HISTORY, EMPTY_SYMBOL_SNAPSHOT)).toBeNull();
  });

  it("退回一步恢复编辑前的状态，并把当前状态交给重做栈", () => {
    const v0 = snap({});
    const v1 = snap(shape({}, key, 5, 5));
    const v2 = snap(shape(v1.symbolEdits, key, 3, 0));

    let history = pushUndo(EMPTY_EDIT_HISTORY, v0);
    history = pushUndo(history, v1);
    expect(history.undo.length).toBe(2);

    const back = undoOnce(history, v2);
    expect(back?.snapshot).toEqual(v1);
    expect(canRedo(back!.history)).toBe(true);

    const back2 = undoOnce(back!.history, back!.snapshot);
    expect(back2?.snapshot).toEqual(v0);
    expect(canUndo(back2!.history)).toBe(false);
    expect(undoOnce(back2!.history, back2!.snapshot)).toBeNull();
  });

  it("重做是退回的对称操作（来回一趟回到原点）", () => {
    const v0 = snap({});
    const v1 = snap(shape({}, key, 10, 0));
    const history = pushUndo(EMPTY_EDIT_HISTORY, v0);

    const back = undoOnce(history, v1);
    expect(back?.snapshot).toEqual(v0);
    const forward = redoOnce(back!.history, back!.snapshot);
    expect(forward?.snapshot).toEqual(v1);
    expect(forward?.history.undo.length).toBe(1);
    expect(canRedo(forward!.history)).toBe(false);
  });

  it("新的编辑让重做栈作废（避免重做跳到一条已经走岔的路上）", () => {
    const v0 = snap({});
    const v1 = snap(shape({}, key, 1, 1));
    const undone = undoOnce(pushUndo(EMPTY_EDIT_HISTORY, v0), v1)!;
    expect(canRedo(undone.history)).toBe(true);

    const fresh = pushUndo(undone.history, snap({}));
    expect(canRedo(fresh)).toBe(false);
    expect(fresh.redo).toEqual([]);
  });

  it("超过上限丢最老的一步（长按方向键/反复拖动也不会无限涨）", () => {
    let history = EMPTY_EDIT_HISTORY;
    for (let i = 0; i < EDIT_HISTORY_LIMIT + 20; i += 1) {
      history = pushUndo(history, snap({ [key]: { offset: { dx: i, dy: 0 } } }));
    }
    expect(history.undo.length).toBe(EDIT_HISTORY_LIMIT);
    // 最老的那批被丢掉，栈顶是最后压进去的
    expect(history.undo[history.undo.length - 1]).toEqual(
      snap({ [key]: { offset: { dx: EDIT_HISTORY_LIMIT + 19, dy: 0 } } }),
    );
  });

  it("栈里存的是快照引用，退回后可以直接喂给预览/写库", () => {
    const v0 = snap({});
    const v1 = snap(shape({}, key, 7, -2));
    const history = pushUndo(EMPTY_EDIT_HISTORY, v0);
    const back = undoOnce(history, v1);
    expect(back?.snapshot).toBe(v0);
  });

  it("新增元素也在快照里：退回能把手画的线段撤掉", () => {
    const before = snap({});
    const after = snap({}, [line]);
    const history = pushUndo(EMPTY_EDIT_HISTORY, before);

    const back = undoOnce(history, after);
    expect(back?.snapshot.addedItems).toEqual([]);
    // 只回滚 symbolEdits 的话这里会是 [line] —— Ctrl+Z 撤不掉刚画的东西
    expect(back?.snapshot.symbolEdits).toEqual({});

    const forward = redoOnce(back!.history, back!.snapshot);
    expect(forward?.snapshot.addedItems).toEqual([line]);
  });

  it("同一份状态的引用比较为真（避免每次点击都攒撤销点）", () => {
    expect(sameSnapshot(EMPTY_SYMBOL_SNAPSHOT, snap(EMPTY_SYMBOL_EDITS))).toBe(true);
    expect(sameSnapshot(EMPTY_SYMBOL_SNAPSHOT, snap(EMPTY_SYMBOL_EDITS, [line]))).toBe(false);
    // 空对象另起一份就不是同一个引用了 —— 这正是要避免"每次都算改过"的原因
    expect(sameSnapshot(EMPTY_SYMBOL_SNAPSHOT, { symbolEdits: {}, addedItems: EMPTY_ADDED_ITEMS })).toBe(false);
  });
});
