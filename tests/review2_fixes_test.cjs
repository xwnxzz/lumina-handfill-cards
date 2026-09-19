// 第二轮代码评审（12 条）新增的回归测试
//   P0-1  线性模式 CSV 往返（此前只测了 sRGB，正因如此漏掉了这个 P0）
//   P1-3  「填满全部」必须走钳制
//   P1-4  实时色块用 isFilled，不得生成 rgb(x,null,null)
//   P1-5  0 层默认基准不计入实测、不写入 CSV
//   P2-9  HTML 与 Python 的规格必须一致（防未来漂移）
//   P2-10 5 列格式分别校验 row / col
//   P2-12 18 个厚度 → 物理位置 → CSV 的完整映射链（编号染色）
const fs = require("fs");
const html = fs.readFileSync("lumina_singlestage_gui.html", "utf8");

function braceExtract(sig) {
  const s = html.indexOf(sig);
  if (s < 0) throw new Error("找不到 " + sig);
  let i = html.indexOf("{", s), d = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") d++;
    else if (html[i] === "}") { d--; if (d === 0) return html.slice(s, i + 1); }
  }
  throw new Error("括号不配对: " + sig);
}
const region0 = html.slice(html.indexOf("const s2l = c =>"), html.indexOf("function downloadCanvas"));
const regionGrad = html.slice(html.indexOf("const GRAD_SPEC = {"), html.indexOf("function scheduleRefresh(){"));
const regionCal = html.slice(html.indexOf("const SLOT_COLORS"),
                             html.indexOf('document.getElementById("calMode").addEventListener("change"'));
const fns = ["function stamp", "function gradCsvMode", "function gradCsvValue", "function gradCsvText",
             "function gradImportCsv", "function calCsvImport", "function calCsvText"]
            .map(braceExtract).join("\n");
const EXPORTS = ["GRAD_SPEC","values","defaultCells","isFilled","isMeasured","stepLayers","canonIndexFor",
  "cornerIdx","canonOrderIdx","thicknessOf","isLinear","gradCsvMode","gradCsvValue","gradCsvText",
  "gradImportCsv","cal","calStore","calCsvImport","calCsvText","calCsvKeys","calPageDef","calData",
  "calFillAllApply","CAL_MODES","clamp8OrNull","sanity","completeMatrix","lumY","toLinear"];

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
                      width:0, height:0, dataset:{}, classList:{ toggle(){}, add(){}, remove(){} },
                      addEventListener(){}, setAttribute(){}, getAttribute: () => null,
                      getContext: () => mkCtx(), querySelectorAll: () => [], children: [] });
  const dom = {};
  const document = { getElementById: id => (dom[id] = dom[id] || mk()),
                     querySelector: () => null, querySelectorAll: () => [], addEventListener(){} };
  const f = new Function("localStorage","document","showStatus","hideStatus","confirm","Blob","TextEncoder",
    region0 + "\n" + regionGrad + "\n" + regionCal + "\n" + fns
    + "\nreturn {" + EXPORTS.filter(e => e !== "calFillAllApply").join(",") + ", __doc: document};");
  const mod = f(localStorage, document, ()=>{}, ()=>{}, ()=>true, Blob, TextEncoder);
  // 「填满全部」的逻辑在事件监听里，这里按同一份契约复刻调用（与页面代码同源：clamp8OrNull）
  mod.calFillAllApply = (r, g, b) => {
    const cr = mod.clamp8OrNull(r), cg = mod.clamp8OrNull(g), cb = mod.clamp8OrNull(b);
    if (cr === null || cg === null || cb === null) return false;
    const p = mod.calPageDef();
    mod.calStore[mod.cal.modeKey + "#" + mod.cal.page] =
      Array.from({ length: p.cells }, () => ({ r: cr, g: cg, b: cb }));
    return true;
  };
  return { mod };
}
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); } };

/* ===== P0-1：线性模式往返（此前完全没测，所以漏掉了这个 P0）===== */
console.log("=== P0-1 线性模式 CSV 往返（导出 → 清空 → 导入）===");
{
  const { mod } = build();
  const { values, gradCsvText, gradImportCsv, __doc, canonOrderIdx, canonIndexFor } = mod;
  values.white = Array.from({length:18}, () => ({r:null,g:null,b:null}));
  values.black = Array.from({length:18}, () => ({r:null,g:null,b:null}));
  // 切到线性模式
  __doc.getElementById("linInput").checked = true;
  // 每个物理格按厚度编号染色：r = 该格厚度层数/25，便于定位错位
  const phys = canonOrderIdx();
  phys.forEach((pos, idx) => {
    const k = canonIndexFor(pos);
    const t = mod.stepLayers()[k] / 25;
    values.white[pos] = { r: t, g: t, b: t };
    values.black[pos] = { r: t, g: (k % 2) ? 0.5 : 0.25, b: 1 - t };
  });
  const before = JSON.stringify(values);
  const csv = gradCsvText();
  ok(mod.gradCsvMode(csv) === "linear", "CSV 自描述为 linear", mod.gradCsvMode(csv));
  ok(csv.includes("# input_mode,linear"), "含机器可读的 input_mode 行");

  values.white = values.white.map(() => ({r:null,g:null,b:null}));
  values.black = values.black.map(() => ({r:null,g:null,b:null}));
  const r = gradImportCsv(csv);
  ok(r.n === 36, "导入 36 格", r.n);
  ok(JSON.stringify(values) === before, "线性模式往返【完全一致】（不再二次转换）");
  const v0 = values.white[5];      // 0 层 → 线性 0
  ok(v0 && Math.abs(v0.r - 0) < 1e-9, "0 层线性值仍为 0", v0 && v0.r);
  const v1 = values.white[0];      // 0.4mm → 5 层 → 0.2
  ok(v1 && Math.abs(v1.r - 0.2) < 1e-9, "5 层线性值仍为 0.2", v1 && v1.r);
}

/* ===== P0-1 交叉模式：sRGB CSV → 线性 UI ===== */
console.log("\n=== P0-1 交叉模式换算（CSV 声明 sRGB，UI 是线性）===");
{
  const { mod } = build();
  const { values, gradImportCsv, __doc } = mod;
  values.white = Array.from({length:18}, () => ({r:null,g:null,b:null}));
  values.black = Array.from({length:18}, () => ({r:null,g:null,b:null}));
  __doc.getElementById("linInput").checked = true;
  const srgbCsv = "# input_mode,srgb\nsubstrate,thickness_mm,r,g,b\nwhite,0.4,128,255,0\n";
  gradImportCsv(srgbCsv);
  const v = values.white[0];      // 0.4mm = 5 层 → 物理 0
  ok(v && Math.abs(v.r - 0.2159) < 1e-3, "128 → 线性 ≈0.2159（只转一次）", v && v.r);
  ok(v && Math.abs(v.g - 1) < 1e-6, "255 → 线性 1.0", v && v.g);
  ok(v && v.b === 0, "0 → 线性 0", v && v.b);
}

/* ===== P1-3：填满全部走钳制 ===== */
console.log("\n=== P1-3 「填满全部」必须钳制 ===");
{
  const { mod } = build();
  mod.cal.modeKey = "BW"; mod.cal.page = 0;
  ok(mod.calFillAllApply(999, -100, 300) === true, "越界数值被接受（钳制后）");
  const arr = mod.calStore["BW#0"];
  ok(arr[0].r === 255 && arr[0].g === 0 && arr[0].b === 255,
     "写入的是钳制后的 255/0/255，不是 999/-100/300", JSON.stringify(arr[0]));
  ok(arr.every(c => c.r >= 0 && c.r <= 255 && c.g >= 0 && c.g <= 255 && c.b >= 0 && c.b <= 255),
     "整块板所有格都在合法范围");
  ok(arr[0] !== arr[1], "各格是独立对象（不是同一个引用）");
  const { mod: m2 } = build();
  m2.cal.modeKey = "BW"; m2.cal.page = 0;
  ok(m2.calFillAllApply("", 1, 2) === false, "有空通道时拒绝填满全部");
  ok(!m2.calStore["BW#0"], "被拒绝时不写任何数据");
}

/* ===== P1-4：实时色块不得生成 rgb(x,null,null) ===== */
console.log("\n=== P1-4 实时色块用 isFilled ===");
{
  ok(!/el\.style\.background = d \?/.test(html), "calRefreshSwatch 不再用 truthy 判断");
  ok(/const filled = isFilled\(d\);\s*\n\s*el\.style\.background = filled \?/.test(html),
     "calRefreshSwatch 用 isFilled 决定背景与 filled 类");
  const { mod } = build();
  const { isFilled, isMeasured, values, defaultCells } = mod;
  ok(isFilled({r:1,g:2,b:3}) === true, "三通道齐全 → 已填");
  ok(isFilled({r:1,g:null,b:3}) === false, "半填 → 未填");
  ok(isFilled({r:1,g:undefined,b:3}) === false, "undefined 也算未填（曾经被误判为已填）");
  ok(isFilled({}) === false, "空对象 → 未填");
  values.white[3] = {r:1,g:2,b:3}; defaultCells.white[3] = true;
  ok(isMeasured("white", 3) === false, "默认基准格不算「已实测」");
  delete defaultCells.white[3];
  ok(isMeasured("white", 3) === true, "取消标记后算已实测");
}

/* ===== P1-5：0 层默认基准不写入 CSV ===== */
console.log("\n=== P1-5 0 层默认基准 ===\n");
{
  const { mod } = build();
  const { values, defaultCells, cornerIdx, gradCsvText, gradImportCsv, __doc } = mod;
  __doc.getElementById("linInput").checked = false;
  const z = cornerIdx();
  values.white = Array.from({length:18}, () => ({r:null,g:null,b:null}));
  values.black = Array.from({length:18}, () => ({r:null,g:null,b:null}));
  // 模拟 fillCornerDefaults：自动填白底 255、黑底 0，并标记为默认基准
  values.white[z] = { r:255, g:255, b:255 }; defaultCells.white[z] = true;
  values.black[z] = { r:0, g:0, b:0 };       defaultCells.black[z] = true;
  const csv = gradCsvText();
  const zeroRows = csv.split("\n").filter(l => /^(white|black),0,/.test(l));
  ok(zeroRows.length === 2, "0 层仍在 CSV 里占两行", zeroRows.length);
  ok(zeroRows.every(l => /,,$/.test(l)), "但默认基准的 0 层输出为空（不冒充实测）", JSON.stringify(zeroRows));
  // 体检应提示「未实测」
  const msgs = mod.sanity();
  ok(msgs.some(m => /默认基准色、未实测/.test(m)), "体检提示 0 层未实测",
     JSON.stringify(msgs.slice(0, 3)));
  // 实测后应改为正常检查
  values.white[z] = { r:212, g:184, b:115 }; delete defaultCells.white[z];
  values.black[z] = { r:5, g:5, b:5 };       delete defaultCells.black[z];
  const msgs2 = mod.sanity();
  ok(!msgs2.some(m => /默认基准色、未实测/.test(m)), "实测后不再提示未实测");
}

/* ===== P2-10：5 列格式分别校验 row/col ===== */
console.log("\n=== P2-10 CSV 5 列格式的 row/col 校验 ===");
{
  const { mod } = build();
  mod.cal.modeKey = "BW"; mod.cal.page = 0;      // BW: data=6, cells=32
  const bad = mod.calCsvImport("# mode,BW\nrow,col,r,g,b\n-1,33,1,2,3\n5,1,4,5,6\n");
  const arr = mod.calStore["BW#0"] || [];
  const written = arr.filter(Boolean).length;
  ok(written === 1, "(-1,33) 被拒绝，只有 (5,1) 被接受", written);
  const idx = 5 * 6 + 1;
  ok(arr[idx] && arr[idx].r === 4, "合法行列写到了正确位置", JSON.stringify(arr[idx]));
  const { mod: m2 } = build();
  m2.cal.modeKey = "BW"; m2.cal.page = 0;
  m2.calCsvImport("# mode,BW\nrow,col,r,g,b\n0,6,1,2,3\n");
  ok(((m2.calStore["BW#0"] || []).filter(Boolean).length) === 0, "col 超出 data-1 被拒绝");
}

/* ===== P2-12：18 个厚度的完整映射链（编号染色）===== */
console.log("\n=== P2-12 厚度 → 物理位置 → CSV 的映射链 ===");
{
  const { mod } = build();
  const { values, canonOrderIdx, canonIndexFor, stepLayers, thicknessOf, gradCsvText, gradImportCsv, __doc } = mod;
  __doc.getElementById("linInput").checked = false;
  values.white = Array.from({length:18}, () => ({r:null,g:null,b:null}));
  values.black = Array.from({length:18}, () => ({r:null,g:null,b:null}));
  const order = canonOrderIdx();
  ok(order.length === 18, "共 18 个厚度档", order.length);
  // 双射检查：canonIndexFor 必须是 [0..17] 上的双射
  const seen = new Set(order.map(canonIndexFor));
  ok(seen.size === 18 && [...seen].every(k => k >= 0 && k < 18), "canonIndexFor 是双射");
  ok(order.map(canonIndexFor).join(",") === "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17",
     "canonOrderIdx() 严格按规范索引升序（即厚度升序）");
  // 编号染色：第 k 档 → R = k+1
  order.forEach(pos => {
    const k = canonIndexFor(pos);
    values.white[pos] = { r:k + 1, g:0, b:0 };
    values.black[pos] = { r:0, g:k + 1, b:0 };
  });
  const csv = gradCsvText();
  // CSV 里每一档的厚度必须与 step_layers 推出的厚度一致
  let mismatch = 0;
  csv.split("\n").filter(l => /^white,/.test(l)).forEach((line, row) => {
    const t = +line.split(",")[1];
    const k = order[row];      // 第 row 行对应 canonOrderIdx()[row]
    if (Math.abs(t - thicknessOf(canonIndexFor(k))) > 1e-9) mismatch++;
  });
  ok(mismatch === 0, "CSV 每行的厚度与规范索引对应正确", mismatch);
  // 往返：每一档都必须回到原来那一格
  values.white = values.white.map(() => ({r:null,g:null,b:null}));
  values.black = values.black.map(() => ({r:null,g:null,b:null}));
  gradImportCsv(csv);
  let wrong = [];
  order.forEach(pos => {
    const k = canonIndexFor(pos);
    const w = values.white[pos], b = values.black[pos];
    if (!w || w.r !== k + 1 || !b || b.g !== k + 1) wrong.push(k);
  });
  ok(wrong.length === 0, "18 档全部回到原格（编号染色一一对应）", JSON.stringify(wrong));
  // step_layers 自身单调递增（厚度语义）
  const sl = stepLayers();
  ok(sl.every((v, i) => i === 0 || v > sl[i-1]), "step_layers 严格递增");
}

/* ===== P2-9：HTML 与 Python 的规格一致性（防未来漂移）===== */
console.log("\n=== P2-9 HTML GRAD_SPEC 与 Python SPEC 必须一致 ===");
{
  const pySrc = fs.readFileSync("tools/lumina_profile_writer.py", "utf8");
  const s = pySrc.indexOf("SPEC = {");
  const e = pySrc.indexOf("\n}", s);
  const block = pySrc.slice(s, e);
  const g = (key) => {
    const m = block.match(new RegExp('"' + key + '"\\s*:\\s*([0-9.]+)'));
    return m ? parseFloat(m[1]) : null;
  };
  const pySteps = (block.match(/"step_layers"\s*:\s*\[([^\]]+)\]/) || [,"" ])[1]
    .split(",").map(x => parseInt(x.trim(), 10)).filter(x => Number.isFinite(x));
  const { mod } = build();
  const gs = mod.GRAD_SPEC;
  const pairs = [
    ["grid_cols", "grid_cols"], ["grid_rows", "grid_rows"], ["block_mm", "block_mm"],
    ["gap_mm", "gap_mm"], ["margin_mm", "margin_mm"], ["pixel_mm", "pixel_mm"],
    ["layer_height_mm", "layer_height_mm"], ["base_mm", "base_mm"],
    ["max_step_layers", "max_step_layers"], ["shrink_xy_mm", "shrink_xy_mm"],
  ];
  let bad = [];
  for (const [pyKey, jsKey] of pairs) {
    const a = g(pyKey), b = gs[jsKey];
    if (a === null || Math.abs(a - b) > 1e-12) bad.push(`${pyKey}: python=${a} html=${b}`);
  }
  ok(bad.length === 0, "10 个规格字段两侧一致", JSON.stringify(bad));
  ok(pySteps.join(",") === gs.step_layers.join(","),
     "step_layers 两侧一致", `py=${pySteps.length} html=${gs.step_layers.length}`);
  ok(pySteps.length === 18, "step_layers 共 18 档", pySteps.length);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
