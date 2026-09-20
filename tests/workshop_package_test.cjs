// 创意工坊模块包的契约测试。
//
//   1. 包结构 —— 按官方 docs/module-development.md「单文件包」一节的硬性规则校验
//   2. manifest —— 闭式 schema、权限白名单、SemVer、id 与资产名一致
//   3. ui/index.html —— 完全内联、head 顺序、无禁用语法
//   4. 协议仿真 —— 用假宿主把适配层的握手与 RPC 跑一遍（不需要真的 Lumina）
//
// 需要先跑 `node workshop/build.cjs` 生成 workshop/dist/。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { MessageChannel } = require("worker_threads");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "workshop", "dist");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "workshop", "manifest.json"), "utf8"));
const pkgPath = path.join(DIST, `${manifest.id}-${manifest.version}.lumina-workshop`);

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
};

if (!fs.existsSync(pkgPath)) {
  console.error(`找不到 ${pkgPath}\n请先运行： node workshop/build.cjs`);
  process.exit(1);
}

/* ---------------------------------------------------- 极简 ZIP 读取（STORE） */
function readZip(buf) {
  // 从 EOCD 反查中央目录
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是合法 ZIP：找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("utf8");
    // 本地头
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    let data = buf.slice(dataStart, dataStart + csize);
    if (method === 8) data = zlib.inflateRawSync(data);
    out.push({ name, method, crc, usize, data });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/* ======================================================================
 * 宿主的 handoff 校验器 —— 规则逐条抄自 Lumina 2.0 真实前端 bundle
 * （Lumina 由本机后端 http://127.0.0.1:8000/ 提供前端）。
 * 关键：layout 的容差是 1e-6（几乎必须精确相等）：
 *     recommendedWidthMm  === columns × pitchMm
 *     recommendedHeightMm === rows    × pitchMm
 * 这条曾经让真机交接失败（我们报 67mm，而 6 × 11 = 66mm）。
 * ====================================================================== */
const HOST_LIMITS = {
  pngSignature: [137, 80, 78, 71, 13, 10, 26, 10],
  maxPixels: 64e6,          // BGe
  sizeMin: 0.5, sizeMax: 9999,   // M7 / E7
  pitchMin: 0.01, pitchMax: 9999, // jGe / FGe
  thickMin: 0.2, thickMax: 50,    // OGe / UGe
  layoutTol: 1e-6,          // A7
  recipeMax: 1024 * 1024,
};
function validateHandoffAsHost(p) {
  const errs = [];
  const inR = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  const strOk = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
  const isObj = v => typeof v === "object" && v !== null && !Array.isArray(v);

  // XGe：PNG 头（签名 + IHDR）
  if (!(p.pngBytes instanceof ArrayBuffer)) { errs.push("handoff-invalid-png: pngBytes 不是 ArrayBuffer"); return errs; }
  const u8 = new Uint8Array(p.pngBytes);
  if (u8.byteLength < 24) errs.push("handoff-invalid-png: 不足 24 字节");
  else {
    if (HOST_LIMITS.pngSignature.some((v, i) => u8[i] !== v)) errs.push("handoff-invalid-png: 签名");
    if (new DataView(p.pngBytes, 8, 4).getUint32(0) !== 13) errs.push("handoff-invalid-png: IHDR 长度");
    if (String.fromCharCode(...u8.slice(12, 16)) !== "IHDR") errs.push("handoff-invalid-png: 缺 IHDR");
  }
  const iw = u8.byteLength >= 24 ? new DataView(p.pngBytes, 16, 8).getUint32(0) : -1;
  const ih = u8.byteLength >= 24 ? new DataView(p.pngBytes, 16, 8).getUint32(4) : -1;

  // $Ge：像素尺寸必须与 PNG 的 IHDR 一致
  if (!Number.isInteger(p.pixelWidth) || !Number.isInteger(p.pixelHeight) ||
      p.pixelWidth < 1 || p.pixelHeight < 1 ||
      p.pixelWidth * p.pixelHeight > HOST_LIMITS.maxPixels ||
      iw !== p.pixelWidth || ih !== p.pixelHeight)
    errs.push("handoff-dimensions-invalid");

  // YGe：物理尺寸 / 总厚度 / layout 自洽
  if (!inR(p.recommendedWidthMm, HOST_LIMITS.sizeMin, HOST_LIMITS.sizeMax) ||
      !inR(p.recommendedHeightMm, HOST_LIMITS.sizeMin, HOST_LIMITS.sizeMax))
    errs.push("handoff-physical-size-invalid");
  if (p.recommendedTotalThicknessMm !== undefined &&
      !inR(p.recommendedTotalThicknessMm, HOST_LIMITS.thickMin, HOST_LIMITS.thickMax))
    errs.push("handoff-physical-size-invalid: 总厚度");
  if (p.layout !== undefined) {
    const e = p.layout;
    if (e.kind !== "square-grid" || !Number.isInteger(e.rows) || !Number.isInteger(e.columns) ||
        e.rows < 1 || e.columns < 1 ||
        !inR(e.pitchMm, HOST_LIMITS.pitchMin, HOST_LIMITS.pitchMax))
      errs.push("handoff-layout-invalid");
    if (Math.abs(p.recommendedWidthMm - e.columns * e.pitchMm) > HOST_LIMITS.layoutTol ||
        Math.abs(p.recommendedHeightMm - e.rows * e.pitchMm) > HOST_LIMITS.layoutTol)
      errs.push("handoff-layout-invalid: 尺寸与行列×节距不自洽");
  }

  // ZGe：身份与配方信封
  if (!strOk(p.moduleId, 128) || !strOk(p.moduleVersion, 128) || !strOk(p.projectId, 256) ||
      p.preserveCanvasBounds !== true || !isObj(p.recipeSource) ||
      p.recipeSource.manifestSchemaVersion !== 1 ||
      p.recipeSource.moduleId !== p.moduleId ||
      p.recipeSource.moduleVersion !== p.moduleVersion ||
      !strOk(p.recipeSource.projectSchemaVersion, 128) ||
      !strOk(p.recipeSource.renderSchemaVersion, 128) ||
      !isObj(p.recipeSource.payload))
    errs.push("handoff-recipe-invalid");
  if (JSON.stringify(p.recipeSource).length > HOST_LIMITS.recipeMax) errs.push("handoff-recipe-too-large");

  // QGe
  if (!(p.colorLibraryId === null || strOk(p.colorLibraryId, 256))) errs.push("handoff-invalid-payload");
  return errs;
}

/* 生成一张真实合法的 PNG（宿主会读 IHDR 并用 createImageBitmap 解码） */
const CRC_T = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makePng(w, h, rgba = [255, 255, 255, 255]) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * stride + 1 + x * 4;
    raw[o] = rgba[0]; raw[o + 1] = rgba[1]; raw[o + 2] = rgba[2]; raw[o + 3] = rgba[3];
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const entries = readZip(fs.readFileSync(pkgPath));
const names = entries.map(e => e.name);
const byName = Object.fromEntries(entries.map(e => [e.name, e.data]));

/* ============================================= 1. 包结构（官方硬性规则） */
console.log("=== 1) 包结构 ===");
{
  const ALLOWED = /^(manifest\.json|ui\/index\.html|assets\/icon\.png|assets\/gallery\/[^/]+\.(png|jpe?g|webp)|README\.md|LICENSE)$/;
  const bad = names.filter(n => !ALLOWED.test(n));
  ok(bad.length === 0, "根条目全部在官方白名单内", JSON.stringify(bad));
  ok(names.includes("manifest.json"), "含 manifest.json");
  ok(names.includes("ui/index.html"), "含 ui/index.html");
  ok(names.includes("assets/icon.png"), "含 assets/icon.png");
  ok(names.includes("README.md"), "含 README.md");
  ok(names.includes("LICENSE"), "含 LICENSE");
  // 不允许额外 JS / sourcemap / 符号链接 / 路径穿越 / 重复或大小写冲突
  ok(!names.some(n => /\.(m?js|ts|map)$/i.test(n) && n !== "ui/index.html"),
     "没有额外 JavaScript 或 source map 文件");
  ok(!names.some(n => n.includes("..") || n.startsWith("/") || n.includes("\\")),
     "没有路径穿越或反斜杠路径");
  const lower = names.map(n => n.toLowerCase());
  ok(new Set(lower).size === lower.length, "没有大小写冲突的重复路径");
  const gallery = names.filter(n => n.startsWith("assets/gallery/"));
  ok(gallery.length <= 20, "gallery 不超过 20 张", gallery.length);
  ok(entries.every(e => e.method === 0 || e.method === 8), "只用 STORE/DEFLATE");
  const total = entries.reduce((a, e) => a + e.usize, 0);
  ok(total < 64 * 1024 * 1024, "解压总量远低于压缩炸弹阈值", total + " 字节");
}

/* ================================================== 2. manifest 闭式校验 */
console.log("\n=== 2) manifest v1 ===");
{
  const KEYS = ["manifestVersion", "id", "version", "name", "description",
                "publisher", "workshopApi", "luminaVersion", "entrypoints", "permissions"];
  const extra = Object.keys(manifest).filter(k => !KEYS.includes(k));
  ok(extra.length === 0, "没有未知字段（官方为闭式结构）", JSON.stringify(extra));
  ok(manifest.manifestVersion === 1, "manifestVersion = 1", manifest.manifestVersion);
  ok(/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id), "id 是小写分段名", manifest.id);
  const SEMVER = /^\d+\.\d+\.\d+$/;
  ok(SEMVER.test(manifest.version), "version 是完整 SemVer", manifest.version);
  ok(SEMVER.test(manifest.workshopApi.min) && SEMVER.test(manifest.workshopApi.maxExclusive),
     "workshopApi 是完整 SemVer");
  ok(manifest.workshopApi.min === "1.0.0" && manifest.workshopApi.maxExclusive === "2.0.0",
     "workshopApi = >=1.0.0 <2.0.0（与官方 SDK 的 API 版本一致）");
  ok(manifest.luminaVersion && SEMVER.test(manifest.luminaVersion.min), "声明了 luminaVersion.min");
  const lt = Object.keys(manifest.name), ld = Object.keys(manifest.description);
  ok(JSON.stringify(lt) === JSON.stringify(["zh-CN", "en-US"]), "名称含 zh-CN 与 en-US", lt.join());
  ok(JSON.stringify(ld) === JSON.stringify(["zh-CN", "en-US"]), "描述含 zh-CN 与 en-US", ld.join());
  ok(manifest.entrypoints.ui === "ui/index.html", "入口是 ui/index.html");
  const PERMS = ["image.pick", "project.storage", "color-library.read", "handoff.image"];
  const pn = manifest.permissions.map(p => p.name);
  ok(pn.every(n => PERMS.includes(n)), "只申请官方 v1 的四种权限", JSON.stringify(pn));
  ok(new Set(pn).size === pn.length, "没有重复权限");
  ok(manifest.permissions.every(p => typeof p.reason === "string" && p.reason.length > 0),
     "每条权限都有理由");
  // 包内 manifest 与仓库里的完全一致，且版本与资产名一致
  ok(byName["manifest.json"].toString("utf8").trim() ===
     fs.readFileSync(path.join(ROOT, "workshop", "manifest.json"), "utf8").trim(),
     "包内 manifest 与仓库一致");
  ok(path.basename(pkgPath) === `${manifest.id}-${manifest.version}.lumina-workshop`,
     "资产名 = <模块id>-<版本>.lumina-workshop", path.basename(pkgPath));
}

/* ============================================ 3. ui/index.html 完全内联 */
console.log("\n=== 3) ui/index.html ===");
{
  const html = byName["ui/index.html"].toString("utf8");
  ok(html.length > 50000, "入口是完整应用（不是占位）", html.length + " 字符");
  const headAt = html.indexOf("<head");
  const firstScript = html.indexOf("<script");
  ok(headAt >= 0 && headAt < firstScript, "<head> 出现在第一个 <script> 之前",
     `head=${headAt} script=${firstScript}`);
  ok(!/\beval\s*\(/.test(html), "没有 eval()");
  ok(!/\bnew\s+Function\s*\(/.test(html), "没有 new Function()");
  ok(!/\bimport\s*\(/.test(html), "没有动态 import()");
  ok(!/\brequire\s*\(/.test(html), "没有 require()");
  const ref = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const ext = [];
  let m;
  while ((m = ref.exec(html))) if (!/^(data:|blob:|#)/i.test(m[1])) ext.push(m[1]);
  ok(ext.length === 0, "没有任何外部 src/href", JSON.stringify(ext));
  ok(!/@import|url\(\s*["']?https?:/i.test(html), "CSS 里没有外部引用");
  ok(html.includes("lumina.workshop.ready"), "已内联宿主适配层");
  ok(html.includes(manifest.id) && html.includes(manifest.version),
     "适配层里写入了正确的模块 id 与版本");
  ok(!/__MODULE_(ID|VERSION)__/.test(html), "占位符已全部替换");
}

/* ==================================== 4. 协议仿真：用假宿主驱动适配层 */
console.log("\n=== 4) 协议仿真（假宿主）===");
{
  const html = byName["ui/index.html"].toString("utf8");
  // 取出内联的适配层（最后一个 <script>…</script>）
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const shim = scripts[scripts.length - 1];
  ok(shim.includes("lumina.workshop.ready"), "取到适配层脚本");

  // ---- 假 window / document ----
  const sentToParent = [];
  const parentObj = { postMessage: (msg) => sentToParent.push(msg) };
  const listeners = [];
  const rootStyle = new Map();
  const classes = new Set();
  const attrs = {};
  const documentElement = {
    lang: "",
    dataset: {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
    style: { setProperty: (k, v) => rootStyle.set(k, v) },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
  };
  const made = [];
  const themeBtn = { style: {} };          // 工具自带的主题按钮，宿主模式应被隐藏
  const fakeDocument = {
    documentElement,
    getElementById: (id) => (id === "themeBtn" ? themeBtn : null),
    createElement: (tag) => {
      const n = { tagName: tag, style: {}, dataset: {}, children: [],
                  setAttribute(k, v) { this[k] = v; }, addEventListener(t, f) { (this._h ||= {})[t] = f; },
                  appendChild(c) { this.children.push(c); } };
      made.push(n);
      return n;
    },
    body: { appendChild: () => {} },
  };
  const fakeWindow = {
    parent: parentObj,
    addEventListener: (t, f) => { if (t === "message") listeners.push(f); },
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
  };

  // 执行适配层
  new Function("window", "document", "setTimeout", "clearTimeout", "console",
               shim + "\n//# sourceURL=workshop-shim.js")(
    fakeWindow, fakeDocument, setTimeout, clearTimeout, console);

  const bridge = fakeWindow.LuminaWorkshop;
  ok(bridge && bridge.inHost === false, "握手前 inHost = false");
  ok(sentToParent.length === 1, "恰好发出 1 条 ready 消息", sentToParent.length);
  const ready = sentToParent[0];
  ok(ready && ready.type === "lumina.workshop.ready", "ready 类型正确");
  ok(ready.moduleId === manifest.id, "ready 里带上模块 id", ready.moduleId);
  ok(ready.moduleVersion === manifest.version, "ready 里带上模块版本", ready.moduleVersion);
  ok(ready.apiVersion === "1.0.0", "apiVersion = 1.0.0", ready.apiVersion);
  ok(Array.isArray(ready.events) && ready.events.includes("ui.stateChanged"),
     "声明了 ui.stateChanged 事件能力");

  // ---- 宿主回 connect（带 MessagePort）----
  const { port1, port2 } = new MessageChannel();
  const fromModule = [];
  let autoReply = true;   // 置 false 模拟「宿主收到但不回应」，用于验证不悬挂
  // 假宿主：自动应答除 ui.getState 以外的请求（ui.getState 由测试手工回，以验证响应处理）
  port1.addEventListener("message", (ev) => {
    const d = ev.data;
    fromModule.push(d);
    if (!autoReply) return;
    if (d && d.kind === "request" && d.method !== "ui.getState") {
      port1.postMessage({
        protocol: "lumina-workshop-rpc", version: 1, kind: "response",
        requestId: d.requestId, ok: true, result: { status: "accepted" },
      });
    }
  });
  port1.start();

  // ★ 真实宿主（Lumina 2.0 前端）是这样发的：端口通过 transfer list 转交，
  //   接收端必须读 MessageEvent.ports —— 早期版本误读 event.data.ports，
  //   导致 connect 被丢弃、永远停在「正在等待模块就绪」。
  //   这个 fixture 之前照着错误实现写，所以没抓到；现在按真实报文形状写。
  listeners.forEach(fn => fn({
    source: parentObj,
    data: { type: "lumina.workshop.connect", sessionId: "session-test" },
    ports: [port2],
  }));
  ok(bridge.inHost === true, "收到 connect 后 inHost = true（端口在 event.ports 上）");
  ok(bridge.client !== null, "建立 RPC 客户端（读 event.ports[0]）");

  // ---- 模块应当发出 ui.getState 与 lifecycle.ready ----
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(() => {
    const methods = fromModule.map(x => x.method);
    ok(fromModule.length >= 2, "发起了至少 2 个 RPC 请求", fromModule.length);
    ok(methods.includes("lifecycle.ready"), "调用了 lifecycle.ready");
    ok(methods.includes("ui.getState"), "调用了 ui.getState");
    const env = fromModule[0];
    ok(env.protocol === "lumina-workshop-rpc" && env.version === 1 && env.kind === "request",
       "请求信封符合协议", JSON.stringify({ p: env.protocol, v: env.version, k: env.kind }));
    ok(typeof env.requestId === "string" && env.requestId.startsWith("req-"),
       "requestId 形如 req-N", env.requestId);
    ok(env.method === "ui.getState", "首个请求是 ui.getState", env.method);

    // ---- 宿主回一个 ui.stateChanged 事件，检查主题/语言/令牌 ----
    port1.postMessage({
      protocol: "lumina-workshop-rpc", version: 1, kind: "event",
      event: "ui.stateChanged",
      payload: { locale: "en-US", theme: "dark",
                 tokens: { "--lumina-accent": "#ff8800",
                           "--lumina-surface": "#111827",
                           "--lumina-surface-muted": "#1f2937",
                           "--lumina-text": "#f8fafc",
                           "--lumina-border": "#374151",
                           "--bad-token": "x" } },
    });
    setTimeout(() => {
      ok(documentElement.lang === "en-US", "应用了宿主语言", documentElement.lang);
      ok(documentElement.dataset.theme === "dark", "应用了宿主主题", documentElement.dataset.theme);
      ok(classes.has("dark"), "深色主题映射到本工具的 .dark 类");
      ok(rootStyle.get("--lumina-accent") === "#ff8800", "写入了 --lumina-accent 令牌");
      ok(rootStyle.get("--acc") === "#ff8800", "令牌映射到工具的 --acc");
      ok(!rootStyle.has("--bad-token"), "非法令牌被忽略");
      // 宿主发布的真实令牌名 → 工具变量
      ok(rootStyle.get("--panel2") === "#1f2937",
         "--lumina-surface-muted → --panel2", rootStyle.get("--panel2"));
      ok(rootStyle.get("--line") === "#374151", "--lumina-border → --line", rootStyle.get("--line"));
      ok(rootStyle.get("--panel") === "#111827", "--lumina-surface → --panel", rootStyle.get("--panel"));
      ok(rootStyle.get("--tx") === "#f8fafc", "--lumina-text → --tx", rootStyle.get("--tx"));
      // 主题交给 Lumina：工具自带的切换按钮必须被隐藏
      ok(themeBtn.style.display === "none", "宿主模式下隐藏工具自带的主题按钮",
         themeBtn.style.display);
      // 宿主在 iframe onLoad 前会忽略 ready，所以模块必须重发
      ok(bridge.readySent >= 1, "至少发过一次 ready", bridge.readySent);

      // ---- 回 ui.getState 的响应，检查响应处理与超时表 ----
      const getState = fromModule.find(x => x.method === "ui.getState");
      port1.postMessage({
        protocol: "lumina-workshop-rpc", version: 1, kind: "response",
        requestId: getState.requestId, ok: true,
        result: { locale: "zh-CN", theme: "light", tokens: {} },
      });
      setTimeout(() => {
        ok(documentElement.lang === "zh-CN", "响应里的状态也被应用", documentElement.lang);
        // 源码层：不能再用 canvas.toBlob（那条路径没有超时，会永远卡在「交接中…」）
        ok(!/\.toBlob\s*\(/.test(shim), "适配层不再使用 canvas.toBlob（同步导出，无悬挂路径）");
        ok(/CLIENT_HANDOFF_TIMEOUT/.test(shim), "有交接硬超时");
        ok(/handoffTimeoutMs/.test(shim), "超时可覆盖（可测）");
        ok(/已发送，等待 Lumina 处理/.test(shim), "等待过程对用户可见");


        // ---- handoffCanvas：检查交接对象字段 ----
        // 必须是真 PNG：宿主会读 IHDR 校验像素尺寸，还会用 createImageBitmap 解码。
        // 适配层走同步的 toDataURL（不用 toBlob —— 它的回调有可能一直不触发）。
        const pngBytes = makePng(1340, 680);
        const pngDataUrl = "data:image/png;base64," + pngBytes.toString("base64");
        const fakeCanvas = {
          width: 1340, height: 680,
          toDataURL: () => pngDataUrl,
        };
        bridge.handoffCanvas(fakeCanvas, {
          projectId: "gradient-white", widthMm: 67, heightMm: 34,
          totalThicknessMm: 3.0,
          layout: { kind: "square-grid", rows: 3, columns: 6, pitchMm: 11 },
          recipe: { white: [], black: [] },
        }).then(() => {
          setTimeout(() => {
            const h = fromModule.find(x => x.method === "handoff.image");
            ok(!!h, "发起了 handoff.image 请求");
            if (h) {
              const p = h.payload;
              ok(p.moduleId === manifest.id, "交接带模块 id");
              ok(p.moduleVersion === manifest.version, "交接带模块版本");
              ok(p.pixelWidth === 1340 && p.pixelHeight === 680, "交接带像素尺寸",
                 `${p.pixelWidth}x${p.pixelHeight}`);
              ok(p.recommendedWidthMm === 67 && p.recommendedHeightMm === 34, "交接带物理尺寸");
              ok(p.preserveCanvasBounds === true, "preserveCanvasBounds = true");
              // 旧断言要求这里必须有 3x6 节距 11mm 的 layout —— 那正是真机失败的写法：
              // 宿主规定 recommendedWidthMm === columns × pitchMm（容差 1e-6），
              // 而板面带 1mm 边距（67mm）与 6×11=66mm 不符，会被判 handoff-layout-invalid。
              // 正确做法是【不给 layout】（可选字段，省略即跳过该校验）。
              ok(p.layout === undefined,
                 "板面图刻意不带 layout（带边距，不符合宿主方形网格自洽规则）",
                 JSON.stringify(p.layout));
              ok(p.recipeSource && p.recipeSource.manifestSchemaVersion === 1,
                 "交接带配方信封");
              ok(typeof p.recipeSource.projectSchemaVersion === "string",
                 "配方信封含 projectSchemaVersion");
              ok(JSON.stringify(p.recipeSource).length < 1024 * 1024,
                 "配方信封小于 1 MiB");
              // ★ 按宿主真实规则整体校验（这条能抓住本次真机失败）
              const errs = validateHandoffAsHost({
                moduleId: p.moduleId, moduleVersion: p.moduleVersion, projectId: p.projectId,
                pngBytes: p.pngBytes, pixelWidth: p.pixelWidth, pixelHeight: p.pixelHeight,
                recommendedWidthMm: p.recommendedWidthMm,
                recommendedHeightMm: p.recommendedHeightMm,
                recommendedTotalThicknessMm: p.recommendedTotalThicknessMm,
                preserveCanvasBounds: p.preserveCanvasBounds,
                colorLibraryId: p.colorLibraryId, recipeSource: p.recipeSource,
                layout: p.layout,
              });
              ok(errs.length === 0, "payload 通过宿主全套校验（含 layout 自洽）", JSON.stringify(errs));
              // 板面带边距，不应给出 layout（给了就会因 6×11≠67 被宿主拒绝）
              ok(p.layout === undefined || (
                   Math.abs(p.recommendedWidthMm - p.layout.columns * p.layout.pitchMm) < 1e-6 &&
                   Math.abs(p.recommendedHeightMm - p.layout.rows * p.layout.pitchMm) < 1e-6),
                 "layout 要么不给，要么与物理尺寸精确自洽", JSON.stringify(p.layout));
              // 反例：校验器本身必须能抓出「67mm + 6×11 节距」这种不自洽
              const bad = validateHandoffAsHost({
                moduleId: "a.b", moduleVersion: "1.0.0", projectId: "p",
                pngBytes: pngBytes.buffer.slice(0), pixelWidth: 1340, pixelHeight: 680,
                recommendedWidthMm: 67, recommendedHeightMm: 34,
                preserveCanvasBounds: true, colorLibraryId: null,
                recipeSource: { manifestSchemaVersion: 1, moduleId: "a.b", moduleVersion: "1.0.0",
                                projectSchemaVersion: "x/v1", renderSchemaVersion: "y/v1", payload: {} },
                layout: { kind: "square-grid", rows: 3, columns: 6, pitchMm: 11 },
              });
              ok(bad.some(e => e.startsWith("handoff-layout-invalid")),
                 "校验器能抓出 layout 与尺寸不自洽（67 ≠ 6×11）", JSON.stringify(bad));

              // 行为层：宿主「收到但不回应」时，必须在硬超时后失败 —— 绝不悬挂。
              // 放在成功路径之后跑，避免与它的自动应答互相干扰。
              autoReply = false;
              bridge.handoffTimeoutMs = 300;
              const tHang = Date.now();
              bridge.handoffCanvas(
                { width: 1340, height: 680, toDataURL: () => pngDataUrl },
                { projectId: "x", widthMm: 67, heightMm: 34 }
              ).then(
                () => ok(false, "宿主不回时应当失败", "竟然成功了"),
                (herr) => {
                  const dt = Date.now() - tHang;
                  ok(herr && herr.code === "CLIENT_HANDOFF_TIMEOUT",
                     "宿主不回时按硬超时失败（不悬挂）",
                     herr ? ((herr.code || "no-code") + " | " + herr.message) : "没有报错");
                  ok(dt >= 250 && dt < 5000, "在超时附近返回（不是永久等待）", dt + "ms");
                }
              ).finally(() => {
                autoReply = true;
                bridge.handoffTimeoutMs = 45000;
                console.log(`\n通过 ${pass}，失败 ${fail}`);
                process.exit(fail ? 1 : 0);
              });
            }
          }, 30);
        }, (e) => { ok(false, "handoffCanvas 抛错", String(e && e.message)); 
          console.log(`\n通过 ${pass}，失败 ${fail}`); process.exit(1); });
      }, 30);
    }, 30);
  }, 60);
}
