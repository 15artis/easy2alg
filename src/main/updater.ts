import { app, shell } from "electron";
import updaterPackage from "electron-updater";
import {
  RELEASE_PAGE_URL,
  canAutoUpdate,
  humanizeUpdateError,
  initialUpdateState,
  type UpdateState,
} from "../shared/update";
import { writeLog } from "./logging";

const { autoUpdater } = updaterPackage;

type UpdateInfo = updaterPackage.UpdateInfo;
type ProgressInfo = updaterPackage.ProgressInfo;

/** 下载完成到退出安装之间的缓冲：留给界面把"正在安装"画出来。 */
const AUTO_INSTALL_DELAY_MS = 600;
/** 有转换在跑时的轮询间隔（每轮都重新问一次 isBusy）。 */
const AUTO_INSTALL_RETRY_MS = 2000;

export type UpdaterController = {
  readonly getState: () => UpdateState;
  /** 检查是否有新版本；已是最新时状态会变成 up-to-date */
  readonly check: () => Promise<UpdateState>;
  /** 下载新版本（只有 available 状态才真的下） */
  readonly download: () => Promise<UpdateState>;
  /** 退出并安装（只有 downloaded 状态才真的装） */
  readonly install: () => void;
  readonly openReleasePage: () => Promise<void>;
  readonly dispose: () => void;
};

type Options = {
  readonly currentVersion: string;
  /** 状态变化时推给界面（主进程往所有窗口广播） */
  readonly notify: (state: UpdateState) => void;
  /**
   * 主进程此刻有没有不能中断的活（现在是"转换正在跑"）。
   * 下载完成后自动退出安装前要问一句 —— 转换中途被 quitAndInstall 掐掉，
   * 用户得从头再来一遍。
   */
  readonly isBusy?: () => boolean;
};

/**
 * 自动更新（Windows 安装版）。
 *
 * 用户 2026-11-10 定的一步到位流程：顶栏那颗"新版本 vX"点一下就
 * **自动下载 → 下完自动退出安装 → 装完自动重开**，不再要求点第二次。
 * 只保留两处必要的停顿：
 *   1. 转换任务在跑时不退出，等它结束（`isBusy`），界面上写明原因；
 *   2. 下载完成后留 600ms 让界面把"正在安装"画出来再 quit，否则用户只看到窗口凭空消失。
 *
 * 免安装版 / 开发模式不接 electron-updater：前者没有安装目录可替换，
 * 后者没有打包时生成的 `app-update.yml`，接了只会抛错。这两种情况界面显示
 * "打开发布页"，让用户手动下载。
 */
export const createUpdaterController = ({
  currentVersion,
  notify,
  isBusy,
}: Options): UpdaterController => {
  const support = canAutoUpdate({
    packaged: app.isPackaged,
    portable:
      process.env.PORTABLE_EXECUTABLE_DIR !== undefined ||
      process.env.PORTABLE_EXECUTABLE_FILE !== undefined,
    platform: process.platform,
  });

  let state: UpdateState = {
    ...initialUpdateState(currentVersion),
    supported: support.supported,
    status: support.supported ? "idle" : "unsupported",
    message: support.reason,
  };

  const publish = (patch: Partial<UpdateState>): UpdateState => {
    state = { ...state, ...patch };
    notify(state);
    return state;
  };

  const openReleasePage = async (): Promise<void> => {
    await shell.openExternal(RELEASE_PAGE_URL);
  };

  if (!support.supported) {
    void writeLog("info", "update_disabled", { reason: support.reason });
    return {
      getState: () => state,
      check: async () => state,
      download: async () => state,
      install: () => undefined,
      openReleasePage,
      dispose: () => undefined,
    };
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (message?: unknown) => void writeLog("info", "updater", { message: String(message) }),
    warn: (message?: unknown) => void writeLog("warn", "updater", { message: String(message) }),
    error: (message?: unknown) => void writeLog("error", "updater", { message: String(message) }),
    debug: (message: string) => void writeLog("debug", "updater", { message }),
  };

  /**
   * 测试/内网镜像用：把更新源指到别处（默认读打包时写进 app-update.yml 的 GitHub 仓库）。
   * 只在设置了环境变量时生效，正常安装的用户不会碰到。
   */
  const feedOverride = process.env.EASY2ALG_UPDATE_FEED;
  if (feedOverride !== undefined && feedOverride.trim() !== "") {
    autoUpdater.setFeedURL({ provider: "generic", url: feedOverride.trim() });
    void writeLog("warn", "update_feed_override", { url: feedOverride.trim() });
  }

  /** 用户点过"立即更新"→ 下载完成后自动装；没点过就不擅自退出。 */
  let installRequested = false;
  let installTimer: ReturnType<typeof setTimeout> | null = null;
  let installStarted = false;

  const install = (): void => {
    if (installStarted || state.status !== "downloaded") {
      return;
    }
    installStarted = true;
    publish({ status: "installing", message: null });
    void writeLog("info", "update_install_requested", {
      latest: state.latestVersion,
    });
    // isSilent=true：不再让用户点安装向导（这是"点一下就装完"的最后一环，
    // 安装目录沿用上次的选择，由 electron-builder 的注册表记录保证）；
    // isForceRunAfter=true：装完自动重新打开。
    // 想回到"看图点下一步"的老行为，把第一个参数改成 false 即可。
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      // 退出失败（安装包被占用等）就别把界面卡在"正在安装…"，回到可重试的状态
      installStarted = false;
      const message = humanizeUpdateError(error);
      publish({ status: "error", message });
      void writeLog("error", "update_install_failed", { message });
    }
  };

  /**
   * 下载完成后自动退出安装。
   *
   * 转换在跑就先不退（`isBusy`），每 2 秒回来看一眼 —— 转换跑到一半被
   * quitAndInstall 掐掉，用户得从头再导一次器件。
   */
  const scheduleAutoInstall = (): void => {
    if (!installRequested || installTimer !== null) {
      return;
    }
    if (isBusy?.() === true) {
      publish({ message: "转换任务进行中，结束后会自动安装。" });
      void writeLog("info", "update_install_deferred", { latest: state.latestVersion });
      installTimer = setTimeout(() => {
        installTimer = null;
        scheduleAutoInstall();
      }, AUTO_INSTALL_RETRY_MS);
      return;
    }
    // 留一拍让界面把"正在安装"画出来，否则窗口凭空消失
    installTimer = setTimeout(() => {
      installTimer = null;
      install();
    }, AUTO_INSTALL_DELAY_MS);
  };

  const handleCheckingForUpdate = (): void => {
    publish({ status: "checking", message: null });
    void writeLog("info", "update_check_started", { current: state.currentVersion });
  };
  const handleUpdateAvailable = (info: UpdateInfo): void => {
    publish({ status: "available", latestVersion: info.version, percent: 0, message: null });
    void writeLog("info", "update_available", {
      current: state.currentVersion,
      latest: info.version,
    });
  };
  const handleUpdateNotAvailable = (info: UpdateInfo): void => {
    publish({ status: "up-to-date", latestVersion: info.version, percent: 0, message: null });
    void writeLog("info", "update_not_available", {
      current: state.currentVersion,
      latest: info.version,
    });
  };
  const handleDownloadProgress = (progress: ProgressInfo): void => {
    publish({ status: "downloading", percent: progress.percent });
  };
  const handleUpdateDownloaded = (info: UpdateInfo): void => {
    publish({ status: "downloaded", latestVersion: info.version, percent: 100, message: null });
    void writeLog("info", "update_downloaded", { latest: info.version });
    // 一步到位：下完就直接装（转换在跑就等它跑完）
    scheduleAutoInstall();
  };
  const handleError = (error: Error): void => {
    // 出错就别再惦记自动安装了，等用户下一次点
    installRequested = false;
    const message = humanizeUpdateError(error);
    publish({ status: "error", message });
    void writeLog("error", "update_failed", { message, raw: error.message });
  };

  autoUpdater.on("checking-for-update", handleCheckingForUpdate);
  autoUpdater.on("update-available", handleUpdateAvailable);
  autoUpdater.on("update-not-available", handleUpdateNotAvailable);
  autoUpdater.on("download-progress", handleDownloadProgress);
  autoUpdater.on("update-downloaded", handleUpdateDownloaded);
  autoUpdater.on("error", handleError);

  let checking = false;
  const check = async (): Promise<UpdateState> => {
    if (checking) {
      return state;
    }
    checking = true;
    void writeLog("info", "update_check_requested", { current: state.currentVersion });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // 事件里也会报一次；这里兜住 checkForUpdates 直接抛的情况（比如元数据 404）
      const message = humanizeUpdateError(error);
      publish({ status: "error", message });
      void writeLog("error", "update_check_failed", { message });
    } finally {
      checking = false;
    }
    return state;
  };

  let downloading = false;
  const download = async (): Promise<UpdateState> => {
    if (downloading || state.status !== "available") {
      return state;
    }
    downloading = true;
    // 点了下载就当作"要装"：下完自动退出安装，不用再点第二次
    installRequested = true;
    void writeLog("info", "update_download_requested", { latest: state.latestVersion });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      installRequested = false;
      const message = humanizeUpdateError(error);
      publish({ status: "error", message });
      void writeLog("error", "update_download_failed", { message });
    } finally {
      downloading = false;
    }
    return state;
  };

  const dispose = (): void => {
    if (installTimer !== null) {
      clearTimeout(installTimer);
      installTimer = null;
    }
    autoUpdater.removeListener("checking-for-update", handleCheckingForUpdate);
    autoUpdater.removeListener("update-available", handleUpdateAvailable);
    autoUpdater.removeListener("update-not-available", handleUpdateNotAvailable);
    autoUpdater.removeListener("download-progress", handleDownloadProgress);
    autoUpdater.removeListener("update-downloaded", handleUpdateDownloaded);
    autoUpdater.removeListener("error", handleError);
  };

  return { getState: () => state, check, download, install, openReleasePage, dispose };
};
