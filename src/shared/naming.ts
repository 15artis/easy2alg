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
