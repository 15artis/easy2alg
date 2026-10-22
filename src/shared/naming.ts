/**
 * 命名净化：Allegro 与 Capture 的库名/器件名都只接受 ASCII 字母数字与 _ -，
 * 且 Allegro 侧历史上限 31 字符（见 main/conversion/naming.ts 的 IPC_MAX_NAME_LENGTH）。
 * 用户可以在界面上直接改名，这里统一净化一遍，保证预览显示的就是最终写入的名字。
 */
export const LIBRARY_NAME_MAX_LENGTH = 31;

export const sanitizeLibraryName = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, LIBRARY_NAME_MAX_LENGTH);

/** 输入框里正在编辑的中间态（还没净化），用来判断"是否等于原值"。 */
export const isNameEdited = (value: string, original: string): boolean =>
  value.trim().length > 0 && sanitizeLibraryName(value) !== original;

export const friendlyPackageNameFromSource = (sourceName: string): string | null => {
  // 只处理立创那种"本体尺寸"格式（同时带 L… 与 W… 段）：
  // `LQFN-56_L7.0-W7.0-P0.4-EP`。像 `SOIC-8_3.9x4.9mm_P1.27mm` 这种描述式名字
  // 交给几何推导（SOIC127P600X175-8N 更规范），别把 `4.9mm` 弄成 `4_9mm`。
  const hasBodyDims =
    /(?:^|[-_\s])L\d+(?:[.-]\d+)?/i.test(sourceName) &&
    /(?:^|[-_\s])W\d+(?:[.-]\d+)?/i.test(sourceName);
  if (!hasBodyDims) {
    return null;
  }
  // 尺寸段形如 L7.0 / L7-0 / P0.50 / EP5.1：字母(1-2) + 数字 + 分隔符 + 数字
  // 统一把分隔符换成下划线（`.` 在 Allegro 名字里不合法，`-` 会与封装类型的连字符混淆）
  let transformed = 0;
  const normalized = sourceName
    .trim()
    .replace(/([A-Za-z]{1,2}\d+)[.\-_](\d+)(?![\d.])/g, (_match, head: string, tail: string) => {
      transformed += 1;
      return `${head}_${tail}`;
    });
  if (transformed === 0) {
    return null;
  }
  const name = normalized
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return name.length > 0 ? name : null;
};
