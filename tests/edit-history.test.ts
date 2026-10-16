import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  EDIT_HISTORY_LIMIT,
  EMPTY_EDIT_HISTORY,
  pushUndo,
  redoOnce,
  undoOnce,
} from "../src/shared/edit-history";
import { accumulateOffset, symbolShapeKey, type SymbolEdits } from "../src/shared/symbol-edit";

/**
 * 撤销栈（用户 2026-10-16 要求"编辑支持退回步骤"）。
 * 快照语义：每次编辑前把当时的 SymbolEdits 压栈，"退回"就是把旧快照放回去。
 */
const step = (edits: SymbolEdits, key: string, dx: number, dy: number): SymbolEdits =>
  accumulateOffset(edits, key, dx, dy);

describe("edit history（撤销 / 重做）", () => {
  const key = symbolShapeKey(0, 1);

  it("空栈退不动也重做不了", () => {
    expect(canUndo(EMPTY_EDIT_HISTORY)).toBe(false);
    expect(canRedo(EMPTY_EDIT_HISTORY)).toBe(false);
    expect(undoOnce(EMPTY_EDIT_HISTORY, {})).toBeNull();
    expect(redoOnce(EMPTY_EDIT_HISTORY, {})).toBeNull();
  });

  it("退回一步恢复编辑前的状态，并把当前状态交给重做栈", () => {
    const v0: SymbolEdits = {};
    const v1 = step(v0, key, 5, 5);
    const v2 = step(v1, key, 3, 0);

    let history = pushUndo(EMPTY_EDIT_HISTORY, v0);
    history = pushUndo(history, v1);
    expect(history.undo.length).toBe(2);

    const back = undoOnce(history, v2);
    expect(back?.edits).toEqual(v1);
    expect(canRedo(back!.history)).toBe(true);

    const back2 = undoOnce(back!.history, back!.edits);
    expect(back2?.edits).toEqual(v0);
    expect(canUndo(back2!.history)).toBe(false);
    expect(undoOnce(back2!.history, back2!.edits)).toBeNull();
  });

  it("重做是退回的对称操作（来回一趟回到原点）", () => {
    const v0: SymbolEdits = {};
    const v1 = step(v0, key, 10, 0);
    const history = pushUndo(EMPTY_EDIT_HISTORY, v0);

    const back = undoOnce(history, v1);
    expect(back?.edits).toEqual(v0);
    const forward = redoOnce(back!.history, back!.edits);
    expect(forward?.edits).toEqual(v1);
    expect(forward?.history.undo.length).toBe(1);
    expect(canRedo(forward!.history)).toBe(false);
  });

  it("新的编辑让重做栈作废（避免重做跳到一条已经走岔的路上）", () => {
    const v0: SymbolEdits = {};
    const v1 = step(v0, key, 1, 1);
    const undone = undoOnce(pushUndo(EMPTY_EDIT_HISTORY, v0), v1)!;
    expect(canRedo(undone.history)).toBe(true);

    const fresh = pushUndo(undone.history, {});
    expect(canRedo(fresh)).toBe(false);
    expect(fresh.redo).toEqual([]);
  });

  it("超过上限丢最老的一步（长按方向键/反复拖动也不会无限涨）", () => {
    let history = EMPTY_EDIT_HISTORY;
    for (let i = 0; i < EDIT_HISTORY_LIMIT + 20; i += 1) {
      history = pushUndo(history, { [key]: { kind: "offset", dx: i, dy: 0 } });
    }
    expect(history.undo.length).toBe(EDIT_HISTORY_LIMIT);
    // 最老的那批被丢掉，栈顶是最后压进去的
    expect(history.undo[history.undo.length - 1]).toEqual({
      [key]: { kind: "offset", dx: EDIT_HISTORY_LIMIT + 19, dy: 0 },
    });
  });

  it("栈里存的是快照引用，退回后可以直接喂给预览/写库", () => {
    const v0: SymbolEdits = {};
    const v1 = step(v0, key, 7, -2);
    const history = pushUndo(EMPTY_EDIT_HISTORY, v0);
    const back = undoOnce(history, v1);
    expect(back?.edits).toBe(v0);
  });
});
