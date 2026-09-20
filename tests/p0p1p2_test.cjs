// 覆盖本轮全部改动的回归测试：时间戳、梯度卡持久化、输入钳制、CSV 导入导出往返
const fs = require("fs");
const html = fs.readFileSync("lumina_singlestage_gui.html", "utf8");

function braceExtract(sig) {
  const s = html.indexOf(sig);
  if (s < 0) throw new Error("找不到 " + sig);
  let i = html.indexOf("{", s), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) return html.slice(s, i + 1); }
  }
  throw new Error("括号不配对: " + sig);
}
// 区块 A：梯度卡（含持久化、clampGrad、canon*）
const a1 = html.indexOf("const GRAD_SPEC = {");
const a2 = html.indexOf("function scheduleRefresh(){");
const regionGrad = html.slice(a1, a2);
// 区块 0：s2l / l2s（gradCsvValue 的线性↔sRGB 换算要用）
const region0 = html.slice(html.indexOf("const s2l = c =>"), html.indexOf("function downloadCanvas"));
// 区块 B：校准板（含 CSV 读写）
const b1 = html.indexOf("const CAL_MODES = [");
const b2 = html.indexOf('document.getElementById("calMode").addEventListener("change"');
const regionCal = html.slice(b1, b2);
const fns = ["function stamp", "function gradCsvMode", "function gradCsvValue", "function gradCsvText", "function gradImportCsv"].map(braceExtract).join("\n");

const EXPORTS = ["GRAD_SPEC","values","stepLayers","isLinear","clampGrad","canonIndexFor",
  "cornerIdx","canonOrderIdx","thicknessOf","gradSerialize","gradRestore","gradPersistNow",
  "gradSetSaveHint","stamp","gradCsvText","gradCsvMode","gradCsvValue","gradImportCsv","CAL_MODES","cal","calStore",
  "calCsvText","calCsvImport","calCsvKeys","calKey","calPageDef","calData","clamp8OrNull"];

function build() {
  const ls = {};
  const localStorage = {
    getItem: k => (k in ls ? ls[k] : null),
    setItem: (k, v) => { if (localStorage.fail) throw new Error("Quota"); ls[k] = String(v); },
    removeItem: k => { delete ls[k]; }, _raw: () => ls
  };
  const mk = () => ({ value:"", textContent:"", innerHTML:"", checked:false, style:{},
                      className:"", addEventListener(){}, setAttribute(){},
                      querySelectorAll: () => [], children: [] });
  const dom = {};
  const document = { getElementById: id => (dom[id] = dom[id] || mk()),
                     querySelectorAll: () => [], querySelector: () => null, addEventListener(){} };
  const factory = new Function("localStorage","document","showStatus","hideStatus","confirm","Blob","TextEncoder",
    region0 + "\n" + regionGrad + "\n" + regionCal + "\n" + fns + "\nreturn {" + EXPORTS.join(",") + "};");
  return { mod: factory(localStorage, document, ()=>{}, ()=>{}, ()=>true, Blob, TextEncoder), localStorage, dom };
}

let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); } };

/* ===== ① 时间戳 ===== */
console.log("=== ① 文件名时间戳应为本地时间 ===");
{
  const { mod } = build();
  const got = mod.stamp();
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const want = `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  ok(got === want, "stamp() == 本地时间 " + want, got);
  ok(got.slice(0,8) === want.slice(0,8), "日期部分为本地日期（不再差一天）", got.slice(0,8));
  ok(html.includes("const ts = stamp();"), "两个 ZIP 文件名都用 stamp()");
  // 文件名时间戳必须用本地时间；但耗材档案里的 ISO 时间戳应当用 UTC ISO（官方 created_at 就是 UTC）
  ok(!/function stamp\(\)[\s\S]{0,300}toISOString/.test(html),
     "stamp()（文件名用）里没有 toISOString —— 文件名必须本地时间");
  ok(/function isoNow\(\)\s*\{\s*return new Date\(\)\.toISOString\(\);/.test(html),
     "isoNow()（档案时间戳用）用 UTC ISO —— 与官方 created_at 口径一致");
}

/* ===== ② 梯度卡持久化 ===== */
console.log("\n=== ② 梯度卡持久化往返 ===");
{
  const { mod, localStorage } = build();
  const { values, gradSerialize, gradRestore, gradSetSaveHint } = mod;
  values.white[5] = { r:255, g:255, b:255 };
  values.white[0] = { r:11, g:22, b:33 };
  values.black[5] = { r:0, g:0, b:0 };
  values.white[9] = { r:120, g:null, b:null };        // 填了一半的格子
  const snap = JSON.parse(JSON.stringify(values));
  localStorage.setItem("lumina-gradv1", JSON.stringify(gradSerialize()));
  const bytes = localStorage.getItem("lumina-gradv1").length;
  values.white = values.white.map(() => ({r:null,g:null,b:null}));
  values.black = values.black.map(() => ({r:null,g:null,b:null}));
  const n = gradRestore();
  ok(JSON.stringify(values.white[5]) === '{"r":255,"g":255,"b":255}', "右上角默认格已还原");
  ok(JSON.stringify(values.white[0]) === '{"r":11,"g":22,"b":33}', "普通格已还原");
  ok(JSON.stringify(values.white[9]) === '{"r":120,"g":null,"b":null}', "填了一半的格子保留部分值");
  ok(n === 4, "返回还原格数 = 4", n);
  console.log(`  （存储体积 ${bytes} 字节）`);
}

/* ===== ③ 输入钳制 ===== */
console.log("\n=== ③ 输入钳制 clampGrad ===");
{
  const { mod } = build();
  const c = mod.clampGrad;
  ok(c("") === null && c(null) === null && c("abc") === null, "空/非法 → null");
  ok(c("999") === 255 && c("-5") === 0, "sRGB 越界夹到 0–255", c("999") + "," + c("-5"));
  ok(c("128.7") === 129, "sRGB 取整", c("128.7"));
  ok(c("255") === 255 && c("0") === 0, "边界保留");
}

/* ===== ④ CSV 导出/导入往返（梯度卡）===== */
console.log("\n=== ④ 梯度卡 CSV 往返（含无表头文件，验证③修复）===");
{
  const { mod } = build();
  const { values, gradCsvText, gradImportCsv } = mod;
  values.white[5] = { r:255, g:255, b:255 };
  values.white[0] = { r:11, g:22, b:33 };
  values.black[12] = { r:200, g:100, b:50 };
  const csv = gradCsvText();
  const lines = csv.trim().split("\n");
  ok(lines[0].startsWith("#"), "首行是注释头");
  ok(lines.some(l => l.startsWith("substrate,thickness_mm,r,g,b")), "含表头行");
  ok(lines.length === 6 + 18*2, "行数 = 6 行头（含 input_mode 声明）+ 36 数据", lines.length);
  ok(csv.includes("white,0,255,255,255"), "右上角(0 层)导出正确");
  ok(csv.includes("black,2,200,100,50"), "25 层 = 2mm 导出正确");

  // 往返
  const before = JSON.stringify(values);
  values.white = values.white.map(() => ({r:null,g:null,b:null}));
  values.black = values.black.map(() => ({r:null,g:null,b:null}));
  const r1 = gradImportCsv(csv);
  ok(r1.n === 3, "带表头导入 3 格", r1.n);
  ok(JSON.stringify(values) === before, "带表头往返一致");

  // ★ 关键：无表头文件，第一行不能被丢掉
  values.white = values.white.map(() => ({r:null,g:null,b:null}));
  values.black = values.black.map(() => ({r:null,g:null,b:null}));
  const noHeader = "white,0,10,20,30\nwhite,0.08,40,50,60\nblack,0,70,80,90\n";
  const r2 = gradImportCsv(noHeader);
  ok(r2.n === 3, "无表头导入 3 行（旧实现只会有 2）", r2.n);
  ok(JSON.stringify(values.white[5]) === '{"r":10,"g":20,"b":30}', "无表头时第一行被正确导入");
  ok(JSON.stringify(values.black[5]) === '{"r":70,"g":80,"b":90}', "无表头的黑底板行正确");

  // 其它健壮性
  const r3 = gradImportCsv("# 注释\n\nsubstrate,thickness_mm,r,g,b\nwhite,99,1,2,3\n");
  ok(r3.n === 0 && r3.skipped >= 2, "注释/空行/表头/未知厚度 都被跳过", JSON.stringify(r3));
  const r4 = gradImportCsv("white,0,999,-5,300\n");
  const v = values.white[5];
  ok(v.r === 255 && v.g === 0 && v.b === 255, "导入值也被钳制", JSON.stringify(v));
}

/* ===== ⑤ 校准板 CSV「含未填格」===== */
console.log("\n=== ⑤ 校准板 CSV 含未填格选项 ===");
{
  const { mod } = build();
  const { cal, calStore, calCsvText, calCsvImport, calCsvKeys } = mod;
  cal.modeKey = "BW"; cal.page = 0;
  calStore["BW#0"] = new Array(32).fill(null);
  calStore["BW#0"][0] = { r:1, g:2, b:3 };
  const keys = calCsvKeys(false);
  const compact = calCsvText(keys, false);
  const full = calCsvText(keys, true);
  const dataLines = x => x.text.split("\n").filter(l => /^\d/.test(l)).length;
  ok(dataLines(compact) === 1, "默认只导出已填格（1 行）", dataLines(compact));
  ok(dataLines(full) === 32, "勾选后导出全部 32 格", dataLines(full));
  ok(full.text.includes("0,0,0,1,2,3"), "已填格带 RGB");
  ok(/^17,2,5,,,$/m.test(full.text), "未填格 RGB 留空（BW: 索引17 → 行2 列5）", (full.text.match(/^17,.*$/m)||[])[0]);
  // 含空格的 CSV 仍能无损往返
  calStore["BW#0"] = new Array(32).fill(null);
  const rr = calCsvImport(full.text);
  ok(rr.total === 1, "含空格的 CSV 导入只计 1 格", rr.total);
  ok(JSON.stringify(calStore["BW#0"][0]) === '{"r":1,"g":2,"b":3}', "值正确");
  ok(calStore["BW#0"].filter(Boolean).length === 1, "空行不会被误当成数据");
}

/* ===== ⑥ 死代码与防重入 ===== */
console.log("\n=== ⑥ 死代码清理 / 防重入 ===");
{
  ok(!html.includes("calColorOf"), "calColorOf 已删除");
  ok(!html.includes("calSlotColor"), "calSlotColor 已删除");
  ok(!html.includes("calPending"), "calPending 已改名");
  ok(html.includes("if (saving) return \"busy\""), "saveBlob 有防重入");
  ok(html.includes("if (exporting) return"), "两个多文件导出有防重入");
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
