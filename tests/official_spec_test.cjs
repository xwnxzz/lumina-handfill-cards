// 官方规格核对：把 Lumina Studio 2.0 官方资源里的规格固化成契约测试。
//
// 真值来源（本机已安装的官方 2.0 本体，全部为只读核对）：
//   %LOCALAPPDATA%\Lumina Launcher\versions\<hash>\resources\backend\_internal\
//     assets\ref_*.png                 官方参考板图 —— 逐格像素实测出的四角标与调色板
//     assets\*.npy                     官方 LUT / 堆叠表 —— 数组形状即板面规格
//     lut-preset\LUT命名规范*.md        官方「8 色槽位映射」表
//     assets\native_sources\...\forward\bambulab_pla_stage_B.json  官方正向模型参数结构
//
// 目的：官方规格一旦变化（或我们改坏了）立刻能发现。
const fs = require("fs");
const html = fs.readFileSync("lumina_singlestage_gui.html", "utf8");

/* ---------- 官方真值 ---------- */
// 1) 官方 .npy 的数组形状（形状 = 板面规格的直接证据）
const OFFICIAL_NPY = {
  "BW 2色":        { shape: [6, 6, 3],   note: "6×6 数据格" },
  "4色":           { shape: [32, 32, 3], note: "32×32 数据格" },
  "5色(合并)":      { shape: [2468, 3],   note: "1024 + 1444 摊平" },
  "5色页1":        { shape: [32, 32, 3], note: "" },
  "5色页2":        { shape: [38, 38, 3], note: "" },
  "6色":           { shape: [36, 36, 3], note: "36×36 数据格" },
  "8色":           { shape: [74, 37, 3], note: "74 = 2 页 × 37" },
  "8色堆叠表":      { shape: [2738, 5],   note: "2738 = 2 × 37 × 37" },
  "6色堆叠表":      { shape: [1296, 5],   note: "1296 = 36 × 36" },
  "5色页1(临时)":   { shape: [32, 32, 3], note: "" },
  "5色页2(临时)":   { shape: [38, 38, 3], note: "" },
};

// 2) 官方参考板图的四角像素（实测值）。cells = data + 2*pad
const OFFICIAL_CORNERS = {
  BW:     { cells: 8,  tl: [255,255,255], tr: [20,20,20],   br: [20,20,20],   bl: [20,20,20] },
  CMYW:   { cells: 34, tl: [255,255,255], tr: [0,134,214],  br: [236,0,140],  bl: [244,238,42] },
  RYBW:   { cells: 34, tl: [255,255,255], tr: [220,20,60],  br: [0,100,240],  bl: [255,230,0] },
  "C5EXT#0": { cells: 34, tl: [255,255,255], tr: [220,20,60], br: [0,100,240], bl: [255,230,0] },
  "C5EXT#1": { cells: 40, tl: [0,100,240],   tr: [220,20,60], br: [20,20,20],  bl: [255,230,0] },
  C6:     { cells: 38, tl: [255,255,255], tr: [0,134,214],  br: [236,0,140],  bl: [244,238,42] },
  "C8#0": { cells: 39, tl: [255,255,255], tr: [0,134,214],  br: [193,46,31],  bl: [20,20,20] },
};

// 3) 官方《LUT 命名规范》的 8 色槽位映射（顺序即契约）
const OFFICIAL_SLOTS8 = ["White", "Cyan", "Magenta", "Yellow", "Black", "Red", "DeepBlue", "Green"];

// 4) 官方命名规范给出的子模式 → 8 色槽位映射
const OFFICIAL_RECIPE_SLOTS = {
  "4色 RYBW":   [0, 5, 3, 6],                 // 0→White(0) 1→Red(5) 2→Yellow(3) 3→DeepBlue(6)
  "4色 CMYW":   [0, 1, 2, 3],
  "6色 CMYWGK": [0, 1, 2, 7, 3, 4],           // 3→Green(7) 4→Yellow(3) 5→Black(4)
  "6色 RYBWGK": [0, 5, 6, 7, 3, 4],
};

// 5) 官方正向模型参数结构（stage_B）：每通道一组 E / k
const OFFICIAL_STAGE_B = {
  color_name: "bambu green",
  E: [0.019524, 0.448282, 0.040844],
  k: [10.673121, 1.264406, 16.680016],
  k_height_scale_gamma: 0.248934,
  optimizer: { name: "adam", lr: 0.02, stage1_steps: 600, stage2_steps: 800 },
  validation_keys: ["mean_delta_e", "median_delta_e", "p90_delta_e", "max_delta_e"],
};

/* ---------- 从 HTML 里抽真实定义 ---------- */
// 支持 {…} 与 […] 两种字面量（CAL_MODES 是数组，SLOT_COLORS 是对象）
function sliceArr(marker) {
  const s = html.indexOf(marker);
  if (s < 0) throw new Error("找不到 " + marker);
  const openObj = html.indexOf("{", s), openArr = html.indexOf("[", s);
  let b, open, close;
  if (openArr >= 0 && (openObj < 0 || openArr < openObj)) { b = openArr; open = "["; close = "]"; }
  else { b = openObj; open = "{"; close = "}"; }
  let d = 0;
  for (let i = b; i < html.length; i++) {
    const ch = html[i];
    if (ch === open) d++;
    else if (ch === close) { d--; if (d === 0) return html.slice(b, i + 1); }
  }
  throw new Error("括号不配对 " + marker);
}
const code = "const SLOT_COLORS = " + sliceArr("const SLOT_COLORS")
  + ";\nconst CAL_MODES = " + sliceArr("const CAL_MODES") + ";";
const mod = new Function(code + "\nreturn {SLOT_COLORS, CAL_MODES};")();
const { SLOT_COLORS, CAL_MODES } = mod;
const byKey = k => CAL_MODES.find(m => m.key === k);

let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ===== 1. 板面几何：与官方 .npy 形状逐项对齐 ===== */
console.log("=== 1) 板面几何 vs 官方 .npy 形状 ===");
{
  // BW：官方 (6,6,3)；板面图 8×8 = data 6 + 2×pad
  const bw = byKey("BW").pages[0];
  ok(bw.data === OFFICIAL_NPY["BW 2色"].shape[0], "BW data = 6（官方 npy 首维）", bw.data);
  ok(bw.data + 2 * bw.pad === OFFICIAL_CORNERS.BW.cells, "BW 图 8×8 = data+2pad", bw.data + 2 * bw.pad);
  ok(bw.cells === 32, "BW 可测格 = 36 − 4 角标 = 32", bw.cells);

  for (const [key, want] of [["CMYW", [32, 1024]], ["RYBW", [32, 1024]], ["C6", [36, 1296]], ["C6R", [36, 1296]]]) {
    const p = byKey(key).pages[0];
    ok(p.data === want[0] && p.cells === want[1], `${key} data=${want[0]} cells=${want[1]}`,
       `${p.data}/${p.cells}`);
  }
  // 5 色两页：官方两页 npy 分别 (32,32,3) 与 (38,38,3)，合并 (2468,3)
  const ext = byKey("C5EXT").pages;
  ok(ext.length === 2, "C5EXT 两页", ext.length);
  ok(ext[0].data === 32 && ext[0].cells === 1024, "C5EXT 页1 = 32×32", `${ext[0].data}/${ext[0].cells}`);
  ok(ext[1].data === 38 && ext[1].cells === 1444, "C5EXT 页2 = 38×38", `${ext[1].data}/${ext[1].cells}`);
  ok(ext[0].cells + ext[1].cells === OFFICIAL_NPY["5色(合并)"].shape[0],
     "两页合计 2468 = 官方合并 npy 首维", ext[0].cells + ext[1].cells);
  ok(ext[1].data + 2 * ext[1].pad === OFFICIAL_CORNERS["C5EXT#1"].cells,
     "C5EXT 页2 图 40×40", ext[1].data + 2 * ext[1].pad);

  // 8 色两页：官方 (74,37,3) = 2×37；堆叠表 (2738,5)
  const c8 = byKey("C8").pages;
  ok(c8.length === 2, "C8 两页", c8.length);
  ok(c8.every(p => p.data === 37 && p.cells === 1369), "C8 每页 37×37 = 1369");
  ok(OFFICIAL_NPY["8色"].shape[0] === 2 * c8[0].data, "官方 74 = 2 页 × 37", OFFICIAL_NPY["8色"].shape[0]);
  ok(c8[0].cells * 2 === OFFICIAL_NPY["8色堆叠表"].shape[0],
     "8 色合计 2738 = 官方堆叠表行数", c8[0].cells * 2);
  ok(byKey("C6").pages[0].cells === OFFICIAL_NPY["6色堆叠表"].shape[0],
     "6 色 1296 = 官方堆叠表行数", byKey("C6").pages[0].cells);
  // 5 色页1 也印证
  ok(ext[0].data === OFFICIAL_NPY["5色页1"].shape[0], "官方 5色页1 npy 也是 32×32");
}

/* ===== 2. 槽位顺序：与官方命名规范的 8 色映射一致 ===== */
console.log("\n=== 2) 8 色槽位顺序（官方《LUT 命名规范》）===");
{
  ok(SLOT_COLORS.C8.length === 8, "C8 共 8 槽", SLOT_COLORS.C8.length);
  // 官方表给出的槽位颜色名，用「槽位 → 图里实测 RGB」反证顺序
  const officialSlotColor = {
    White: [255,255,255], Cyan: [0,134,214], Magenta: [236,0,140], Yellow: [244,238,42],
    Black: [20,20,20], Red: [193,46,31], DeepBlue: [10,41,137], Green: [0,174,66],
  };
  OFFICIAL_SLOTS8.forEach((name, i) => {
    ok(eq(SLOT_COLORS.C8[i], officialSlotColor[name]),
       `槽 ${i} = ${name} ${JSON.stringify(officialSlotColor[name])}`, JSON.stringify(SLOT_COLORS.C8[i]));
  });
}

/* ===== 3. 子模式调色板：由官方 8 色槽位派生 ===== */
console.log("\n=== 3) 4/6 色调色板 = 官方 8 色槽位的子集 ===");
{
  const s8 = SLOT_COLORS.C8;
  const derive = idxs => idxs.map(i => s8[i]);
  // ⚠️ 官方实测发现：8 色槽位值与 4 色 RYBW 的「标准」值并不相同 ——
  //      Red      8色槽5 = (193,46,31)  但 ref_rybw_standard 实测 = (220,20,60)
  //      DeepBlue 8色槽6 = (10,41,137)  但 ref_rybw_standard 实测 = (0,100,240)
  //    命名规范给的映射是【槽位序号】，不是 RGB 值；每种模式有自己的显示调色板。
  //    因此只对「实测确为子集」的模式做派生校验，RYBW 单独用它的官方标准值校验。
  const subsetOK = [["CMYW", "4色 CMYW"], ["C6", "6色 CMYWGK"], ["C6R", "6色 RYBWGK"]];
  for (const [key, recipe] of subsetOK) {
    const want = derive(OFFICIAL_RECIPE_SLOTS[recipe]);
    ok(eq(SLOT_COLORS[byKey(key).slots], want),
       `${key} 调色板 = 官方 8 色槽位子集 ${JSON.stringify(OFFICIAL_RECIPE_SLOTS[recipe])}`,
       JSON.stringify(SLOT_COLORS[byKey(key).slots]));
  }
  // RYBW / C5EXT：用 ref_rybw_standard.png 与 ref_5color_ext_page*.png 的实测值
  const rybwStd = [[255,255,255],[220,20,60],[255,230,0],[0,100,240]];
  ok(eq(SLOT_COLORS[byKey("RYBW").slots], rybwStd), "RYBW 调色板 = 官方参考板实测值",
     JSON.stringify(SLOT_COLORS[byKey("RYBW").slots]));
  ok(eq(SLOT_COLORS[byKey("C5EXT").slots], rybwStd.concat([[20,20,20]])),
     "C5EXT 调色板 = RYBW 四色 + 黑(20,20,20)",
     JSON.stringify(SLOT_COLORS[byKey("C5EXT").slots]));
  // 记录这条差异，避免以后又有人用「8 色子集」去推 4 色 RYBW
  ok(!eq(derive(OFFICIAL_RECIPE_SLOTS["4色 RYBW"]), rybwStd),
     "官方 8 色槽位值 ≠ 4 色 RYBW 标准值（已确认的官方差异，不是我们的 bug）");
  // C6R 必须有自己的槽位定义（曾经误用 C6）
  ok(byKey("C6R").slots !== byKey("C6").slots, "C6R 使用专属槽位（不是复用 C6）", byKey("C6R").slots);
}

/* ===== 4. 四角标：位置 + 槽位 + 颜色三重核对 ===== */
console.log("\n=== 4) 四角标 vs 官方参考板图实测像素 ===");
{
  const totalOf = (m, pageIdx) => {
    const p = m.pages[pageIdx];
    return { p, total: p.data + 2 * p.pad };
  };
  const resolve = (entry, total) => {
    const [r, c, s] = entry;
    return [r < 0 ? total - 1 : r, c < 0 ? total - 1 : c, s];
  };
  const spec = [
    ["BW", 0, "BW"], ["CMYW", 0, "CMYW"], ["RYBW", 0, "RYBW"],
    ["C5EXT", 0, "C5EXT#0"], ["C5EXT", 1, "C5EXT#1"],
    ["C6", 0, "C6"], ["C8", 0, "C8#0"],
  ];
  for (const [key, pageIdx, refName] of spec) {
    const m = byKey(key);
    const { p, total } = totalOf(m, pageIdx);
    const want = OFFICIAL_CORNERS[refName];
    ok(total === want.cells, `${key}#${pageIdx} 图 ${want.cells}×${want.cells} = data+2pad`, total);
    if (total !== want.cells) continue;
    const pal = SLOT_COLORS[m.slots];
    const pos = new Map();
    for (const e of p.corners) {
      const [r, c, s] = resolve(e, total);
      pos.set(r + "," + c, pal[s]);
    }
    const L = total - 1;
    const got = {
      tl: pos.get("0,0"), tr: pos.get(`0,${L}`),
      br: pos.get(`${L},${L}`), bl: pos.get(`${L},0`),
    };
    for (const k of ["tl", "tr", "br", "bl"]) {
      ok(eq(got[k], want[k]), `${key}#${pageIdx} ${k} = ${JSON.stringify(want[k])}`, JSON.stringify(got[k]));
    }
  }
}

/* ===== 5. 正向模型：与官方 stage_B 参数结构一致 ===== */
console.log("\n=== 5) 正向模型参数结构 vs 官方 stage_B ===");
{
  // 官方 stage_B 的 channels[] 每条含 E[3] 与 k[3] —— 即「逐 RGB 通道一组 E/k」，
  // 这正是本项目拟合器 lumina_profile_writer.py 的模型 C(t)=E+(C0-E)·exp(-k·t)
  const py = fs.readFileSync("tools/lumina_profile_writer.py", "utf8");
  ok(/E\s*=\s*float/.test(py) || /E\[/.test(py) || /"E"/.test(py) || /E = \[/.test(py) || /E\.append/.test(py),
     "拟合器按通道产出 E", null);
  ok(/k\.append|"k"|k = \[/.test(py), "拟合器按通道产出 k", null);
  ok(/exp\(-k \* t\)|np\.exp\(-k/.test(py), "模型含 exp(-k·t)", null);
  ok(/clip\(.*0\.0.*1\.0|E > 1\.0/.test(py), "E 被约束在 [0,1]", null);
  // 官方新增的、我们尚未实现的两项，明确记为「已知差异」
  ok(OFFICIAL_STAGE_B.k_height_scale_gamma > 0, "官方有 k_height_scale_gamma（层高缩放，我们未实现）");
  ok(OFFICIAL_STAGE_B.E.length === 3 && OFFICIAL_STAGE_B.k.length === 3,
     "官方 E / k 都是 3 通道", `${OFFICIAL_STAGE_B.E.length}/${OFFICIAL_STAGE_B.k.length}`);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
