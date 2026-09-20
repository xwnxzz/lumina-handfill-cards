#!/usr/bin/env node
/* ============================================================================
 * 打包成 Lumina Studio 创意工坊模块。
 *
 * 产出（dist/）：
 *   ui/index.html                                 单文件、完全自包含
 *   manifest.json  assets/icon.png  README.md  LICENSE
 *   xwnxzz.handfill-cards-<version>.lumina-workshop       （ZIP，仅上述根条目）
 *   xwnxzz.handfill-cards-<version>.lumina-workshop.sha256（小写 SHA-256）
 *
 * 依据：官方 Lumina-Workshop-SDK 的 docs/module-development.md「单文件包」一节：
 *   根目录只允许 manifest.json / ui/index.html / assets/icon.png /
 *   assets/gallery/* / README.md / LICENSE；ui/index.html 必须完全内联，
 *   <head> 必须在第一个 <script> 之前，禁用 eval 与动态 import()。
 *
 * 用法： node workshop/build.cjs [--allow-overwrite]
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const W = __dirname;
const DIST = path.join(W, "dist");
const TOOL = path.join(ROOT, "lumina_singlestage_gui.html");

const manifest = JSON.parse(fs.readFileSync(path.join(W, "manifest.json"), "utf8"));
const ID = manifest.id;
const VERSION = manifest.version;
const ASSET = `${ID}-${VERSION}.lumina-workshop`;

/* ------------------------------------------------------------------ 校验工具 */
function assert(cond, msg) {
  if (!cond) { console.error("打包失败：" + msg); process.exit(1); }
}

/* ------------------------------------------------------- 1) 组装 ui/index.html */
let html = fs.readFileSync(TOOL, "utf8");

// 官方硬性要求：<head> 必须出现在第一个 <script> 之前
const headAt = html.indexOf("<head");
const firstScript = html.indexOf("<script");
assert(headAt >= 0, "工具里找不到 <head>");
assert(headAt < firstScript, "<head> 必须在第一个 <script> 之前");

// 官方硬性要求：不得使用 eval / 动态 import()
for (const bad of [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bimport\s*\(/]) {
  assert(!bad.test(html), `工具里出现禁用语法 ${bad}`);
}

// 官方硬性要求：不得引用包内其它文件或外部 URL
const refRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
let m, external = [];
while ((m = refRe.exec(html))) {
  const u = m[1];
  if (!/^(data:|blob:|#)/i.test(u)) external.push(u);
}
assert(external.length === 0, "工具引用了外部资源：" + external.join(", "));

// 注入宿主适配层（放在 </body> 之前，此时工具的画布与状态都已就绪）
const shim = fs
  .readFileSync(path.join(W, "shim.js"), "utf8")
  .replace(/__MODULE_ID__/g, ID)
  .replace(/__MODULE_VERSION__/g, VERSION);
assert(!/__MODULE_(ID|VERSION)__/.test(shim), "shim 里还有未替换的占位符");

const bodyEnd = html.lastIndexOf("</body>");
assert(bodyEnd > 0, "工具里找不到 </body>");
html = html.slice(0, bodyEnd)
  + "\n<!-- Lumina 创意工坊宿主适配层（构建时内联；独立浏览器打开时不生效） -->\n<script>\n"
  + shim + "\n</script>\n" + html.slice(bodyEnd);

// 注入后再查一次（适配层自己也不能有禁用语法/外部资源）
for (const bad of [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bimport\s*\(/]) {
  assert(!bad.test(shim), `shim 里出现禁用语法 ${bad}`);
}

/* ------------------------------------------------------------- 2) 组装根条目 */
const entries = [];
entries.push(["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")]);
entries.push(["ui/index.html", Buffer.from(html, "utf8")]);

const iconCandidates = [
  path.join(W, "assets", "icon.png"),
  path.join(ROOT, "assets", "logo.png"),
];
const icon = iconCandidates.find(p => fs.existsSync(p));
assert(icon, "找不到图标（workshop/assets/icon.png 或 assets/logo.png）");
entries.push(["assets/icon.png", fs.readFileSync(icon)]);

const readme = path.join(W, "README.md");
const license = path.join(W, "LICENSE");
assert(fs.existsSync(readme), "缺少 workshop/README.md");
assert(fs.existsSync(license), "缺少 workshop/LICENSE");
entries.push(["README.md", fs.readFileSync(readme)]);
entries.push(["LICENSE", fs.readFileSync(license)]);

/* ------------------------------------------------------ 3) 写 ZIP（STORE） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

function buildZip(items) {
  // 固定时间戳 → 可复现构建
  const when = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const t = 0, dt = 0; // 用固定值更稳（0 表示 1980-01-01）
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of items) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // UTF-8 文件名标记
    lh.writeUInt16LE(0, 8);             // STORE
    lh.writeUInt16LE(dt, 10);
    lh.writeUInt16LE(t, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dt, 12);
    ch.writeUInt16LE(t, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 38);            // 外部属性
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const zip = buildZip(entries);

/* ------------------------------------------------------------------ 4) 落盘 */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "ui"), { recursive: true });
fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
for (const [name, data] of entries) fs.writeFileSync(path.join(DIST, name), data);
const zipPath = path.join(DIST, ASSET);
fs.writeFileSync(zipPath, zip);
const sha = crypto.createHash("sha256").update(zip).digest("hex");
fs.writeFileSync(zipPath + ".sha256", sha + "\n");

/* ------------------------------------------------------------------ 5) 报告 */
console.log("创意工坊模块打包完成");
console.log("  模块 id      " + ID);
console.log("  版本          " + VERSION);
console.log("  资产名        " + ASSET);
console.log("  包大小        " + zip.length + " 字节");
console.log("  SHA-256       " + sha);
console.log("  根条目        " + entries.length + " 个：");
for (const [name, data] of entries) {
  console.log(`    ${String(data.length).padStart(9)}  ${name}`);
}
console.log("  ui/index.html " + html.length + " 字符（已内联宿主适配层）");
console.log("  图标来源      " + path.relative(ROOT, icon));
