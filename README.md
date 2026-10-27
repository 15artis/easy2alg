# Easy2ALG

把立创商城器件编号对应的 EasyEDA 封装直接转换为 Cadence Allegro 封装库，不依赖 Altium Designer。

## 使用

1. 第一次启动时软件会自动识别电脑上已安装的 Allegro（识别不到时手动指定 `allegro.exe`），再确认封装库目录。
2. 输入一个或多个立创器件编号。
3. 在预览和自动检查中确认焊盘、丝印、阻焊与钢网规则。
4. 点击“生成选中的封装”。
5. 软件调用已安装的 Allegro 生成并回读检查 `.dra`、`.psm` 和 `.pad` 文件。

支持 Allegro 16.6、17.2、17.4、22.1、23.1、24.1、25.1，以及之后的新版本（版本号从安装路径 `SPB_x.y` 或程序文件版本号自动识别，不需要等软件更新）。Windows 是正式转换平台。软件只会在找到真实的 Allegro 程序，并且目标文件实际生成、检查通过后显示成功。

## 自动更新

安装版启动 8 秒后会自动检查一次新版本（设置页也能手动检查）：

1. 发现新版本 → 点「下载更新」，后台下载安装包并显示进度；
2. 下载完成 → 点「重启并安装」，软件退出、安装并自动重新打开。

免安装便携版没有安装目录可替换，不参与自动更新，界面会提示到发布页手动下载。自动更新读的是 Release 里的 `latest.yml`，发布时缺了它客户端就不会提示更新（发布脚本会直接报错拦下）。

## 开发

```bash
npm install
npm run dev
npm run build
```

构建 Windows 安装包和免安装版：

```bash
npm run dist:win
```

这条命令先打包（一定产出 exe 到 `release/`），再按下面的规则决定要不要发布到 GitHub Releases：

- 两次发布间隔至少 **24 小时**；
- 同一个版本号**不重复发布**。

两条都不满足时只会打包、不发版，退出码 `2`（正常跳过，不是错误）。所以发版前记得先抬 `package.json` 的版本号。

只打包、不碰 GitHub：`npm run dist:win:local`（同样是"先 build 再打包"，产物输出到临时目录后拷回 `release/`，本机 IDE 占着 `release/win-unpacked` 也能跑通）。只发布 `release/` 里现成的包：`npm run publish:github:only`。预览发布计划：`npm run publish:github:dry`。

## 许可

MIT
