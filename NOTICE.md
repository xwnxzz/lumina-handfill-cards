# 声明 / Notices

本文件记录第三方来源、逐篇署名与 AI 辅助说明。

许可范围见 [`LICENSE`](LICENSE)（代码 · MIT）与 [`CONTENT-LICENSE.md`](CONTENT-LICENSE.md)（内容 · CC BY-NC-SA 4.0）。

---

## 一、改编自 Lumina Studio Wiki 的文档

Lumina Studio Wiki 的原创公开内容采用
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可
（见其 [CONTENT-LICENSE.md](https://github.com/lumina-layer-studio/Lumina-Studio-Wiki/blob/main/CONTENT-LICENSE.md)）。

本仓库以下文档改编自该 Wiki。按许可要求，逐篇署名如下（来源 + 原页面链接 + 许可 + 修改说明）：

### `docs/梯度卡图像转换流程.md`

- **来源**：Lumina Studio Wiki
- **原页面**：
  - <https://wiki.luminastudio.com.cn/zh/docs/reference/materials-and-recipes/gradient-card-generation/>
  - <https://wiki.luminastudio.com.cn/zh/docs/reference/materials-and-recipes/gradient-card-extraction/>
  - <https://wiki.luminastudio.com.cn/zh/docs/tutorials/gradient-card-generate-print/>
  - <https://wiki.luminastudio.com.cn/zh/docs/tutorials/gradient-card-extract-profile/>
- **许可**：CC BY-NC-SA 4.0
- **修改**：把分散在多篇 Wiki 页面中的参数与顺序**串联重写**为一份完整操作流程；
  补充了中文参数含义说明。整理时官方尚未发布「使用耗材档案完成图像转换」独立教程，
  该流程的先后顺序由本项目自行整理。

### `docs/两块校准板_参数填写表.md`

- **来源**：Lumina Studio Wiki
- **原页面**：
  - <https://wiki.luminastudio.com.cn/zh/docs/reference/lut-management/calibration-board/>
  - <https://wiki.luminastudio.com.cn/zh/docs/reference/lut-management/lut-extractor/>
  - <https://wiki.luminastudio.com.cn/zh/docs/reference/lut-management/extractor-photo-correction/>
  - <https://wiki.luminastudio.com.cn/zh/docs/reference/lut-management/colorchecker-calibration/>
- **许可**：CC BY-NC-SA 4.0
- **修改**：改写为**可直接照填的参数表**；参数值与用户本机 `1号.json` / `2号.json`
  的实测头部字段交叉核对。

### `docs/手动写耗材档案_指南.md`

- **来源**：Lumina Studio Wiki（耗材档案字段与后端校验项）
- **原页面**：<https://wiki.luminastudio.com.cn/zh/docs/reference/materials-and-recipes/material-edit-and-verification/>
- **许可**：CC BY-NC-SA 4.0
- **修改**：正向模型改为由**用户自己导出的档案包**反推并逐位验证；
  补充了离线测量与填表流程。

---

## 二、依据官方开源仓库整理的文档

### `docs/8色校准板_官方规格与单元总表.md`

- **来源**：官方公开仓库 [`lumina-layer-studio/Lumina-Layers`](https://github.com/lumina-layer-studio/Lumina-Layers)（1.x）
- **该仓库代码的许可**：**GNU GPL v3.0**
- **本仓库的处理**：**不包含**该仓库的任何源代码，仅依据其中的实现整理了校准板的
  **事实性规格**（网格尺寸、角标映射、提取画布尺寸、取样方式等），并在文档中逐条标注了
  来源文件与行为，另与用户实际打印的官方 2.0 Kit 逐行交叉验证。
- **说明**：若你认为上述事实性常量的整理构成该程序的衍生作品，请以 GPL-3.0 为准。
  本项目不对该问题作法律判断，只如实标注来源。

---

## 三、界面主题令牌

`lumina_singlestage_gui.html` 中的配色变量（变量名与取值）取自官方在线应用的样式表，
目的是让界面与官方视觉保持一致。该部分与工具功能无关，若有异议可整体移除。

---

## 四、第三方依赖

**无。** 主工具是单个 HTML 文件，零运行时依赖、无外部字体 / CDN / 统计脚本，完全离线。
`tools/` 下的 Python 脚本仅依赖 numpy；`tests/` 下的测试仅使用 Node.js 内置模块。

---

## 五、AI 辅助说明

本仓库的文档由 AI 协助撰写（依据用户自己导出的档案包、官方公开文档与公开仓库整理），
并已与用户实际打印的官方套件逐项核对。沿用 Lumina Studio Wiki 的披露惯例，特此说明。

由于软件仍在持续更新，内容可能存在疏漏或与后续版本不一致。
如发现不准确之处，欢迎提 Issue 或 Pull Request。
