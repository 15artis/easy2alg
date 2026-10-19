import type { NormalizedSymbolSection } from "./schemas";

/**
 * 引脚名去重（用户 2026-10-19 要求：Cadence 侧不接受重复的引脚文本）。
 *
 * 立创的符号里 GND / VCC 常常同名的引脚有好几个（实测 C2866150：49 脚里 GND ×6、
 * VCC ×2、VCCOA ×2、VCCOB ×2）。
 *
 * 规则：**只要这个名字出现两次以上，所有同名引脚都拼上自己的引脚号**；
 * 名字唯一的引脚保持原样。引脚号在本段内唯一，所以拼出来天然不冲突。
 *
 *   GND(#13) → GND_13     GND(#18) → GND_18     GND(#24) → GND_24
 *   VCC(#15) → VCC_15     VCC(#42) → VCC_42
 *   OSCin(#16) → OSCin（唯一，不动）
 *
 * 之前只给"第二个起"加后缀，结果第一个仍叫 GND —— 用户反馈"13 脚 GND 不是 GND_13"
 * （2026-10-19），所以改成全量加。
 *
 * 归一化放在解析阶段、且**在标签避让之前**：避让按引脚名字宽算竖带深度，
 * 必须用最终名字；预览与写库也因此看到同一份结果。
 */
export const dedupePinNames = (section: NormalizedSymbolSection): NormalizedSymbolSection => {
  // ① 先按原始名字统计，判断哪些名字是重复的
  const counts = new Map<string, number>();
  for (const pin of section.pins) {
    const name = pin.name.trim();
    if (name.length === 0) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  // ② 重复的名字统一拼引脚号；拼出来若撞上别的引脚名，再补序号
  const used = new Set<string>();
  let changed = false;
  const pins = section.pins.map((pin) => {
    const name = pin.name.trim();
    if (name.length === 0) {
      return pin;
    }
    const duplicated = (counts.get(name) ?? 0) > 1;
    let candidate = duplicated ? `${name}_${pin.number}` : name;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${name}_${pin.number}_${counter}`;
      counter += 1;
    }
    used.add(candidate);
    if (candidate === pin.name) {
      return pin;
    }
    changed = true;
    return { ...pin, name: candidate };
  });
  return changed ? { ...section, pins } : section;
};
