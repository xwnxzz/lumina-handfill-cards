# 测试说明

这些脚本把 `lumina_singlestage_gui.html` 里的**真实代码抽出来**，在隔离沙箱（`new Function`）里运行，
不是复制一份代码来测——所以改动主工具后重跑就能发现回归。

## 运行

需要 Node.js（建议 18+）。**必须在仓库根目录执行**，脚本会从当前目录读取主工具：

```bash
cd <仓库根目录>

node tests/p0p1p2_test.cjs
node tests/p0_test.cjs
node tests/calzip_test.cjs
node tests/zip2_test.cjs
```

前两个会打印逐项结果与汇总（`通过 N，失败 0`），退出码 0 表示全通过。
后两个只验证 ZIP 结构与命名，会在 `.test-out/` 下生成 zip 产物（该目录已被 gitignore）。

## 覆盖内容

| 脚本 | 断言数 | 覆盖 |
|---|---|---|
| `p0p1p2_test.cjs` | 36 | 文件名时间戳为本地时间、梯度卡持久化往返、输入钳制边界、梯度卡 CSV 导出/导入往返（**含无表头文件**）、校准板 CSV「含未填格」往返、死代码清理、导出防重入 |
| `p0_test.cjs` | 26 | 校准板持久化往返、CSV 导入格式兼容、越界索引丢弃、数值钳制、localStorage 不可用时的降级、未知模式的安全性 |
| `review_fixes_test.cjs` | 34 | 第一轮外部代码评审的发现（见下），防止再次退化 |
| `review2_fixes_test.cjs` | 39 | 第二轮评审：线性模式 CSV 往返、交叉模式换算、填满全部钳制、0 层默认基准、5 列行列校验、HTML↔Python 规格契约、18 档映射链 |
| `official_spec_test.cjs` | 75 | 与官方 2.0 资源逐项核对：板面几何（官方 .npy 形状）、8 色槽位顺序（官方命名规范）、四角标（官方参考板图逐格像素）、各模式调色板、正向模型参数结构 |
| `calzip_test.cjs` | — | 「导出全部页图片」的文件名规则（多页 2 张 / 单页 1 张）与 ZIP 条目 |
| `zip2_test.cjs` | — | ZIP 写入器的字节结构（CRC32、UTF-8 文件名标记、PNG 魔数完整） |

## 契约变更记录（review_fixes_test.cjs 对应的那轮修复）

这几项是**有意的行为变更**，不是为让测试变绿而改测试：

| 变更 | 之前 | 现在 |
|---|---|---|
| 空 / 非法通道值 | `clamp8("")` → `0`（未测量冒充纯黑） | `clamp8OrNull("")` → `null`（未测量就是未测量） |
| 线性模式切换 | 只判断 `r`，G/B 的 `null` 被写成 `0` | 逐通道判空，未填的保持 `null` |
| 校准板半填 | 计入「已填」，界面不提示 | 「半填」单列一种状态，不计入已填 |
| CSV 的 `# mode` | 写界面文案（label），改文案就失配 | 写稳定 key（`C8`），另附 `mode_label` 供人读；旧文件仍可导入 |
| CSV 未知模式 | 静默塞进「当前板块」 | 跳过该段并上报 |
| CSV 重复格子 | 静默覆盖 | 覆盖但计数上报 |
| 体检（sanity） | 逐通道判「越厚越亮」，黑底+亮色耗材会误报 | 用相对亮度 Y，方向随基底（白底应越暗、黑底应越亮） |
| 本地存储脏数据 | 原样入库（字符串 / 超范围都能进） | 严格校验，非法值置 `null` |
| **线性模式 CSV 往返** | 导入时一律按 sRGB 再转一次 → `0.216` 变成 `0.000065` | CSV 自带 `# input_mode`，按声明换算；导出→清空→导入完全一致 |
| 「填满全部」 | 绕过 `clamp8OrNull`，`999 / -100` 会写满整块板 | 走同一套钳制；有空通道直接拒绝 |
| 实时色块背景 | `d ? rgb(...)` → 半填生成 `rgb(x,null,null)` | 用 `isFilled`，与网格/计数口径一致 |
| `isFilled` | 只判 `!== null`，缺值（`undefined`）被当成已填 | 用 `!= null` 同时排除 `null` 与 `undefined` |
| 0 层默认基准 | 自动填的 255 冒充实测、被计入「已填」、写进 CSV → Python 拿到假 C0 | 标记为「默认基准」：不计入已测、不写入 CSV、体检明确提示未实测 |
| CSV 5 列格式 | 只校验算出的 index | 分别校验 `row` / `col` 在 `[0, data-1]` |

## 手工验证辅助

`shot.ps1` 用无头 Edge 截图，用于人工核对界面渲染，**不属于自动化测试**：

```powershell
powershell -File tests/shot.ps1 -Url "file:///C:/path/lumina_singlestage_gui.html" `
           -Out "C:\temp\shot.png" -Width 1300 -Height 700
```

它在 Windows 上通过计划任务以「最低权限」启动 Edge。
如果你的终端本身不是管理员权限，可以改用更直接的 `msedge --headless=new --screenshot=...`。

## 注意

- 测试只覆盖**纯逻辑**（数据、格式、序列化、ZIP 结构）。
  浏览器渲染、系统「另存为」对话框等需要人工确认的部分不在自动化范围内。
- 若你改动主工具里的函数名或结构，测试里的抽取锚点（如 `const CAL_MODES = [`）需要同步更新。
