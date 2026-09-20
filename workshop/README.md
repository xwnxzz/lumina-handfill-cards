# 手填色卡 · Hand-fill Cards

Lumina Studio 创意工坊模块。用**手工测量**的色块 RGB 生成梯度卡与校准板板面图，
再把确认后的板面图交给 Lumina 打印 —— 不需要用官方「拍照提取」流程，
也就不受拍摄条件、光照和白平衡的影响。

适合这些场景：手上有色差仪/色度计；打印底板颜色和标准白差别较大；
拍出来的板子总是对不齐或反光；想逐格核对每一个数值。

## 它做什么

**① 梯度卡（单阶板）**
3 × 6 = 18 个色块，层数按 `0,1,2,…,16,25` 递增（0.08 mm 层高，最大 2 mm）。
把每格实测的 RGB 填进去，实时预览白底板 / 黑底板两张图，
导出 1340 × 680 PNG（对应 67 × 34 mm，20 px/mm）。

**② 校准板（LUT 管理）**
覆盖官方全部校准板模式：2 色 BW、4 色 CMYW / RYBW、5 色扩展（两页）、
6 色 CMYWGK / RYBWGK、8 色 Max（两页）。板面几何、四角角标与槽位配色
都按官方规格实现。

**③ 交给 Lumina**
在 Lumina 里点右下角「把当前板面图交给 Lumina」，把当前板面图连同
物理尺寸与网格节距一起交给转换器，直接走 Lumina 原有的分层叠色与 3MF 输出。

## 输入约定

- 默认是 **sRGB 编码的 0–255 整数**；仪器直接给线性光强 0–1 时勾选「输入已是线性值」
- 仪器给 **Lab / XYZ / 光谱** 的话请先自行转换到 sRGB，本模块不做色彩空间换算
- **留空 = 未测量**，`0` = 实测纯黑。两者含义不同，工具不会把「没填」当成「黑色」

## 权限

只申请两项，都实际使用：

- `project.storage` —— 保存并恢复手工测量的色块数据
- `handoff.image` —— 把确认后的板面图交给 Lumina 转换与打印

没有网络、文件系统路径、Electron 或跨模块访问能力。

## 离线可用

模块是单个自包含 HTML：不请求网络、不加载外部字体或脚本、
不向任何服务器发送数据。测量数据只存在本地（或由 Lumina 的模块存储保管）。

## 另有一个独立版本

同一个工具也以**独立网页**形式发布：下载 `lumina_singlestage_gui.html`
双击用浏览器打开即可，功能完全一致（包括导出 PNG/ZIP 与 CSV）。
本模块是它在创意工坊里的封装。

## 许可

代码 MIT。文档与文字内容 CC BY-NC-SA 4.0。
本项目是**非官方**第三方工具，与 Lumina Studio 官方无关联。

---

# Hand-fill Cards (English)

An installable Lumina Studio Creative Workshop module. Type **hand-measured**
swatch RGB to generate gradient-card and calibration-board images, then hand the
confirmed board image to Lumina for printing — no photo extraction, so shooting
conditions, lighting and white balance do not affect the numbers.

Covers the gradient card (3 × 6, layers `0…16,25` at 0.08 mm) and every official
calibration board mode (BW, CMYW/RYBW 4-color, 5-color extended two pages,
CMYWGK/RYBWGK 6-color, 8-color Max two pages), with official board geometry,
corner markers and slot colours.

Requests two permissions, both actually used: `project.storage` and
`handoff.image`. No network, filesystem paths, Electron or cross-module access.
Single self-contained HTML; works offline.

Code MIT, content CC BY-NC-SA 4.0. Unofficial third-party tool, not affiliated
with Lumina Studio.
