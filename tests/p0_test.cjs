// 抽出真实的「持久化 + CSV」代码，在隔离沙箱里跑回归测试。
// 用 new Function 而不是 eval：函数声明不会泄漏到模块作用域，也不会重复声明报错。
const fs = require("fs");
const html = fs.readFileSync("lumina_singlestage_gui.html", "utf8");

const start = html.indexOf("const CAL_MODES = [");
const end = html.indexOf('document.getElementById("calMode").addEventListener("change"');
if (start < 0 || end < 0) { console.error("抽取失败", start, end); process.exit(1); }
const code = html.slice(start, end);
console.log(`抽取代码 ${code.length} 字符`);

const EXPORTS = ["CAL_MODES","cal","calStore","calSerialize","calPersistNow","calSetSaveHint",
                 "calRestore","calCsvText","calCsvImport","calCsvKeys","calKey","calPageDef",
                 "calData","clamp8"];
const factory = new Function(
  "localStorage", "document", "showStatus", "hideStatus", "CAL_PX", "confirm",
  code + "\nreturn {" + EXPORTS.join(",") + "};"
);

function makeSandbox() {
  const lsData = {};
  const localStorage = {
    getItem: k => (k in lsData ? lsData[k] : null),
    setItem: (k, v) => { if (localStorage.fail) throw new Error("QuotaExceededError"); lsData[k] = String(v); },
    removeItem: k => { delete lsData[k]; },
    _data: lsData, _raw: () => lsData
  };
  const dom = {};
  const document = {
    getElementById: id => (dom[id] = dom[id] || { value:"", textContent:"", innerHTML:"", style:{}, className:"", addEventListener(){} }),
    querySelectorAll: () => [], querySelector: () => null, addEventListener(){}
  };
  const mod = factory(localStorage, document, () => {}, () => {}, 20, () => true);
  return { mod, localStorage, document };
}

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 与键顺序无关地比较两个 calStore（对象键序会因写入先后而不同，不能直接 stringify 比） */
function sameStore(a, b) {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (!eq(ka, kb)) return false;
  for (const k of ka) if (!eq(a[k], b[k])) return false;
  return true;
}

/* ============ 测试 1：持久化往返 ============ */
console.log("\n=== 测试 1：持久化往返（跨模式、跨页、稀疏）===");
{
  const { mod, localStorage } = makeSandbox();
  const { cal, calStore, calData, calSerialize, calRestore } = mod;
  cal.modeKey = "C8"; cal.page = 0; cal.sel = 74;
  calData()[0] = { r:255, g:255, b:0 };
  calData()[38] = { r:0, g:0, b:0 };
  calData()[1368] = { r:90, g:90, b:90 };
  cal.modeKey = "CMYW"; cal.page = 0; cal.sel = 5;
  calData()[100] = { r:10, g:200, b:30 };
  cal.modeKey = "C5EXT"; cal.page = 1; cal.sel = 3;
  calData()[1443] = { r:1, g:2, b:3 };
  const snapshot = JSON.parse(JSON.stringify(calStore));

  localStorage.setItem("lumina-calv1", JSON.stringify(calSerialize()));
  const bytes = localStorage.getItem("lumina-calv1").length;
  for (const k of Object.keys(calStore)) delete calStore[k];
  cal.modeKey = "BW"; cal.page = 0; cal.sel = 0;
  const restored = calRestore();

  ok(sameStore(calStore, snapshot), "所有单元格逐一还原一致");
  ok(restored === 5, "返回恢复格数 = 5", restored);
  ok(cal.modeKey === "C5EXT", "恢复上次模式 = C5EXT", cal.modeKey);
  ok(cal.page === 1, "恢复上次页码 = 1", cal.page);
  ok(cal.sel === 3, "恢复上次选中格 = 3", cal.sel);
  console.log(`  （5 个格子的存储体积 ${bytes} 字节）`);
}

/* ============ 测试 2：CSV 往返 ============ */
console.log("\n=== 测试 2：CSV 导出 → 导入 往返 ===");
{
  const { mod } = makeSandbox();
  const { cal, calStore, calData, calCsvKeys, calCsvText, calCsvImport } = mod;
  cal.modeKey = "C8"; cal.page = 0; cal.sel = 0;
  calData()[0] = { r:255, g:255, b:0 };
  calData()[1368] = { r:90, g:90, b:90 };
  cal.modeKey = "CMYW"; cal.page = 0;
  calData()[100] = { r:10, g:200, b:30 };
  cal.modeKey = "C5EXT"; cal.page = 1;
  calData()[1443] = { r:1, g:2, b:3 };

  const keys = calCsvKeys(true);
  ok(keys.length === 3, "覆盖 3 个有数据的板块", JSON.stringify(keys));
  const csv = calCsvText(keys);
  ok(csv.count === 4, "统计色块数 = 4", csv.count);
  ok(csv.text.includes("# mode,8-Color Max"), "含 # mode 段落标记");
  ok(csv.text.includes("# page,2"), "含 # page 段落标记（第 2 页）");
  console.log("  ---- CSV 前 10 行 ----");
  csv.text.split("\n").slice(0, 10).forEach(l => console.log("  | " + l));

  const before = JSON.parse(JSON.stringify(calStore));
  for (const k of Object.keys(calStore)) delete calStore[k];
  const r = calCsvImport(csv.text);
  ok(r.total === 4, "导入色块数 = 4", r.total);
  ok(r.boards === 3, "导入板块数 = 3", r.boards);
  ok(sameStore(calStore, before), "导入后数据与导出前完全一致（与键序无关）");
}

/* ============ 测试 3：格式兼容与健壮性 ============ */
console.log("\n=== 测试 3：格式兼容与健壮性 ===");
{
  const { mod } = makeSandbox();
  const { cal, calStore, calCsvImport, clamp8 } = mod;
  mod.CAL_MODES.find(m => m.key === "RYBW");

  cal.modeKey = "CMYW"; cal.page = 0;
  let t = calCsvImport("index,r,g,b\n0,11,22,33\n7,44,55,66\n");
  ok(t.total === 2 && calStore["CMYW#0"][0].r === 11 && calStore["CMYW#0"][7].b === 66,
     "接受 4 列 index,r,g,b");

  delete calStore["CMYW#0"];
  t = calCsvImport("row,col,r,g,b\n2,3,77,88,99\n");
  ok(t.total === 1 && calStore["CMYW#0"][2*32+3].g === 88, "接受 5 列 row,col,r,g,b");

  t = calCsvImport("# mode,4-Color (RYBW)\n# page,1\nindex,row,col,r,g,b\n5,0,5,1,2,3\n");
  ok(t.total === 1 && !!calStore["RYBW#0"], "按 # mode 段落导入到对应模式");
  ok(cal.modeKey === "RYBW", "导入后自动切到该模式", cal.modeKey);

  t = calCsvImport("# mode,4-Color (RYBW)\nindex,row,col,r,g,b\n99999,0,0,1,1,1\n");
  ok(t.total === 0, "越界索引全部丢弃", t.total);

  t = calCsvImport("# mode,4-Color (RYBW)\nindex,row,col,r,g,b\n3,0,3,999,-5,300\n");
  const c = calStore["RYBW#0"][3];
  ok(c.r === 255 && c.g === 0 && c.b === 255, "越界数值钳制到 0–255", JSON.stringify(c));

  t = calCsvImport("hello\nworld\n,,,\n");
  ok(t.total === 0, "垃圾输入不产生数据", t.total);

  ok(clamp8(-5) === 0 && clamp8(300) === 255 && clamp8(128.6) === 129 && clamp8("abc") === 0,
     "clamp8 边界正确");

  // 只导出当前页时，不应带上别的板块
  cal.modeKey = "RYBW"; cal.page = 0;
  const one = mod.calCsvKeys(false);
  ok(eq(one, ["RYBW#0"]), "「当前页」只导出本板块", JSON.stringify(one));
}

/* ============ 测试 4：存储不可用时不崩 ============ */
console.log("\n=== 测试 4：localStorage 不可用（隐私模式 / 配额满）===");
{
  const { mod, localStorage } = makeSandbox();
  localStorage.fail = true;
  let threw = false, hint = "";
  try { mod.calPersistNow(); } catch (e) { threw = true; }
  ok(!threw, "写入失败时不抛异常（应降级为提示）");
  ok(mod.calSetSaveHint && true, "存在降级提示函数");
}

/* ============ 测试 5：模式改名后旧数据不炸 ============ */
console.log("\n=== 测试 5：本地存了未知模式时不应崩 ===");
{
  const { mod, localStorage } = makeSandbox();
  localStorage.setItem("lumina-calv1", JSON.stringify({
    v:1, mode:"GONE", page:0, sel:0, d:{ "GONE#0": {"0":[1,2,3]}, "C8#0": {"5":[4,5,6]} } }));
  let threw = false, n = 0;
  try { n = mod.calRestore(); } catch (e) { threw = true; console.log("    异常: " + e.message); }
  ok(!threw, "不抛异常");
  ok(n === 1, "只恢复已知模式的 1 格", n);
  ok(mod.cal.modeKey === "BW", "未知模式回落为默认 BW", mod.cal.modeKey);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
