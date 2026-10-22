import type { NormalizedSymbolSection } from "./schemas";
import { isSymbolPinKey, parseSymbolEditKey } from "./symbol-edit";
import {
  anchorLabelBox,
  pinSideOf,
  symbolElementBox,
  type SymbolBox,
} from "./symbol-labels";

/**
 * 对齐 / 分布（用户 2026-10-20，参考 OrCAD/Visio 的对齐工具）。
 *
 * 纯函数：只算"每个元素该位移多少"，不碰编辑模型。App 把结果 reduce 成
 * `accumulateOffset`，一次性写入 = 一个撤销点。
 *
 * 基准取**选择集整体包围盒**（不是某个"主元素"）：多选时最直观，
 * 也不会因为选中顺序不同而结果不同。
 */

export type AlignMode = "left" | "right" | "top" | "bottom" | "centerX" | "centerY";
export type DistributeMode = "horizontal" | "vertical";
export type Offset = { readonly dx: number; readonly dy: number };
export type OffsetMap = ReadonlyMap<string, Offset>;

const unionBox = (a: SymbolBox, b: SymbolBox): SymbolBox => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
});

/**
 * 引脚参与对齐时用**标签盒**（名字 + 脚号），而不是整根引脚（用户 2026-10-22）。
 * 引脚本体不能离开边框，所以对齐只挪标签；基准也要按标签算，否则对出来的位置
 * 跟眼睛看到的文字对不上。
 */
export const pinAlignBox = (
  section: NormalizedSymbolSection,
  key: string,
): SymbolBox | null => {
  if (!isSymbolPinKey(key)) {
    return null;
  }
  const { index } = parseSymbolEditKey(key);
  const pin = section.pins[index];
  if (pin === undefined) {
    return null;
  }
  if (pin.labelAnchor === undefined) {
    return symbolElementBox(section, key);
  }
  const side = pinSideOf(pin);
  const rotated = side === "top" || side === "bottom";
  return unionBox(
    anchorLabelBox(pin.labelAnchor.name, pin.name, rotated, side === "right"),
    anchorLabelBox(pin.labelAnchor.number, pin.number, rotated, side === "left"),
  );
};

export const collectBoxes = (
  section: NormalizedSymbolSection,
  keys: readonly string[],
): ReadonlyMap<string, SymbolBox> => {
  const boxes = new Map<string, SymbolBox>();
  for (const key of keys) {
    // 引脚按标签盒参与对齐（本体不动）
    const box = isSymbolPinKey(key) ? pinAlignBox(section, key) : symbolElementBox(section, key);
    if (box !== null) {
      boxes.set(key, box);
    }
  }
  return boxes;
};

const unionOf = (boxes: Iterable<SymbolBox>): SymbolBox | null => {
  let result: SymbolBox | null = null;
  for (const box of boxes) {
    result =
      result === null
        ? box
        : {
            minX: Math.min(result.minX, box.minX),
            minY: Math.min(result.minY, box.minY),
            maxX: Math.max(result.maxX, box.maxX),
            maxY: Math.max(result.maxY, box.maxY),
          };
  }
  return result;
};

/** 每一种对齐各自需要的位移；至少两个盒子才有意义。 */
export const planAlign = (boxes: ReadonlyMap<string, SymbolBox>, mode: AlignMode): OffsetMap => {
  const reference = unionOf(boxes.values());
  if (reference === null || boxes.size < 2) {
    return new Map();
  }
  const offsets = new Map<string, Offset>();
  for (const [key, box] of boxes) {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case "left":
        dx = reference.minX - box.minX;
        break;
      case "right":
        dx = reference.maxX - box.maxX;
        break;
      case "top":
        dy = reference.minY - box.minY;
        break;
      case "bottom":
        dy = reference.maxY - box.maxY;
        break;
      case "centerX":
        dx = (reference.minX + reference.maxX) / 2 - (box.minX + box.maxX) / 2;
        break;
      default:
        dy = (reference.minY + reference.maxY) / 2 - (box.minY + box.maxY) / 2;
        break;
    }
    if (dx !== 0 || dy !== 0) {
      offsets.set(key, { dx, dy });
    }
  }
  return offsets;
};

/**
 * 分布：首尾固定，中间的**中心点**按等间距重排（最少 3 个）。
 * 比"边到边留白相等"更稳：元素尺寸不同时不会因为宽度差导致视觉不匀。
 */
export const planDistribute = (
  boxes: ReadonlyMap<string, SymbolBox>,
  mode: DistributeMode,
): OffsetMap => {
  if (boxes.size < 3) {
    return new Map();
  }
  const horizontal = mode === "horizontal";
  const centerOf = (box: SymbolBox): number =>
    horizontal ? (box.minX + box.maxX) / 2 : (box.minY + box.maxY) / 2;

  const ordered = [...boxes.entries()].sort((a, b) => centerOf(a[1]) - centerOf(b[1]));
  const first = centerOf(ordered[0][1]);
  const last = centerOf(ordered[ordered.length - 1][1]);
  const step = (last - first) / (ordered.length - 1);
  const offsets = new Map<string, Offset>();
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const [key, box] = ordered[index];
    const target = first + step * index;
    const delta = target - centerOf(box);
    if (Math.abs(delta) > 1e-9) {
      offsets.set(key, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
    }
  }
  return offsets;
};

/** 工具栏下拉的取值 → 执行计划（App 只负责把 offsets 写进编辑模型）。 */
export const planLayoutAction = (
  boxes: ReadonlyMap<string, SymbolBox>,
  action: string,
): OffsetMap => {
  const [kind, value] = action.split(":");
  if (kind === "align") {
    return planAlign(boxes, value as AlignMode);
  }
  if (kind === "distribute") {
    return planDistribute(boxes, value as DistributeMode);
  }
  return new Map();
};
