# Lumina SingleStage 采集数据生成器 · 说明

**文件**：`lumina_singlestage_gui.html` —— 双击即可用浏览器打开，**单文件、无依赖、纯离线**，不上传任何数据。

---

## 这个程序做什么

你手上没有（或不想用）**拍照识别**这条路，而是自己测量了色块 RGB。
这个程序把 **色块 RGB → Lumina 可导入的 SingleStage 采集数据**：

```
导入模板（耗材档案包 或 Kit ZIP）
   ↓  自动取品牌 / 名称 / 板子规格
在界面按实物板的排列填 36 个色块的 RGB
   ↓  实时预览 + 体检
导出 采集数据集 ZIP
   ↓
Lumina Studio → 耗材管理 → Single-Stage 数据集上传  导入
```

---

## 采集格式（从线上站点确认，非猜测）

程序输出的结构，依据是 Lumina Studio 线上界面自己的说明文案
（`ext_single_stage_upload_desc`）：

> **「上传按 `{substrate}/{color}/` 结构打包的 ZIP 数据集」**

因此导出的 ZIP 是这样：

```
manifest.json                                 板子规格 + LabelMe 要求
README_dataset.txt
white/<耗材名>/<耗材名>_white.png              合成图（色块按你填的 RGB 上色）
white/<耗材名>/<耗材名>_white.json             LabelMe 标注
black/<耗材名>/<耗材名>_black.png
black/<耗材名>/<耗材名>_black.json
```

- 每个基底目录 = 1 张 PNG + 1 个同名 LabelMe JSON
- LabelMe 里有两个 **polygon**：`stage`（板面）与 `ColorChecker`（色卡）
  —— 与 Kit 的 `manifest.json` 里 `labelme.required_labels: ["ColorChecker","stage"]` 一致
- 耗材名取自**文件夹名**（manifest 里 `color_source: "folder_name"`）

### 为什么图里要画 ColorChecker

Kit 的 `required_labels` 把 `ColorChecker` 列为必需标注，所以程序在每张图的下方
额外绘制一块标准 24 色图（4×6 排列，与站点内置基准「大凡光学」的 24 色 / 4×6 或 3×8 兼容），
并给出对应多边形。

> 提取时**不要勾选「ColorChecker 校色」**——合成图没有真实光照偏差，直出就行。
> 勾了也不会算错（画的就是基准色，CCM 接近单位阵），但没必要。

---

## 用法（4 步）

### ① 导入模板

- 拖入你的**耗材档案包** `lumina_materials_*.zip` → 自动填入**品牌 / 耗材名称**
- 或拖入 **SingleStage Kit ZIP** → 自动读取**板子规格**（网格、层高、步进层数、LabelMe 要求）
- 两个都导入也可以；都不导入则用**内置标准规格**

### ② 填 RGB

- 两个面板：**白底板 / 黑底板**，各 18 格
- 格子排列与实物板**完全一致**：行优先，每行 6 格
  - 第 1 行 = 0–5 层，第 2 行 = 6–11 层，第 3 行 = 12–16 层 + 25 层
- 每格标了 **层数** 与 **厚度（mm）**，**按格子上标的层数填**
- 零厚度格默认已填成基底本色（白底=255,255,255；黑底=0,0,0），可自行改
- 若你手上是 0–1 线性值，勾选「输入是 0–1 线性值」
- 也可用「导出 测量 CSV」产生的 CSV 再导回来

### ③ 预览

两张图实时渲染，可直接看出格子是否对应错位。

**体检提醒**会自动检查（这正是你现有那份档案出问题的地方）：

- 各通道是否「越厚越亮」（物理上不该出现）
- 是否出现「白底比黑底还暗」
- 零厚度白底是否偏暗（实测应接近纯白）

提醒**不阻止导出**，但强烈建议先修测量。

### ④ 导出

| 按钮 | 产物 | 用途 |
|---|---|---|
| **导出采集数据集 ZIP** | `Lumina_SingleStage_Dataset_*.zip` | **主产物**，在站点「Single-Stage 数据集上传」导入 |
| 导出 1_single_stage.json | 线性 RGB 序列 | 中间采集文件，便于存档或走接口拟合 |
| 导出 测量 CSV | `measurements.csv` | 交给 `lumina_profile_writer.py` 做**离线拟合**（完全不经服务器） |

---

## 导入到 Lumina Studio

1. 打开 Lumina Studio → **耗材管理 → 单阶提取（Single-Stage 数据集上传）**
2. 上传 `Lumina_SingleStage_Dataset_*.zip`
3. 点「提取 1_single_stage.json」，查看**数据集摘要**与**提取警告**
4. 点「继续拟合 Stage A」→ 得到 `stage_A_parameters.json`
5. 回 **耗材库** 确认档案已生成，需要时填写制造商/类型

> 想要**完全不经服务器**：用「导出 测量 CSV」+ `lumina_profile_writer.py`，
> 该脚本的拟合实现已用官方数据逐位验证（三通道 E/k/RMSE 全部复现）。

---

## 已验证 / 未验证（请如实看待）

### ✅ 已在本机实测验证

| 项目 | 结果 |
|---|---|
| 纯 JS ZIP 写入器 | Python `zipfile.testzip()` 返回 `None`（全部条目 CRC 正确） |
| 中文路径 + 嵌套目录 | 正确，UTF-8 标记（flag 0x0800）已设置 |
| 二进制数据完整性 | 逐字节一致 |
| 纯 JS ZIP 读取器 | 成功读取你真实的**耗材档案包**（识别出 大简 / 金 petg hf）与**SingleStage Kit**（step_layers、material_default、required_labels 全部正确） |
| 板面几何 | 合成板面 **1340×680 px = 67×34 mm**，与官方 warp 目标 `warp_width_px:1340 / warp_height_px:680` **完全一致** |
| 采样框位置 | 第 1 格落在 **(56,56) 宽 128 px**，与官方 `sample_boxes[0]` **完全一致** |
| JS 语法 | `node --check` 通过 |

### ⚠️ 无法在本机验证（需要你实际导入一次）

服务端对合成数据集的接受度。具体不确定项：

1. 是否接受 `shape_type: "polygon"`（Kit README 原文写的是 "Required **polygons**"，故按 polygon 实现）
2. `ColorChecker` 多边形是否必须包围一块**可被检测**的色卡（程序已画标准 24 色图并给多边形）
3. `1_single_stage.json` 的结构是从你导出包的 `verification_runs[0].samples`
   （`thickness_mm` / `white_linear` / `black_linear`）**推断**的，未实测

**若导入被拒或提取报错，按这个顺序试**：

1. 确认 ZIP 结构是 `{substrate}/{color}/` 两套（`white/` 与 `black/` 都要有）
2. 提取时**不要勾选** ColorChecker 校色
3. 若提示缺少 ColorChecker 标注，说明服务端要求它可检测 —— 反馈给我，我改成更接近真实色卡的绘制
4. 直接走**离线路线**：`测量 CSV` + `lumina_profile_writer.py`，不依赖服务端

---

## 技术说明

- **单文件 HTML**，无需 Node/Python/服务器，双击即用
- ZIP 读写、CRC32、色彩转换全部为**自己实现**的纯 JS，无第三方库、无 CDN
- 图像用 Canvas 绘制，`toBlob('image/png')` 导出
- 读 ZIP 需要 `DecompressionStream`（Chrome/Edge 103+ 均支持）；写 ZIP 无版本要求
- 界面为深色主题，与 Lumina Studio 观感一致

---

## 相关文件

| 文件 | 说明 |
|---|---|
| `lumina_singlestage_gui.html` | **本程序** |
| `lumina_profile_writer.py` | 离线拟合 E/k/C0 并直接产出耗材档案包（不经服务器） |
| `测量模板.csv` | 36 行空白测量表 |
| `Lumina_手动写耗材档案_指南.md` | 正向模型推导、验证证据、字段对照 |
| `Lumina_梯度卡图像转换流程.md` | 拿到档案后如何做图像转换 |
| `Lumina_两块校准板_参数填写表.md` | LUT 校准板路线的参数表 |
| `recon/` | 本次分析的证据与中间产物（可删） |
