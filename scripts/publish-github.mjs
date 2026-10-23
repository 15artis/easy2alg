#!/usr/bin/env node
/**
 * 自动发布到 GitHub Releases。
 *
 * 设计目标：可以安全地「经常跑」（手动或定时），脚本自己保证
 *   - 两次发布间隔至少 N 小时（默认 24）
 *   - 同一个版本号不会重复发布
 *   - 只有版本号变了、且离上次发布够久，才真的构建并上传
 *
 * 用法：
 *   node scripts/publish-github.mjs                 # 构建 + 发布（带上面两道拦截）
 *   node scripts/publish-github.mjs --dry-run       # 只检查并打印计划，不动任何东西
 *   node scripts/publish-github.mjs --skip-build    # 用 release/ 里已有的安装包，不重新构建
 *   node scripts/publish-github.mjs --force         # 忽略间隔与重复版本拦截
 *   node scripts/publish-github.mjs --min-hours 48  # 改最小间隔（0 = 不限制）
 *   node scripts/publish-github.mjs --notes FILE    # 用指定 markdown 作为 Release 说明
 *
 * 退出码：0 成功 / 1 出错 / 2 被拦截（间隔不足或版本已发布，属于正常跳过）
 *
 * 凭据来源（按顺序）：环境变量 GITHUB_TOKEN 或 GH_TOKEN → git credential（本机已存的账号）。
 *
 * 构建说明：本机 `npm run dist:win` 会因为 IDE 占用 release/win-unpacked 而失败，
 * 所以这里固定把产物输出到系统临时目录，再把安装包拷回 release/。
 */
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API = "https://api.github.com";
const MIRRORS = {
  ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};

const options = {
  dryRun: flag("--dry-run"),
  skipBuild: flag("--skip-build"),
  force: flag("--force"),
  pushTag: !flag("--no-push-tag"),
  minHours: Number(valueOf("--min-hours", "24")),
  notesFile: valueOf("--notes", null),
  help: flag("--help") || flag("-h"),
};

const log = (message) => console.log(message);
const warn = (message) => console.warn(message);
const die = (message, code = 1) => {
  console.error(`\n✗ ${message}`);
  process.exit(code);
};

if (options.help) {
  const header = fs
    .readFileSync(new URL(import.meta.url), "utf8")
    .split("*/")[0]
    .replace(/^#![^\n]*\n/, "")
    .replace(/^\/\*\*?/, "")
    .replace(/^\s*\*\s?/gm, "")
    .trim();
  log(header);
  process.exit(0);
}
if (!Number.isFinite(options.minHours) || options.minHours < 0) {
  die(`--min-hours 需要是非负数字，收到：${valueOf("--min-hours", "(空)")}`);
}

// ---------------------------------------------------------------- 小工具

const runShell = (command, extraEnv = {}) => {
  const result = spawnSync(command, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`命令执行失败（退出码 ${result.status}）：${command}`);
  }
};

const git = (args, options = {}) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...options }).trim();

const readVersion = () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return pkg.version;
};

const resolveRepo = () => {
  const url = git(["remote", "get-url", "origin"]);
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (match === null) {
    throw new Error(`无法从 origin 解析出 GitHub 仓库：${url}`);
  }
  return `${match[1]}/${match[2]}`;
};

const resolveToken = () => {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  try {
    const output = execFileSync("git", ["credential", "fill"], {
      cwd: ROOT,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const match = /^password=(.+)$/m.exec(output);
    if (match !== null) {
      return match[1].trim();
    }
  } catch {
    // 落到下面的报错
  }
  throw new Error(
    "找不到 GitHub 凭据。请设置环境变量 GITHUB_TOKEN，或先执行一次 git push 让 git 记住账号。",
  );
};

const api = async (pathname, init = {}) => {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${pathname} 失败：${response.status} ${text.slice(0, 400)}`);
  }
  return response.status === 204 ? null : response.json();
};

const formatAge = (ms) => {
  const hours = ms / 3_600_000;
  if (hours < 1) {
    return `${Math.round(hours * 60)} 分钟`;
  }
  if (hours < 48) {
    return `${hours.toFixed(1)} 小时`;
  }
  return `${(hours / 24).toFixed(1)} 天`;
};

// ---------------------------------------------------------------- 主流程

const version = readVersion();
const tag = `v${version}`;
const repo = resolveRepo();
const token = resolveToken();

log(`仓库    ${repo}`);
log(`版本    ${version}（tag ${tag}）`);
log(`间隔    ${options.minHours === 0 ? "不限制" : `至少 ${options.minHours} 小时`}`);
if (options.dryRun) log("模式    预览（不会构建，也不会发布）");
log("");

// ① 查已有 Release，做两道拦截
const releases = await api(`/repos/${repo}/releases?per_page=50`);
const published = releases.filter((item) => item.draft !== true);
const latest = published[0] ?? null;

if (latest !== null) {
  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  log(`上次发布 ${latest.tag_name}（${new Date(latest.created_at).toLocaleString()}，距今 ${formatAge(ageMs)}）`);
  if (options.minHours > 0 && ageMs < options.minHours * 3_600_000 && !options.force) {
    die(
      `距上次发布只有 ${formatAge(ageMs)}，不足 ${options.minHours} 小时，本次跳过。\n` +
        `  确认要发就加 --force，或临时放宽 --min-hours。`,
      2,
    );
  }
} else {
  log("上次发布 无（这将是第一个 Release）");
}

const alreadyReleased = published.find((item) => item.tag_name === tag);
if (alreadyReleased !== undefined && !options.force) {
  die(`版本 ${tag} 已经发布过了：${alreadyReleased.html_url}\n  要重新发布请先改 package.json 的版本号，或加 --force。`, 2);
}

// ② 准备安装包
const setupName = `Easy2ALG-Setup-${version}-x64.exe`;
const portableName = `Easy2ALG-Portable-${version}-x64.exe`;
const blockmapName = `${setupName}.blockmap`;
const wanted = [setupName, portableName, blockmapName];

let assetsDir = path.join(ROOT, "release");
if (!options.skipBuild) {
  log("\n[1/3] 构建（typecheck + 测试 + 打包）…");
  if (options.dryRun) {
    log("      预览模式，跳过");
  } else {
    runShell("npm run build");
    const outDir = path.join(os.tmpdir(), `easy2alg-${version}-${Date.now()}`);
    log(`      输出目录 ${outDir}`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "node_modules", "electron-builder", "cli.js"),
        "--win", "nsis", "portable",
        "--x64",
        "--publish", "never",
        `--config.directories.output=${outDir}`,
      ],
      { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...MIRRORS } },
    );
    if (result.status !== 0) {
      die(`electron-builder 失败（退出码 ${result.status}）`);
    }
    assetsDir = outDir;
  }
} else {
  log("\n[1/3] 跳过构建，使用 release/ 里已有的安装包");
}

const assets = wanted
  .map((name) => path.join(assetsDir, name))
  .filter((file) => fs.existsSync(file));

const missing = wanted.filter((name) => !fs.existsSync(path.join(assetsDir, name)));
if (missing.length > 0 && !options.dryRun) {
  die(`缺少安装包：${missing.join(", ")}\n  目录：${assetsDir}`);
}

log("\n[2/3] 待上传");
for (const file of assets) {
  log(`      ${path.basename(file)}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`);
}

if (options.dryRun) {
  log("\n[3/3] 预览模式结束，未创建 tag / Release。");
  process.exit(0);
}

// ③ 拷回 release/（构建输出在临时目录时）
if (path.resolve(assetsDir) !== path.resolve(ROOT, "release")) {
  fs.mkdirSync(path.join(ROOT, "release"), { recursive: true });
  for (const file of assets) {
    fs.copyFileSync(file, path.join(ROOT, "release", path.basename(file)));
  }
  log(`      已拷回 release/`);
}

// ④ tag
const localTag = git(["tag", "-l", tag]);
if (localTag === "") {
  git(["tag", "-a", tag, "-m", `Easy2ALG ${tag}`]);
  log(`\n[3/3] 已创建 tag ${tag}`);
} else {
  log(`\n[3/3] tag ${tag} 已存在`);
}
if (options.pushTag) {
  runShell(`git push origin ${tag}`);
}

// ⑤ Release 说明
const buildNotes = () => {
  if (options.notesFile !== null) {
    return fs.readFileSync(path.resolve(ROOT, options.notesFile), "utf8");
  }
  const range = latest !== null ? `${latest.tag_name}..HEAD` : "-20";
  let changelog = "";
  try {
    changelog = execFileSync("git", ["log", "--pretty=- %s", range], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    changelog = "";
  }
  return [
    "把立创 / EasyEDA 的器件封装转换为 Cadence Allegro 封装库与 OrCAD Capture 原理图符号库的 Windows 桌面工具。",
    "",
    "## 下载",
    "",
    "| 文件 | 说明 |",
    "| --- | --- |",
    `| \`${setupName}\` | 安装版（NSIS，可选安装目录） |`,
    `| \`${portableName}\` | 免安装便携版 |`,
    "",
    "**系统要求**：Windows x64。支持 Allegro 16.6 / 17.2 / 17.4 / 22.1 / 23.1。",
    "",
    "## 本次变更",
    "",
    changelog === "" ? "- 无记录" : changelog,
    "",
  ].join("\n");
};

const release = await api(`/repos/${repo}/releases`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tag_name: tag,
    target_commitish: "main",
    name: `Easy2ALG ${tag}`,
    body: buildNotes(),
    draft: false,
    prerelease: false,
  }),
});
log(`      Release 已创建：${release.html_url}`);

// ⑥ 上传附件
const uploadUrl = String(release.upload_url).split("{")[0];
for (const file of assets) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  log(`      上传 ${name}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
  const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
    },
    body: fs.createReadStream(file),
    duplex: "half",
  });
  if (!response.ok) {
    const text = await response.text();
    die(`上传 ${name} 失败：${response.status} ${text.slice(0, 300)}`);
  }
}

log(`\n✓ 发布完成：${release.html_url}`);
