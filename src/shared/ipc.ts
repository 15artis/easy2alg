import type {
  AllegroInstall,
  AppApiInfo,
  AppSettings,
  ConversionPlan,
  ConversionResult,
  GenerationProgress,
  HistoryEntry,
  LocalLibraryDeviceSummary,
  NormalizedFootprint,
  NormalizedSymbol,
  OlbWriteResult,
  UiSettingsPatch,
} from "./schemas";

export type OlbWriteRequest = {
  readonly symbol: NormalizedSymbol;
  /** 目标 .olb 绝对路径；null = 未指定，由主进程在封装库目录下自动新建 */
  readonly libraryPath: string | null;
  /** 未指定时的库文件名来源（一般取 .elibz2 文件名） */
  readonly libraryName: string;
};

export type Easy2AlgApi = {
  getAppInfo: () => Promise<AppApiInfo>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  /**
   * 只更新界面偏好（侧栏宽度 / 分组折叠 / 图层配色）—— 不重跑 Allegro 探测，
   * 所以拖动侧栏时不卡。返回合并后的完整设置。
   */
  saveUiSettings: (patch: UiSettingsPatch) => Promise<AppSettings>;
  chooseLibraryDirectory: () => Promise<string | null>;
  chooseAllegroExecutable: () => Promise<AllegroInstall | null>;
  detectAllegro: () => Promise<AllegroInstall[]>;
  fetchComponent: (lcscId: string) => Promise<NormalizedFootprint>;
  /** 立创编号链路的原理图符号（同一份接口响应里的 dataStr）；没有符号时返回 null。 */
  fetchSymbol: (lcscId: string) => Promise<NormalizedSymbol | null>;
  chooseLocalLibraryFile: () => Promise<string | null>;
  readLocalLibrary: (filePath: string) => Promise<readonly LocalLibraryDeviceSummary[]>;
  fetchLocalComponent: (filePath: string, deviceUuid: string) => Promise<NormalizedFootprint>;
  fetchLocalSymbol: (filePath: string, deviceUuid: string) => Promise<NormalizedSymbol | null>;
  chooseOlbLibrary: () => Promise<string | null>;
  createOlbLibrary: (suggestedName: string) => Promise<string | null>;
  writeOlb: (request: OlbWriteRequest) => Promise<OlbWriteResult>;
  createPlan: (footprint: NormalizedFootprint) => Promise<ConversionPlan>;
  generate: (plan: ConversionPlan) => Promise<ConversionResult>;
  onGenerationProgress: (listener: (progress: GenerationProgress) => void) => () => void;
  getHistory: () => Promise<HistoryEntry[]>;
  openPath: (absolutePath: string) => Promise<void>;
};

export const IpcChannels = {
  getAppInfo: "app:get-info",
  getSettings: "settings:get",
  saveSettings: "settings:save",
  saveUiSettings: "settings:save-ui",
  chooseLibraryDirectory: "dialog:choose-library-directory",
  chooseAllegroExecutable: "dialog:choose-allegro-executable",
  detectAllegro: "allegro:detect",
  fetchComponent: "easyeda:fetch-component",
  fetchSymbol: "easyeda:fetch-symbol",
  chooseLocalLibraryFile: "dialog:choose-local-library",
  readLocalLibrary: "local-library:read",
  fetchLocalComponent: "local-library:fetch-component",
  fetchLocalSymbol: "local-library:fetch-symbol",
  chooseOlbLibrary: "dialog:choose-olb-library",
  createOlbLibrary: "dialog:create-olb-library",
  writeOlb: "olb:write",
  createPlan: "conversion:create-plan",
  generate: "conversion:generate",
  generationProgress: "conversion:progress",
  getHistory: "history:get",
  openPath: "shell:open-path",
} as const;
