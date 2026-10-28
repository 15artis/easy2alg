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

/**
 * 立创商城商品页「封装」那一栏的写法，净化成 Allegro 能接受的名字。
 *
 * 立创自己的写法里会有括号（`LQFN-56(7x7)`）和小数点（`SOP-8_3.9x4.9mm`），
 * 前者 Allegro 不合法、后者与工具既有约定（`L7_0`）不一致，所以：
 *  - 小数点先换成下划线（`3.9` → `3_9`）
 *  - 其余交给 sanitizeLibraryName（括号等 → `-`，大写，截 31 字符）
 * `LQFN-56(7x7)` → `LQFN-56-7X7`、`SMD5032-6P` → `SMD5032-6P`、`0603` → `0603`。
 * 净化后为空返回 null，调用方退回本地推导。
 */
export const sanitizeLcscPackageName = (raw: string): string | null => {
  const cleaned = sanitizeLibraryName(raw.trim().replace(/\./g, "_"));
  return cleaned.length > 0 ? cleaned : null;
};

/** 片式无源件的尺寸码：0603 / 0402 / 1206 / 1608（公制）… 三到四位纯数字。 */
const CHIP_SIZE_CODE = /^\d{3,4}$/;

/**
 * 简称模式下，**全称本身不长于这个长度就直接用全称**（用户 2026-10-28）。
 *
 * 目的就是别再折腾已经很短的名字：电阻电容的全称是 `R0603` / `C0402`（5 个字符），
 * 立创给的「封装」反而只有 `0603`，照搬会丢掉 R/C 前缀、把两者撞成一个封装名。
 * 有了这条，`R0603` 这类本来就好认的名字不会再被"简称"。
 */
export const COMPACT_NAME_KEEP_FULL_MAX_LENGTH = 10;

/**
 * 简称封装名：优先用立创的「供应商封装」，但片式电阻/电容要带上器件前缀。
 *
 * 立创商城里电阻和电容的「封装」都只写尺寸码（`0603`），光看这个名字没法区分
 * R 和 C —— 两者在 Allegro 里会撞成同一个封装名（用户 2026-10-28：
 * "电容电阻需要使用 R0603 / C0402 不然反倒一起无法区分"）。
 * 好在 EDA 库里的封装名本身带前缀（`R0603` / `C0402`），所以：
 *  - 供应商封装是纯尺寸码、且源封装名是同尺寸的 `R0603` 写法 → 用带前缀的源名
 *  - 其它情况（`SMD5032-6P`、`LQFN-56(7x7)`、`SOT-223`…）→ 直接用供应商封装
 *
 * 返回 null 表示拿不到可用的名字（调用方退回本地推导）。
 */
export const supplierFootprintName = (
  sourceName: string,
  supplierFootprint: string | null | undefined,
): string | null => {
  const supplier = (supplierFootprint ?? "").trim();
  if (supplier.length === 0) {
    return null;
  }
  if (CHIP_SIZE_CODE.test(supplier)) {
    const prefixed = /^([A-Za-z]{1,3})[-_ ]?(\d{3,4})(?:$|[-_])/.exec(sourceName.trim());
    if (prefixed !== null && prefixed[2] === supplier) {
      return sanitizeLcscPackageName(`${prefixed[1]}${supplier}`);
    }
  }
  return sanitizeLcscPackageName(supplier);
};

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

/**
 * 显示 / 落盘用的最终封装名：能规范就规范（小数点→下划线），否则原样返回。
 * 老版本算出来的名字（`L7-0`）或几何推导名（`SOIC127P600X175-8N`）都安全通过。
 */
export const normalizePackageName = (name: string): string =>
  friendlyPackageNameFromSource(name) ?? name;

/**
 * 封装命名风格（用户 2026-10-28 要求在设置里可选）：
 *  - "full"    沿用立创源名结构，小数点换成下划线：
 *              `OSC-SMD_6P-L5_0-W3_2-BL_OA1EL89CEIB112YLC`
 *  - "compact" 只留「贴片 + 本体尺寸码 + 引脚数」：`SMD5032-6P`
 *              （5.0×3.2 mm 本体、6 个焊盘，C41415701 这种有源晶振的常见写法）
 */
export const PACKAGE_NAME_STYLES = ["full", "compact"] as const;
export type PackageNameStyle = (typeof PACKAGE_NAME_STYLES)[number];

/**
 * 本体尺寸 → 四位尺寸码：5.0×3.2 → `5032`、3.2×2.5 → `3225`、1.0×0.8 → `1008`。
 * 就是业界写法（毫米数乘 10 各取两位），不是四舍五入到 0.1 mm 以外的近似。
 */
const smdSizeCode = (lengthMm: number, widthMm: number): string =>
  `${String(Math.round(lengthMm * 10)).padStart(2, "0")}${String(
    Math.round(widthMm * 10),
  ).padStart(2, "0")}`;

/** 源名里的 `L5.0` / `L5-0` / `L5_0` / `L5` 统一成数字。 */
const toMillimeters = (raw: string): number => Number(raw.replace(/[_-]/g, "."));

/** 尺寸数字允许 `.` `-` `_` 三种小数点写法（源名 / 已规范化过的名字都会遇到）。 */
const DIMENSION = String.raw`(\d+(?:[._-]\d+)?)`;

/**
 * 简写封装名：`OSC-SMD_6P-L5.0-W3.2-BL_OA1EL89CEIB112YLC` → `SMD5032-6P`。
 *
 * 只认立创那种「`SMD_<n>P-L<长>-W<宽>`」的写法 —— 这类封装的源名里塞了厂商料号，
 * 又长又没法读（Allegro 侧历史上限 31 字符，`OSC-SMD_6P-L5_0-W3_2-BL_OA1EL89CEIB112YLC`
 * 早就超了）。其它族（QFN/SOIC/SOT…）的源名本身就有信息量，返回 null 走完整名，
 * 别硬压成猜的。引脚数缺省时用焊盘数兜底。
 */
export const compactPackageNameFromSource = (
  sourceName: string,
  padCount?: number,
): string | null => {
  const withPins = new RegExp(
    String.raw`SMD[_-]?(\d+)P[_-]L${DIMENSION}[_-]W${DIMENSION}`,
    "i",
  ).exec(sourceName);
  const bodyOnly =
    withPins === null
      ? new RegExp(String.raw`SMD[_-]?L${DIMENSION}[_-]W${DIMENSION}`, "i").exec(sourceName)
      : null;
  if (withPins === null && bodyOnly === null) {
    return null;
  }
  const declaredPins = withPins === null ? null : Number(withPins[1]);
  const pins = declaredPins !== null && declaredPins > 0 ? declaredPins : (padCount ?? 0);
  if (!Number.isFinite(pins) || pins <= 0) {
    return null;
  }
  const lengthRaw = withPins === null ? bodyOnly![1] : withPins[2];
  const widthRaw = withPins === null ? bodyOnly![2] : withPins[3];
  const length = toMillimeters(lengthRaw);
  const width = toMillimeters(widthRaw);
  if (!Number.isFinite(length) || !Number.isFinite(width) || length <= 0 || width <= 0) {
    return null;
  }
  // 尺寸码按源名的 L→W 顺序写（5.0×3.2 → 5032、3.2×2.5 → 3225），不做长短边重排：
  // 名字怎么写的就怎么转，用户能自己对上号。
  return `SMD${smdSizeCode(length, width)}-${Math.round(pins)}P`;
};
