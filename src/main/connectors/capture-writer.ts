import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import type { NormalizedSymbol, OlbWriteResult } from "../../shared/schemas";
import { buildCaptureLibraryXml } from "../conversion/capture-olb";
import { writeLog } from "../logging";

const executeFile = promisify(execFile);

/**
 * 用 Cadence 自带的 orDb Tcl 模块把 Capture 库 XML 写进 .olb。
 *
 * 语义来自本机实测（mode 矩阵：0/1/2 三种各跑一遍再导出回读）：
 *  - mode 0 = **新建库**：目标不存在则按给定路径精确创建；目标已存在则静默
 *    改名（t.OLB → t1.OLB）。因此新建前必须确保路径不存在。
 *  - mode 1/2 = **追加**：打开已有库写入，同名器件覆盖不重复，并自动留
 *    `<名字>_0.OBK` 备份。两种 mode 在本次实测中行为一致，统一用 1。
 *
 * 只依赖 tools/bin 下的 tclsh.exe 与 orDb_Dll_Tcl64.dll，不需要拉起
 * Capture GUI（用户要求 GUI 只能由本人启动）。
 */

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Tcl 双引号字符串转义：反斜杠、引号、$ 与 [] 都必须在字面量里失效。 */
const tclString = (value: string): string =>
  value.replace(/\\/g, "/").replace(/(["$[\]])/g, "\\$1");

const RUNNER_TEMPLATE = (
  root: string,
  dllPath: string,
  xmlPath: string,
  olbPath: string,
  logPath: string,
  statusPath: string,
  mode: number,
): string => `set root "${tclString(root)}"
set env(PATH) "$root;$env(PATH)"
set statusFh ""
proc E2A_Status {pText} {
  global statusFh
  if {$statusFh eq ""} { set statusFh [open $::e2aStatusPath "a"] }
  puts $statusFh $pText
  flush $statusFh
}
set e2aStatusPath "${tclString(statusPath)}"
if {[file exists $e2aStatusPath]} { file delete -force $e2aStatusPath }
set loadStatus [catch {load "${tclString(dllPath)}" DboTclWriteBasic} loadResult]
E2A_Status "loadStatus=$loadStatus"
if {$loadStatus != 0} {
  E2A_Status "result=error"
  E2A_Status "message=$loadResult"
  close $statusFh
  exit 0
}
set importStatus [catch {XMATIC_XML2OLB "${tclString(xmlPath)}" "${tclString(olbPath)}" ${mode} "${tclString(logPath)}" ""} importResult]
E2A_Status "catchStatus=$importStatus"
E2A_Status "importResult=$importResult"
if {$importStatus != 0} {
  E2A_Status "result=error"
  E2A_Status "message=$importResult"
} else {
  E2A_Status "result=ok"
}
close $statusFh
exit 0
`;

const EXPORT_TEMPLATE = (
  root: string,
  dllPath: string,
  olbPath: string,
  xmlPath: string,
): string => `set root "${tclString(root)}"
set env(PATH) "$root;$env(PATH)"
load "${tclString(dllPath)}" DboTclWriteBasic
catch {XMATIC_OLB2XML "${tclString(olbPath)}" "${tclString(xmlPath)}"} result
exit 0
`;

const readStatus = async (statusPath: string): Promise<Map<string, string>> => {
  const content = await readFile(statusPath, "utf8");
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) {
      entries.set(line.slice(0, index), line.slice(index + 1));
    }
  }
  return entries;
};

export type CaptureToolchain = {
  /** tools/bin 目录（tclsh.exe 与 orDb_Dll_Tcl64.dll 都在这） */
  readonly binDirectory: string;
  readonly tclshPath: string;
  readonly dllPath: string;
};

/**
 * 从 allegro.exe 反推 tclsh。
 *
 * 实测 17.4 布局：`<root>/tools/bin/{allegro.exe, tclsh.exe, orDb_Dll_Tcl64.dll}`。
 * 但 Allegro 也可能从 `<root>/tools/pcb/bin/allegro.exe` 启动（allegro-runner 里
 * 有同样的分叉判断），那时 tclsh 仍在 `<root>/tools/bin`，所以两条候选都要试。
 */
export const resolveCaptureToolchain = async (
  allegroExecutablePath: string | null,
): Promise<CaptureToolchain | null> => {
  if (allegroExecutablePath === null) {
    return null;
  }
  const executableDirectory = dirname(allegroExecutablePath);
  const executableParent = dirname(executableDirectory);
  const installationRoot =
    basename(executableParent).toLowerCase() === "pcb"
      ? dirname(dirname(executableParent))
      : dirname(executableParent);
  const candidates = [
    executableDirectory,
    join(installationRoot, "tools", "bin"),
    join(installationRoot, "tools", "pcb", "bin"),
  ];
  for (const candidate of candidates) {
    const tclshPath = join(candidate, "tclsh.exe");
    const dllPath = join(candidate, "orDb_Dll_Tcl64.dll");
    if ((await fileExists(tclshPath)) && (await fileExists(dllPath))) {
      return { binDirectory: candidate, tclshPath, dllPath };
    }
  }
  return null;
};

/** 未指定 OLB 时的落点：<封装库目录>/schlib/<源库名>.olb（多器件累加到同一个库）。 */
export const autoLibraryPath = (libraryDirectory: string, libraryName: string): string => {
  const safe = libraryName.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return join(libraryDirectory, "schlib", `${safe.length > 0 ? safe : "easy2alg"}.olb`);
};

export const olbLibraryNameFrom = (sourcePath: string): string => {
  const base = basename(sourcePath);
  const extension = extname(base);
  return extension.length > 0 ? base.slice(0, -extension.length) : base;
};

export type OlbWriteOptions = {
  readonly symbol: NormalizedSymbol;
  readonly toolchain: CaptureToolchain;
  /** 目标 .olb 绝对路径；不存在时会被创建 */
  readonly libraryPath: string;
};

const timestamp = (): string => {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
};

export const writeCaptureLibrary = async (
  options: OlbWriteOptions,
): Promise<OlbWriteResult> => {
  const { symbol, toolchain, libraryPath } = options;
  const existedBefore = await fileExists(libraryPath);
  const mode = existedBefore ? 1 : 0;
  await mkdir(dirname(libraryPath), { recursive: true });

  // 目标已存在时先自己留一份带时间戳的备份（工具自带的 *_0.OBK 名字不直观）。
  let backupPath: string | null = null;
  if (existedBefore) {
    backupPath = `${libraryPath}.${timestamp()}.bak`;
    await copyFile(libraryPath, backupPath);
  }

  const workDirectory = join(tmpdir(), `easy2alg-olb-${randomUUID()}`);
  await mkdir(workDirectory, { recursive: true });
  const xmlPath = join(workDirectory, "library.xml");
  const logPath = join(workDirectory, "import.log");
  const statusPath = join(workDirectory, "import-status.txt");
  const runnerPath = join(workDirectory, "import.tcl");
  const verifyScriptPath = join(workDirectory, "verify.tcl");
  const exportPath = join(workDirectory, "verify.xml");

  // 导入器按根 <Defn name> 定位目标库，必须与实际路径一致。
  await writeFile(xmlPath, buildCaptureLibraryXml(symbol, libraryPath), "utf8");
  await writeFile(
    runnerPath,
    RUNNER_TEMPLATE(
      toolchain.binDirectory,
      toolchain.dllPath,
      xmlPath,
      libraryPath,
      logPath,
      statusPath,
      mode,
    ),
    "utf8",
  );

  // mode 1 时工具会在目标同目录留 `<_0.OBK>`；若它不是本次产生的就别碰。
  const autoBackupPath = join(
    dirname(libraryPath),
    `${basename(libraryPath, extname(libraryPath))}_0.OBK`,
  );
  const autoBackupExisted = await fileExists(autoBackupPath);

  const runTcl = async (scriptPath: string): Promise<string> => {
    const result = await executeFile(toolchain.tclshPath, [scriptPath], {
      cwd: workDirectory,
      encoding: "utf8",
      env: { ...process.env },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: 300_000,
    });
    return `${result.stdout}\n${result.stderr}`;
  };

  let runOutput = "";
  try {
    runOutput = await runTcl(runnerPath);
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string };
    await writeLog("error", "olb_import_process_failed", {
      libraryPath,
      message: processError.message,
      stderr: processError.stderr ?? "",
    });
    throw new Error(
      `调用 Cadence Tcl 写入 OLB 失败：${processError.message}${
        processError.stderr !== undefined && processError.stderr.length > 0
          ? `\n${processError.stderr}`
          : ""
      }`,
    );
  }

  const status = await readStatus(statusPath).catch(() => new Map<string, string>());
  const importLog = await readFile(logPath, "utf8").catch(() => "");
  if (status.get("result") !== "ok") {
    await writeLog("error", "olb_import_rejected", {
      libraryPath,
      status: [...status.entries()].map(([key, value]) => `${key}=${value}`).join(" "),
      runOutput,
      importLog,
    });
    throw new Error(
      `Cadence 拒绝了库 XML：${status.get("message") ?? "未知错误"}\n${importLog || runOutput}`,
    );
  }

  // 回读校验：导出成品库，确认里面确实有刚写入的 Package。
  await writeFile(
    verifyScriptPath,
    EXPORT_TEMPLATE(toolchain.binDirectory, toolchain.dllPath, libraryPath, exportPath),
    "utf8",
  );
  await runTcl(verifyScriptPath);
  const exported = await readFile(exportPath, "utf8").catch(() => "");
  if (!exported.includes(`name="${symbol.name}"`)) {
    await writeLog("error", "olb_verify_failed", { libraryPath, packageName: symbol.name });
    throw new Error(
      `OLB 已写入但回读未找到器件 ${symbol.name}，请检查 ${libraryPath}。`,
    );
  }

  if (!autoBackupExisted) {
    await rm(autoBackupPath, { force: true }).catch(() => undefined);
  }
  await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);

  const fileSize = (await stat(libraryPath)).size;
  const pinned = symbol.sections.reduce((total, section) => total + section.pins.length, 0);
  await writeLog("info", "olb_written", {
    libraryPath,
    packageName: symbol.name,
    sections: symbol.sections.length,
    pins: pinned,
    mode,
    bytes: fileSize,
  });
  return {
    libraryPath,
    created: !existedBefore,
    packageName: symbol.name,
    sectionCount: symbol.sections.length,
    pinCount: pinned,
    backupPath,
    bytes: fileSize,
    message: existedBefore
      ? `已追加到 ${basename(libraryPath)}（${symbol.sections.length} 段 / ${pinned} 脚）`
      : `已新建 ${basename(libraryPath)}（${symbol.sections.length} 段 / ${pinned} 脚）`,
  };
};
