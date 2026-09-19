// 回归测试：把一轮外部代码评审的发现固化成断言（防止再次退化）
// 用法：在仓库根目录 node tests/review_fixes_test.cjs
const fs = require("fs");
const html = fs.readFileSync("lumina_singlestage_gui.html", "utf8");

function braceFrom(s) {
  let i = html.indexOf("{", s), d = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") d++;
    else if (html[i] === "}") { d--; if (d === 0) return html.slice(s, i + 1); }
  }
  throw new Error("括号不配对");
}
function fn(name) {
  const s = html.indexOf("function " + name + "(");
  if (s < 0) throw new Error("找不到 function " + name);
  return braceFrom(s);
}
const liStart = html.indexOf('document.getElementById("linInput").addEventListener("change"');
const liBody = braceFrom(html.indexOf("() =>", liStart) + 5);

const STUBS = 'const CAL_PX = 20, PX_PER_MM = 20;'
  + "function buildGridsKeepValues(){} function refreshAll(){} function downloadBoard(){}";
const code = [ STUBS,
  html.slice(html.indexOf("const s2l = c =>"), html.indexOf("function downloadCanvas")),
  html.slice(html.indexOf("const GRAD_SPEC = {"), html.indexOf("function scheduleRefresh(){")),
  html.slice(html.indexOf("const SLOT_COLORS"), html.indexOf('document.getElementById("calMode").addEventListener("change"')),
  fn("gradCsvMode"), fn("gradCsvValue"), fn("gradImportCsv"), fn("calCsvImport"), fn("calCsvText"),
  "function __linToggle(){ " + liBody + " }"
].join("\n");

const EXPORTS = ["values","s2l","l2s","chOrNull","clamp8OrNull","clampGrad","isFilled","lumY","sanity","completeMatrix",
  "gradRestore","gradCsvMode","gradCsvValue","gradImportCsv","calCsvImport","calCsvText","calCsvKeys","cal","calStore","calMode","calKey","calData",
  "calSetSelected","calPageDef","isLinear","__linToggle","CAL_MODES","stepLayers","canonIndexFor"];

function build() {
  const ls = {};
  const localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k,v) => { ls[k] = String(v); },
                         removeItem: k => { delete ls[k]; } };
  const mkCtx = () => ({ fillStyle:"", strokeStyle:"", lineWidth:1, font:"", textAlign:"", globalAlpha:1,
    fillRect(){}, strokeRect(){}, clearRect(){}, save(){}, restore(){}, beginPath(){}, closePath(){},
    rect(){}, clip(){}, moveTo(){}, lineTo(){}, stroke(){}, fill(){}, arc(){}, translate(){}, scale(){},
    rotate(){}, setLineDash(){}, drawImage(){}, fillText(){}, strokeText(){}, measureText: () => ({width:0}),
    createLinearGradient: () => ({ addColorStop(){} }) });
  const mk = () => ({ value:"", textContent:"", innerHTML:"", checked:false, style:{}, className:"",
                      width:0, height:0, dataset:{}, addEventListener(){}, setAttribute(){},
                      getContext: () => mkCtx(), querySelectorAll: () => [], children: [] });
  const dom = {};
  const document = { getElementById: id => (dom[id] = dom[id] || mk()),
                     querySelectorAll: () => [], querySelector: () => null, addEventListener(){} };
  const f = new Function("localStorage","document","showStatus","hideStatus","confirm","Blob","TextEncoder",
    code + "\nreturn {" + EXPORTS.join(",") + ", __doc: document, __ls: localStorage};");
  return { mod: f(localStorage, document, ()=>{}, ()=>{}, ()=>true, Blob, TextEncoder) };
}
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); } };

/* ===== 1. 线性切换不再把「未测量」写成 0 ===== */
console.log("=== 1) 线性模式切换：逐通道判空（原 P0-1）===");
{
  const { mod } = build();
  const { values, __linToggle } = mod;
  values.white = values.white.map(() => ({r:null,g:null,b:null}));
  values.black = values.black.map(() => ({r:null,g:null,b:null}));
  values.white[0] = { r:128, g:null, b:null };
  mod.__doc.getElementById("linInput").checked = true;
  __linToggle();
  const v = values.white[0];
  ok(v.r !== null && Number.isFinite(v.r), "已填的 R 被正确转换为线性", v.r);
  ok(v.g === null && v.b === null, "未填的 G/B 保持 null（不再变成 0）", JSON.stringify([v.g, v.b]));
  mod.__doc.getElementById("linInput").checked = false;
  __linToggle();
  ok(values.white[0].r === 128, "切回 sRGB 后 R 还原为 128", values.white[0].r);
}

/* ===== 2. clamp8OrNull 契约 ===== */
console.log("\n=== 2) 空/非法值 → null，不静默变 0（原 P0-2 / P1-7）===");
{
  const { mod } = build();
  const c = mod.clamp8OrNull;
  ok(c("") === null && c("abc") === null && c(null) === null && c(undefined) === null && c(NaN) === null,
     "空 / 非法 / NaN → null");
  ok(c(0) === 0, "0 仍然是 0（实测纯黑是有效数据，不能被当成未测）");
  ok(c(-5) === 0 && c(300) === 255 && c(128.6) === 129, "数值越界照旧钳制");
  ok(mod.chOrNull("") === null && mod.chOrNull("12") === 12 && mod.chOrNull("1e3") === 1000,
     "chOrNull 处理字符串数字");
}

/* ===== 3. 校准板半填：空通道保持 null，且不算已填 ===== */
console.log("\n=== 3) 校准板半填（原 P0-2 / P1-14）===");
{
  const { mod } = build();
  const { cal, calStore, calData, calSetSelected, isFilled } = mod;
  cal.modeKey = "BW"; cal.page = 0;
  calStore["BW#0"] = new Array(32).fill(null);
  cal.sel = 5;
  mod.__doc.getElementById("calR").value = "128";
  mod.__doc.getElementById("calG").value = "";
  mod.__doc.getElementById("calB").value = "";
  calSetSelected();
  const v = calData()[5];
  ok(v.g === null && v.b === null, "空通道保持 null（未测量不冒充黑色）", JSON.stringify(v));
  ok(!isFilled(v), "半填不算「已填」");
  ok(calData().filter(isFilled).length === 0, "计数口径也把半填排除在外");
}

/* ===== 4. sanity 用亮度 Y + 方向感知 ===== */
console.log("\n=== 4) sanity 用亮度 Y + 方向感知（原 P1-5）===");
{
  const { mod } = build();
  const { values, sanity, stepLayers, canonIndexFor, s2l, l2s } = mod;
  const n = stepLayers().length;
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a,b) => canonIndexFor(a) - canonIndexFor(b));
  // 用真实正向模型生成「同一卷亮色耗材」的两块板：
  //   C(t) = E + (C0 - E)·exp(-k·t)，白底 C0=1、黑底 C0=0
  // 数学上 C_white - C_black = exp(-k·t) > 0，所以白底必须始终不暗于黑底
  const E = 0.2, k = 1.8;   // 对比度足够大，亮度变化明显超过容差
  const to8 = lin => Math.max(0, Math.min(255, Math.round(l2s(Math.max(0, Math.min(1, lin))) * 255)));
  order.forEach(pos => {
    const t = stepLayers()[canonIndexFor(pos)] * 0.08;          // mm
    const cw = E + (1 - E) * Math.exp(-k * t);                   // 白底：越厚越暗
    const cb = E * (1 - Math.exp(-k * t));                       // 黑底：越厚越亮（正常！）
    const vw = to8(cw), vb = to8(cb);
    values.white[pos] = { r:vw, g:vw, b:vw };
    values.black[pos] = { r:vb, g:vb, b:vb };
  });
  const msgs = sanity();
  const trend = msgs.filter(m => m.includes("亮度趋势"));
  ok(trend.length === 0, "黑底越厚越亮属于正常，不再误报「趋势反转」", JSON.stringify(trend));
  const cross = msgs.filter(m => m.includes("白底比黑底还暗"));
  ok(cross.length === 0, "白底不暗于黑底：无交叉校验误报", JSON.stringify(cross));

  // 反例：把白底顺序颠倒（模拟「色块 ↔ 厚度」填错）→ 必须报出来
  const bad = build().mod;
  bad.values.white = bad.values.white.map(() => ({r:null,g:null,b:null}));
  bad.values.black = bad.values.black.map(() => ({r:null,g:null,b:null}));
  order.forEach((pos, idx) => {
    const t = stepLayers()[canonIndexFor(pos)] * 0.08;
    const v = to8(E + (1 - E) * Math.exp(-k * t));
    const flipped = order[order.length - 1 - idx];               // 厚度顺序反着填
    bad.values.white[flipped] = { r:v, g:v, b:v };
    bad.values.black[flipped] = { r:v, g:v, b:v };
  });
  const badTrend = bad.sanity().filter(m => m.includes("亮度趋势"));
  ok(badTrend.length > 0, "白底趋势反了能被检出（检查没有被关掉）", JSON.stringify(badTrend));
}

/* ===== 5. localStorage 脏数据被拦截 ===== */
console.log("\n=== 5) 脏 localStorage 校验（原 P1-6）===");
{
  const { mod } = build();
  mod.__ls.setItem("lumina-gradv1", JSON.stringify({
    v:1, lin:false,
    d:{ white:{ "0":[ "abc", null, 999 ], "1":[ NaN, 1, 2 ], "2":[ 1, 2, 3 ] } }
  }));
  const n = mod.gradRestore();
  const v0 = mod.values.white[0], v1 = mod.values.white[1], v2 = mod.values.white[2];
  ok(v0 === undefined || v0 === null || (v0.r === null && v0.b === null),
     "字符串 'abc' 与超范围 999 被拒（不会入库）", JSON.stringify(mod.values.white[0]));
  ok(v1 && v1.r === null, "NaN 被拒", JSON.stringify(v1));
  ok(v2 && v2.r === 1 && v2.g === 2 && v2.b === 3, "合法数据照常恢复", JSON.stringify(v2));
  ok(n === 2, "只恢复了 2 个合法格（第 1 条全被拒、第 2 条 g/b 合法）", n);
}

/* ===== 6. CSV：未知模式整段跳过，不猜 ===== */
console.log("\n=== 6) CSV 未知模式不静默塞进当前板块（原 P2-27）===");
{
  const { mod } = build();
  const { cal, calStore, calCsvImport } = mod;
  cal.modeKey = "C8"; cal.page = 0;
  const csv = "# mode,C8\nindex,row,col,r,g,b\n0,0,0,255,0,0\n"
            + "# mode,不存在的模式\nindex,row,col,r,g,b\n5,0,5,9,9,9\n";
  const r = calCsvImport(csv);
  ok(r.total === 1, "只导入了可识别段落的那 1 格", r.total);
  ok(r.unknown.length === 1, "无法识别的模式被记录下来并上报", JSON.stringify(r.unknown));
  ok(calStore["C8#0"][5] === null || calStore["C8#0"][5] === undefined,
     "未知段落的数据没有被写进 C8（不再猜成当前板块）", JSON.stringify(calStore["C8#0"][5]));
}

/* ===== 7. CSV：稳定 key + label 兼容 ===== */
console.log("\n=== 7) CSV 用稳定 key 导出，同时兼容旧 label（原 P2-27）===");
{
  const { mod } = build();
  const { cal, calStore, calCsvText, calCsvImport, calCsvKeys } = mod;
  cal.modeKey = "C8"; cal.page = 0;
  calStore["C8#0"] = new Array(1369).fill(null);
  calStore["C8#0"][0] = { r:1, g:2, b:3 };
  const txt = calCsvText(calCsvKeys(false), false).text;
  ok(txt.includes("# mode,C8"), "导出写稳定 key");
  ok(txt.includes("# mode_label,8-Color Max"), "同时写 label 供人读");
  // 旧文件（只有 label）仍能导入
  const old = "# mode,8-Color Max\nindex,row,col,r,g,b\n0,0,0,9,8,7\n";
  const r2 = calCsvImport(old);
  ok(r2.total === 1 && calStore["C8#0"][0].r === 9, "旧的 label 格式仍可导入（向后兼容）", r2.total);
}

/* ===== 8. CSV：重复 index 会被计数 ===== */
console.log("\n=== 8) CSV 重复测量值上报（原 P1-8）===");
{
  const { mod } = build();
  const { values, gradImportCsv } = mod;
  values.white = values.white.map(() => ({r:null,g:null,b:null}));
  const r = gradImportCsv("white,0,10,20,30\nwhite,0,99,99,99\n");
  ok(r.dup === 1, "梯度卡 CSV 重复格被计数", r.dup);
  ok(values.white[5].r === 99, "后者覆盖前者（覆盖行为保留，但不再静默）");

  const { mod: m2 } = build();
  m2.cal.modeKey = "BW"; m2.cal.page = 0;
  const r2 = m2.calCsvImport("# mode,BW\nindex,row,col,r,g,b\n3,0,3,1,1,1\n3,0,3,2,2,2\n");
  ok(r2.dup === 1, "校准板 CSV 重复格被计数", r2.dup);
}

/* ===== 9. 结构性清理 ===== */
console.log("\n=== 9) 结构性清理（原 P2-21/22/26/29/30）===");
{
  ok(!/filter\(Boolean\)\.length/.test(html), "「已填」判定已统一为 isFilled（计数处无 filter(Boolean).length）");
  ok(!/new Array\(p\.cells\)\.fill\(\{/.test(html), "calFillAll 不再共享同一对象引用");
  ok(!/\["white","black"\] &&/.test(html), "calPersistNow 的冗余表达式已移除");
  ok(!/JSON\.parse\(JSON\.stringify\(values\)\)/.test(html), "buildGridsKeepValues 不再用 JSON 往返");
  ok((html.match(/addEventListener\("visibilitychange"/g) || []).length === 1, "visibilitychange 只注册一次");
  ok(/function isFilled\(v\) \{\s*\n?\s*return !!v && v\.r != null/.test(html), "isFilled 用 != null 同时排除 null 与 undefined");
  ok(/completeMatrix[\s\S]{0,200}isFilled\(v\)/.test(html), "completeMatrix 复用 isFilled（不再自己判 null）");
  ok(!/function clamp8\(/.test(html), "旧 clamp8 已删除（避免静默变 0）");
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
