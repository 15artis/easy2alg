import type { ConversionPlan, QueueItem } from "../../shared/schemas";

/**
 * 「这个队列项现在能不能拿去生成」——**全应用唯一判据**。
 *
 * 生成按钮的可用性和 `generateSelected()` 真正挑的目标必须共用它。
 * 历史上两者是分开写的：
 *   按钮  → state ∈ {ready, warning, generationFailed}
 *   目标  → footprint ≠ null && plans[id] ≠ undefined
 * 结果：器件一旦生成成功进入 `generated` 态，就从按钮的 state 白名单里掉出去，
 * 按钮变灰、点不动，而且**没有任何路径能回到可生成状态**（用户 2026-10-16 反馈
 * 「第一次点击生成正常，之后按键没有反应」）。两套判据还留下"按钮亮着但
 * targets 为空、点击静默 return"的可能，这里一并消除。
 */
export const isRunnable = (
  item: QueueItem,
  plans: Readonly<Record<string, ConversionPlan>>,
): boolean => item.selected && item.footprint !== null && plans[item.id] !== undefined;

export const selectRunnableItems = (
  queue: readonly QueueItem[],
  plans: Readonly<Record<string, ConversionPlan>>,
): readonly QueueItem[] => queue.filter((item) => isRunnable(item, plans));

/** 按钮文案用：是否所有可生成项都已经生成过了（决定显示「重新生成并验证」）。 */
export const shouldOfferRegeneration = (
  runnableItems: readonly QueueItem[],
): boolean =>
  runnableItems.length > 0 &&
  runnableItems.every((item) => item.state === "generated");
