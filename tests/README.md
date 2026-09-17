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
| `calzip_test.cjs` | — | 「导出全部页图片」的文件名规则（多页 2 张 / 单页 1 张）与 ZIP 条目 |
| `zip2_test.cjs` | — | ZIP 写入器的字节结构（CRC32、UTF-8 文件名标记、PNG 魔数完整） |

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
