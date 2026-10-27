import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { electronApp, is } from "@electron-toolkit/utils";
import { z } from "zod";
import { AllegroDetector } from "./connectors/allegro-detector";
import { resolveAllegroInstall } from "./connectors/allegro-selection";
import { EasyEdaConnector } from "./connectors/easyeda-connector";
import { Elibz2Connector } from "./connectors/elibz2-connector";
import { JsonStore } from "./connectors/json-store";
import { AllegroRunner } from "./connectors/allegro-runner";
import {
  autoLibraryPath,
  resolveCaptureToolchain,
  writeCaptureLibrary,
} from "./connectors/capture-writer";
import { createConversionPlan } from "./conversion/validate";
import { configureLogging, writeLog } from "./logging";
import { lastWindowCloseAction } from "./lifecycle";
import { IpcChannels } from "../shared/ipc";
import { KNOWN_ALLEGRO_VERSIONS } from "../shared/allegro-version";
import { AllegroExecutionError } from "../shared/errors";
import {
  AppSettingsSchema,
  ConversionPlanSchema,
  HistoryEntrySchema,
  NormalizedFootprintSchema,
  NormalizedSymbolSchema,
  type AllegroInstall,
  type AppSettings,
  type GenerationProgress,
  type HistoryEntry,
  UiSettingsSchema,
  defaultUiSettings,
} from "../shared/schemas";

const HistorySchema = z.array(HistoryEntrySchema);
const OlbWriteRequestSchema = z.object({
  symbol: NormalizedSymbolSchema,
  libraryPath: z.string().min(1).nullable(),
  libraryName: z.string().min(1),
  confirmOverwrite: z.boolean().optional(),
  snapPins: z.boolean().optional(),
  // 界面按「全局开关 && 勾了 PCB 封装」算好再传（用户 2026-10-23）
  fillPcbFootprint: z.boolean().optional(),
});

const defaultSettings = (): AppSettings => ({
  // 默认值跟着已知最新版本走（当前 25.1）；机器上实际装了哪个版本由首次启动的
  // 检测结果覆盖，这里只是没有检测结果时的占位。
  allegroVersion: KNOWN_ALLEGRO_VERSIONS[0],
  libraryDirectory: join(app.getPath("documents"), "AllegroLibrary"),
  setupCompleted: false,
  allegroExecutablePath: null,
  olbLibraryPath: null,
  unifiedLibraryFolder: false,
  fillPcbFootprint: true,
  ui: defaultUiSettings(),
});

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: "#f4f5f7",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });
  window.on("ready-to-show", () => window.show());
  if (is.dev && process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return window;
};

const registerHandlers = (): void => {
  const dataDirectory = app.getPath("userData");
  configureLogging(join(dataDirectory, "logs", "application.jsonl"));
  const settingsStore = new JsonStore(
    join(dataDirectory, "settings.json"),
    AppSettingsSchema,
    defaultSettings(),
  );
  const historyStore = new JsonStore<HistoryEntry[]>(
    join(dataDirectory, "history.json"),
    HistorySchema,
    [],
  );
  const easyEda = new EasyEdaConnector(join(dataDirectory, "cache", "footprints"));
  const elibz2 = new Elibz2Connector();
  const detector = new AllegroDetector();
  const runner = new AllegroRunner();

  ipcMain.handle(IpcChannels.getAppInfo, () => ({
    platform: process.platform,
    appVersion: app.getVersion(),
  }));
  ipcMain.handle(IpcChannels.getSettings, () => settingsStore.read());
  ipcMain.handle(IpcChannels.saveSettings, (_event, rawSettings: unknown) =>
    settingsStore.write(AppSettingsSchema.parse(rawSettings)),
  );
  ipcMain.handle(IpcChannels.chooseLibraryDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 Allegro 库目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IpcChannels.detectAllegro, async () => {
    const settings = await settingsStore.read();
    const detected = await detector.detect();
    if (settings.allegroExecutablePath === null) {
      return detected;
    }
    // 手动选的路径可能已经被卸载 / 判不出版本：探测结果照常返回，别让整页启动失败
    let manualInstall: AllegroInstall | null = null;
    try {
      manualInstall = await detector.inspectExecutable(settings.allegroExecutablePath, null);
    } catch (error) {
      await writeLog("warn", "allegro_manual_probe_failed", {
        executablePath: settings.allegroExecutablePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return manualInstall === null
      ? detected
      : [
          manualInstall,
          ...detected.filter(
            (install) =>
              install.executablePath.toLowerCase() !==
              manualInstall.executablePath.toLowerCase(),
          ),
        ];
  });
  ipcMain.handle(IpcChannels.chooseAllegroExecutable, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 Allegro 程序",
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [{ name: "Allegro", extensions: ["exe"] }]
          : [{ name: "Allegro", extensions: ["*"] }],
    });
    if (result.canceled || result.filePaths[0] === undefined) {
      return null;
    }
    return detector.inspectExecutable(result.filePaths[0], null);
  });
  ipcMain.handle(IpcChannels.searchProducts, (_event, keyword: unknown) =>
    easyEda.searchProducts(z.string().parse(keyword)),
  );
  ipcMain.handle(IpcChannels.fetchComponent, (_event, lcscId: unknown) =>
    easyEda.fetchFootprint(z.string().parse(lcscId)),
  );
  ipcMain.handle(IpcChannels.fetchSymbol, (_event, lcscId: unknown) =>
    easyEda.fetchSymbol(z.string().parse(lcscId)),
  );
  // 界面偏好单独一条通道：拖动侧栏时不能顺手重跑 Allegro 探测（那个要扫注册表）。
  // 用 store.patch 做「读—改—写」：取色器拖动会连着打好几次，并发写会互相覆盖。
  ipcMain.handle(IpcChannels.saveUiSettings, (_event, patch: unknown) => {
    const parsedPatch = UiSettingsSchema.unwrap().partial().parse(patch ?? {});
    return settingsStore.patch((current) => ({
      ...current,
      ui: { ...current.ui, ...parsedPatch },
    }));
  });
  ipcMain.handle(IpcChannels.chooseLocalLibraryFile, async (_event, rawDirectory: unknown) => {
    // 记住的是**目录**（用户 2026-10-16 要求）：选择框直接落在上次用过的目录里
    const defaultDirectory = z.string().min(1).nullable().parse(rawDirectory ?? null);
    const result = await dialog.showOpenDialog({
      title: "选择立创EDA专业版库文件",
      ...(defaultDirectory === null ? {} : { defaultPath: defaultDirectory }),
      properties: ["openFile"],
      filters: [{ name: "立创EDA 库文件", extensions: ["elibz2", "epro", "epro2"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IpcChannels.readLocalLibrary, (_event, filePath: unknown) =>
    elibz2.readLibrary(z.string().min(1).parse(filePath)),
  );
  ipcMain.handle(
    IpcChannels.fetchLocalComponent,
    (_event, filePath: unknown, deviceUuid: unknown) =>
      elibz2.loadFootprint(
        z.string().min(1).parse(filePath),
        z.string().min(1).parse(deviceUuid),
      ),
  );
  ipcMain.handle(
    IpcChannels.fetchLocalSymbol,
    (_event, filePath: unknown, deviceUuid: unknown) =>
      elibz2.loadSymbol(
        z.string().min(1).parse(filePath),
        z.string().min(1).parse(deviceUuid),
      ),
  );
  ipcMain.handle(IpcChannels.chooseOlbLibrary, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 OrCAD Capture 符号库（.olb）",
      properties: ["openFile"],
      filters: [{ name: "Capture 符号库", extensions: ["olb"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IpcChannels.createOlbLibrary, async (_event, rawName: unknown) => {
    const settings = await settingsStore.read();
    const name = z.string().min(1).parse(rawName);
    const result = await dialog.showSaveDialog({
      title: "新建 OrCAD Capture 符号库",
      defaultPath: autoLibraryPath(settings.libraryDirectory, name),
      filters: [{ name: "Capture 符号库", extensions: ["olb"] }],
    });
    return result.canceled || result.filePath === undefined ? null : result.filePath;
  });
  ipcMain.handle(IpcChannels.writeOlb, async (_event, rawRequest: unknown) => {
    const request = OlbWriteRequestSchema.parse(rawRequest);
    const settings = await settingsStore.read();
    const installs = await detector.detect();
    const install = await resolveAllegroInstall(settings, installs, (path) =>
      detector.inspectExecutable(path, null),
    );
    const toolchain = await resolveCaptureToolchain(install?.executablePath ?? null);
    if (toolchain === null) {
      throw new Error(
        "未找到 Cadence 的 tclsh.exe / orDb Tcl 桥接 DLL（位于 <安装目录>\\tools\\bin），请在设置中确认 Allegro 程序路径。",
      );
    }
    const libraryPath =
      request.libraryPath ??
      autoLibraryPath(
        settings.libraryDirectory,
        request.libraryName,
        settings.unifiedLibraryFolder,
      );
    return writeCaptureLibrary({
      symbol: request.symbol,
      toolchain,
      libraryPath,
      // 必须转发：漏掉它 => 用户点了「覆盖写入」也依然返回 needsConfirm，弹窗无限重来
      confirmOverwrite: request.confirmOverwrite,
      // 界面按「全局开关 && 勾了 PCB 封装」算好再传（用户 2026-10-23）；
      // 没传（老调用方 / 测试）时退回设置里的全局开关。
      fillPcbFootprint: request.fillPcbFootprint ?? settings.fillPcbFootprint,
      snapPins: request.snapPins ?? true,
    });
  });
  ipcMain.handle(IpcChannels.createPlan, (_event, rawFootprint: unknown) =>
    createConversionPlan(NormalizedFootprintSchema.parse(rawFootprint)),
  );
  ipcMain.handle(IpcChannels.generate, async (event, rawPlan: unknown) => {
    const plan = ConversionPlanSchema.parse(rawPlan);
    const settings = await settingsStore.read();
    const installs = await detector.detect();
    const install = await resolveAllegroInstall(settings, installs, (path) =>
      detector.inspectExecutable(path, null),
    );
    const progressState: { last: GenerationProgress | null } = { last: null };
    try {
      const result = await runner.generate(
        plan,
        settings,
        install,
        (progress) => {
          progressState.last = progress;
          event.sender.send(IpcChannels.generationProgress, progress);
        },
      );
      const history = await historyStore.read();
      await historyStore.write([
        { ...result, id: `${result.lcscId}-${result.completedAt}` },
        ...history,
      ].slice(0, 200));
      return result;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const diagnosticDirectory =
        error instanceof AllegroExecutionError
          ? error.details.workingDirectory
          : null;
      await writeLog("error", "conversion_failed", {
        lcscId: plan.footprint.info.lcscId,
        message: cause.message,
        diagnosticDirectory,
      });
      event.sender.send(IpcChannels.generationProgress, {
        lcscId: plan.footprint.info.lcscId,
        stage: "failed",
        percent: Math.min(progressState.last?.percent ?? 1, 99),
        message: cause.message,
        diagnosticDirectory,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  });
  ipcMain.handle(IpcChannels.getHistory, () => historyStore.read());
  ipcMain.handle(IpcChannels.openPath, async (_event, absolutePath: unknown) => {
    const parsedPath = z.string().min(1).parse(absolutePath);
    const errorMessage = await shell.openPath(parsedPath);
    if (errorMessage.length > 0) {
      throw new Error(`Unable to open ${parsedPath}: ${errorMessage}`);
    }
  });
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId("cn.easy2alg.app");
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(async (error: unknown) => {
  const cause = error instanceof Error ? error : new Error(String(error));
  await writeLog("error", "application_start_failed", { message: cause.message });
  app.quit();
});

app.on("window-all-closed", () => {
  const action = lastWindowCloseAction(process.platform);
  if (action === "exit") {
    app.exit(0);
  } else if (action === "quit") {
    app.quit();
  }
});
