import type { NormalizedSymbolSection } from "./schemas";

/**
 * 引脚名去重（用户 2026-10-19 要求：Cadence 侧不接受重复的引脚文本）。
 *
 * 立创的符号里 GND / VCC 常常同名的引脚有好几个（实测 C2866150：49 脚里 GND ×6、
 * VCC ×2、VCCOA ×2、VCCOB ×2）。这里给**第二个及以后**的同名引脚拼上引脚号
 * （引脚号在本段内唯一，天然不冲突），第一个保持原名不动：
 *
 *   GND(#2) → GND        GND(#8) → GND_8        GND(#13) → GND_13
 *
 * 归一化放在解析阶段（两条链路都过），所以**预览里看到的名字就是写进 .olb 的名字**，
 * 不会出现"预览一套、Capture 另一套"。引脚号本身不重复，段内唯一性不受影响。
 */
export const dedupePinNames = (section: NormalizedSymbolSection): NormalizedSymbolSection => {
  const used = new Set<string>();
  let changed = false;
  const pins = section.pins.map((pin) => {
    const name = pin.name.trim();
    if (name.length === 0) {
      return pin;
    }
    if (!used.has(name)) {
      used.add(name);
      return pin;
    }
    let candidate = `${name}_${pin.number}`;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${name}_${pin.number}_${counter}`;
      counter += 1;
    }
    used.add(candidate);
    changed = true;
    return { ...pin, name: candidate };
  });
  return changed ? { ...section, pins } : section;
};
