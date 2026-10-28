# Easy2ALG

把立创商城器件编号对应的 EasyEDA 封装直接转换为 Cadence Allegro 封装库，不依赖 Altium Designer。

## 界面

左边是待转换清单，中间是预览画布（PCB 封装 / 原理图元件两个分页），右边是自动检查、输出命名和图层显示。

**PCB 封装页**：焊盘、阻焊开窗、钢网开口、丝印与装配外框分层显示，可缩放拖动；异形焊盘（如 SOT-89 的中间脚）按原始多边形轮廓绘制。

![PCB 封装预览](docs/images/pcb-preview.png)

**原理图元件页**：OrCAD Capture 符号预览，引脚名/编号、本体轮廓按最终写入 `.olb` 的几何渲染，可在画布上直接拖动调整。

![原理图元件预览](docs/images/schematic-preview.png)

## 使用

1. 第一次启动时软件会自动识别电脑上已安装的 Allegro（识别不到时手动指定 `allegro.exe`），再确认封装库目录。
2. 输入一个或多个立创器件编号。
3. 在预览和自动检查中确认焊盘、丝印、阻焊与钢网规则。
4. 点击“生成选中的封装”。
5. 软件调用已安装的 Allegro 生成并回读检查 `.dra`、`.psm` 和 `.pad` 文件。

支持 Allegro 16.6、17.2、17.4、22.1、23.1、24.1、25.1，以及之后的新版本（版本号从安装路径 `SPB_x.y` 或程序文件版本号自动识别，不需要等软件更新）。Windows 是正式转换平台。软件只会在找到真实的 Allegro 程序，并且目标文件实际生成、检查通过后显示成功。

### 异形焊盘

立创的 `PAD~POLYGON` 焊盘（SOT-89 中间脚、带引脚的热焊盘这类）没有对应的 Allegro 内建图形，软件会按原始多边形轮廓生成 shape symbol（`.ssm`）：铜箔一层、阻焊按外扩量再生成一层，与 `.pad` 一起写进同一个库目录。Allegro 通过 `PADPATH` 找 `.ssm`，所以把库路径指到这个目录就能正常引用，不会退化成包围盒矩形。

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
