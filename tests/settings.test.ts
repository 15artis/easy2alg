import { describe, expect, it } from "vitest";
import {
  AppSettingsSchema,
  LEFT_RAIL_DEFAULT_WIDTH,
  RIGHT_RAIL_DEFAULT_WIDTH,
  defaultUiSettings,
} from "../src/shared/schemas";

/**
 * 界面偏好（侧栏宽度 / 分组折叠 / 图层配色 / 记住的本地库路径）的持久化契约。
 *
 * 用户 2026-10-16 要求：右侧分组"支持展开与隐藏，需要持久化；导入本地库路径也需要持久化"。
 * 这些都落在 settings.json 的 `ui` 字段里，老配置文件没有这一节 → 必须用默认值补齐，
 * 而不是让读取直接失败。
 */
const minimal = {
  allegroVersion: "17.4",
  libraryDirectory: "E:\\high_clouds\\cadence\\cadencelib",
  setupCompleted: true,
};

describe("ui settings persistence", () => {
  it("fills the ui section with defaults for older config files", () => {
    const settings = AppSettingsSchema.parse(minimal);
    expect(settings.ui).toEqual(defaultUiSettings());
    expect(settings.ui.leftRailWidth).toBe(LEFT_RAIL_DEFAULT_WIDTH);
    expect(settings.ui.rightRailWidth).toBe(RIGHT_RAIL_DEFAULT_WIDTH);
    expect(settings.ui.collapsedSections).toEqual([]);
    expect(settings.ui.layerColors).toEqual({});
    expect(settings.ui.localLibraryPath).toBeNull();
  });

  it("keeps a partial ui section while filling the rest", () => {
    const settings = AppSettingsSchema.parse({
      ...minimal,
      ui: { leftRailWidth: 420, collapsedSections: ["checks"] },
    });
    expect(settings.ui.leftRailWidth).toBe(420);
    expect(settings.ui.collapsedSections).toEqual(["checks"]);
    expect(settings.ui.rightRailWidth).toBe(RIGHT_RAIL_DEFAULT_WIDTH);
  });

  it("round-trips layer colors and the remembered local library path", () => {
    const ui = {
      ...defaultUiSettings(),
      layerColors: { pads: "#ff8800", silkscreen: "#00aa55" },
      localLibraryPath: "E:\\libs\\my.elibz2",
    };
    const settings = AppSettingsSchema.parse({ ...minimal, ui });
    const again = AppSettingsSchema.parse(JSON.parse(JSON.stringify(settings)));
    expect(again.ui.layerColors).toEqual({ pads: "#ff8800", silkscreen: "#00aa55" });
    expect(again.ui.localLibraryPath).toBe("E:\\libs\\my.elibz2");
  });

  it("defaultUiSettings returns a fresh object each call", () => {
    // 共享可变引用会让"改一个器件的图层颜色"污染所有默认值
    const first = defaultUiSettings();
    const second = defaultUiSettings();
    first.collapsedSections.push("checks");
    first.layerColors.pads = "#000000";
    expect(second.collapsedSections).toEqual([]);
    expect(second.layerColors).toEqual({});
  });

  it("clamps rail widths to the allowed range", () => {
    expect(AppSettingsSchema.safeParse({ ...minimal, ui: { leftRailWidth: 10 } }).success).toBe(false);
    expect(AppSettingsSchema.safeParse({ ...minimal, ui: { leftRailWidth: 9999 } }).success).toBe(false);
    expect(AppSettingsSchema.safeParse({ ...minimal, ui: { leftRailWidth: 300 } }).success).toBe(true);
  });
});
