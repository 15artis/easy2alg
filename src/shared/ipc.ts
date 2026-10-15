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
} from "./schemas";

export type Easy2AlgApi = {
  getAppInfo: () => Promise<AppApiInfo>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  chooseLibraryDirectory: () => Promise<string | null>;
  chooseAllegroExecutable: () => Promise<AllegroInstall | null>;
  detectAllegro: () => Promise<AllegroInstall[]>;
  fetchComponent: (lcscId: string) => Promise<NormalizedFootprint>;
  chooseLocalLibraryFile: () => Promise<string | null>;
  readLocalLibrary: (filePath: string) => Promise<readonly LocalLibraryDeviceSummary[]>;
  fetchLocalComponent: (filePath: string, deviceUuid: string) => Promise<NormalizedFootprint>;
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
  chooseLibraryDirectory: "dialog:choose-library-directory",
  chooseAllegroExecutable: "dialog:choose-allegro-executable",
  detectAllegro: "allegro:detect",
  fetchComponent: "easyeda:fetch-component",
  chooseLocalLibraryFile: "dialog:choose-local-library",
  readLocalLibrary: "local-library:read",
  fetchLocalComponent: "local-library:fetch-component",
  createPlan: "conversion:create-plan",
  generate: "conversion:generate",
  generationProgress: "conversion:progress",
  getHistory: "history:get",
  openPath: "shell:open-path",
} as const;
