import { join } from "node:path";
import type { AppSettings } from "../../shared/schemas";

/**
 * 输出目录布局（用户 2026-10-19 / 2026-10-28 两次要求）：
 *  - split（默认）：库目录下分 padstacks/ 与 symbols/，.olb 放 schlib/；
 *  - unified：焊盘、封装、.olb 全部直接放库目录，Allegro 的库路径指到库目录即可；
 *  - perFootprint：每个封装一个 `<库目录>/<封装名>/`，焊盘、封装、.olb 都放进去。
 *
 * 用三态而不是两个布尔：两个开关同时勾上时无法判断该放哪。设置读取阶段已经
 * 让 perFootprint 优先并把 unified 归零（见 schemas.ts），这里只做映射。
 */
export type OutputLayout = "split" | "unified" | "perFootprint";

export const outputLayoutOf = (
  settings: Pick<AppSettings, "unifiedLibraryFolder" | "perFootprintFolder">,
): OutputLayout =>
  settings.perFootprintFolder
    ? "perFootprint"
    : settings.unifiedLibraryFolder
      ? "unified"
      : "split";

/**
 * 封装名 → 可做文件夹名的字符串。
 *
 * 封装名来自立创/EasyEDA，可能带 `-`、`.`、`/`（如 `TFBGA-100_L8.0-W8.0-P0.80`），
 * 前两者留着无妨，`/` 与中文会被替换成 `_`。空结果退回 easy2alg，避免算出空路径。
 */
export const safeFolderName = (name: string): string => {
  const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe.length > 0 ? safe : "easy2alg";
};

/** 焊盘（.pad/.ssm）落点。 */
export const padstackDirectoryFor = (
  layout: OutputLayout,
  libraryDirectory: string,
  packageName: string,
): string => {
  if (layout === "unified") {
    // 走一次 join 只是为了让分隔符规范化（D:/lib → D:\lib），调用方拿到的是同一个目录
    return join(libraryDirectory);
  }
  return layout === "perFootprint"
    ? join(libraryDirectory, safeFolderName(packageName))
    : join(libraryDirectory, "padstacks");
};

/** 封装（.dra/.psm）落点。 */
export const symbolDirectoryFor = (
  layout: OutputLayout,
  libraryDirectory: string,
  packageName: string,
): string => {
  if (layout === "unified") {
    return join(libraryDirectory);
  }
  return layout === "perFootprint"
    ? join(libraryDirectory, safeFolderName(packageName))
    : join(libraryDirectory, "symbols");
};

/**
 * 未指定 .olb 路径时的默认落点。
 *
 * perFootprint 用**封装名**而不是源库名做文件夹与文件名：用户要求"文件夹名以
 * 封装名为准"，这样 `<库>/<封装名>/<封装名>.olb` 自成一套，拷走即用。
 */
export const autoLibraryPath = (
  libraryDirectory: string,
  packageName: string,
  layout: OutputLayout = "split",
): string => {
  const safe = safeFolderName(packageName);
  const fileName = `${safe}.olb`;
  if (layout === "unified") {
    return join(libraryDirectory, fileName);
  }
  return layout === "perFootprint"
    ? join(libraryDirectory, safe, fileName)
    : join(libraryDirectory, "schlib", fileName);
};
