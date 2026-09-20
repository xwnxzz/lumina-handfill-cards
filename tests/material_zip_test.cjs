// 「导出可导入 Lumina 的耗材档案 ZIP」的回归测试。
// 重点：
//   1. 浏览器端拟合必须复现官方 E/k（用官方导出包里的 samples，与 Python --selftest 同源）
//   2. Lab / ΔE 定点正确（line化 RGB 直接进 XYZ 矩阵）
//   3. 纯 JS SHA-256 与已知向量一致
//   4. 生成的 ZIP 结构、JSON schema、哈希自洽 —— 对照官方 seed 的事实
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "lumina_singlestage_gui.html"), "utf8");

function braceFrom(startIdx) {
  let i = html.indexOf("{", startIdx), d = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") d++;
    else if (html[i] === "}") { d--; if (d === 0) return html.slice(startIdx, i + 1); }
  }
  throw new Error("括号不配对");
}
function fn(name) {
  const s = html.indexOf("function " + name + "(");
  if (s < 0) throw new Error("找不到 function " + name);
  return braceFrom(s);
}

// 我的新块正好插在 function zipBytes 之前
const blockStart = html.indexOf("function sha256Rotr(");
const blockEnd = html.indexOf("function zipBytes(entries) {");
if (blockStart < 0 || blockEnd < 0) throw new Error("找不到新增实现块");
const featureBlock = html.slice(blockStart, blockEnd);

const region0 = html.slice(html.indexOf("const s2l = c =>"), html.indexOf("function downloadCanvas"));
const regionGrad = html.slice(html.indexOf("const GRAD_SPEC = {"), html.indexOf("function scheduleRefresh(){"));

const STUBS = 'let __captured = null;'
  + 'function isLinear(){ return false; }'
  + 'function saveBlob(blob, filename){ __captured = { blob: blob, filename: filename }; return Promise.resolve("saved"); }'
  + 'const __status = []; function showStatus(id, kind, msg){ __status.push({ id: id, kind: kind, msg: msg }); }';

// ZIP_CRC 是惰性建表的 const，zipCrc32 依赖它
const zipCrcBlock = html.slice(html.indexOf("const ZIP_CRC = (() => {"),
                               html.indexOf("const zipUtf8 = new TextEncoder();"));
const code = [STUBS, region0, regionGrad, zipCrcBlock, fn("zipCrc32"),
              "const zipUtf8 = new TextEncoder();", featureBlock, fn("zipBytes")]
  .join("\n");

const EXPORTS = ["fitProfileJS", "fitChannelJS", "linToLab", "deltaE76", "sha256HexJS",
  "buildStageAJS", "buildMaterialJS", "buildBundleJS", "buildExportJS", "jsonBytes",
  "MAT_SPEC", "matBoardSizePx", "matSampleBoxes", "zipBytes", "isoNow"];

const factory = new Function(code + "\nreturn {" + EXPORTS.join(",") + "};");
const M = factory();

const txtOf = b => Buffer.from(b).toString("utf8");
let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
};
const close = (a, b, tol) => Math.abs(a - b) <= tol;

/* 官方导出包里的 samples（线性值，与 tools/lumina_profile_writer.py --selftest 同源） */
const SAMPLES_W = [[0.65837,0.47932,0.17144],[0.64448,0.47353,0.19120],[0.63760,0.47932,0.23840],
                   [0.63076,0.50888,0.30947],[0.61050,0.55201,0.42869],[0.59062,0.60383,0.57112],
                   [0.59720,0.38133,0.11444],[0.55201,0.33245,0.09990],[0.53328,0.30947,0.09084],
                   [0.53328,0.30947,0.09306],[0.53948,0.31855,0.09990],[0.58408,0.36131,0.11954],
                   [0.57112,0.36131,0.10462],[0.53948,0.31855,0.09084],[0.51492,0.29614,0.08228],
                   [0.50888,0.28315,0.08022],[0.52100,0.29177,0.08438],[0.56471,0.32778,0.09990]];
const SAMPLES_B = [[0.46778,0.40198,0.14413],[0.42327,0.35153,0.12744],[0.35153,0.29177,0.10946],
                   [0.28744,0.23840,0.09306],[0.16203,0.12744,0.05951],[0.02416,0.02624,0.02315],
                   [0.48515,0.39157,0.13014],[0.46208,0.35153,0.11954],[0.44520,0.33245,0.11193],
                   [0.42869,0.31399,0.10462],[0.40724,0.29614,0.10224],[0.39676,0.29614,0.10462],
                   [0.49693,0.36625,0.11444],[0.47353,0.34191,0.10702],[0.46778,0.33245,0.10462],
                   [0.46778,0.33245,0.09990],[0.46208,0.32778,0.09990],[0.46208,0.33245,0.10462]];
const OFFICIAL_FIT = { E: [0.390215, 0.283147, 0.0], k: [0.606487, 1.508833, 0.311095],
                       rmse_linear: 0.09314746978213301 };
const T = M.MAT_SPEC.step_layers.map(k => k * M.MAT_SPEC.layer_height_mm);

/* ===== 1. 浏览器端拟合 vs 官方数值 ===== */
console.log("=== 1) 浏览器端拟合 vs 官方拟合结果 ===");
const fit = M.fitProfileJS(SAMPLES_W, SAMPLES_B, T);
{
  for (let c = 0; c < 3; c++) {
    const nm = "RGB"[c];
    ok(close(fit.E[c], OFFICIAL_FIT.E[c], 5e-3),
       `通道 ${nm} 的 E ≈ ${OFFICIAL_FIT.E[c]}`, fit.E[c].toFixed(6));
    ok(close(fit.k[c], OFFICIAL_FIT.k[c], 5e-3),
       `通道 ${nm} 的 k ≈ ${OFFICIAL_FIT.k[c]}`, fit.k[c].toFixed(6));
  }
  ok(close(fit.rmse_linear, OFFICIAL_FIT.rmse_linear, 5e-4),
     `整体 rmse_linear ≈ ${OFFICIAL_FIT.rmse_linear.toFixed(6)}`, fit.rmse_linear.toFixed(9));
  ok(fit.E.every(v => v >= 0 && v <= 1), "E 被约束在 [0,1]", JSON.stringify(fit.E));
  ok(fit.channel_rmse.every(v => v > 0), "每通道都有 RMSE", JSON.stringify(fit.channel_rmse));
}

/* ===== 2. Lab / ΔE 定点 ===== */
console.log("\n=== 2) Lab / ΔE76 定点校验 ===");
{
  const mid = M.linToLab(0.2158605, 0.2158605, 0.2158605);
  ok(close(mid[0], 53.585, 0.01), "线性灰 0.2158605 的 L* ≈ 53.585", mid[0].toFixed(4));
  const w = M.linToLab(1, 1, 1), b = M.linToLab(0, 0, 0);
  ok(close(w[0], 100, 0.01), "白色 L* = 100", w[0].toFixed(4));
  ok(close(b[0], 0, 0.01), "黑色 L* = 0", b[0].toFixed(4));
  ok(close(M.deltaE76(w, b), 100, 0.01), "黑白 ΔE76 = 100", M.deltaE76(w, b).toFixed(4));
  ok(close(w[1], 0, 0.01) && close(w[2], 0, 0.01), "中性灰 a*/b* = 0");
}

/* ===== 3. 纯 JS SHA-256 ===== */
console.log("\n=== 3) 纯 JS SHA-256 vs 已知向量 ===");
{
  const enc = new TextEncoder();
  ok(M.sha256HexJS(enc.encode("")) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
     "空串", M.sha256HexJS(enc.encode("")).slice(0, 16) + "…");
  ok(M.sha256HexJS(enc.encode("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
     "\"abc\"", M.sha256HexJS(enc.encode("abc")).slice(0, 16) + "…");
  const long = "a".repeat(1000);
  ok(M.sha256HexJS(enc.encode(long)) === "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
     "1000 个 a（跨块）", M.sha256HexJS(enc.encode(long)).slice(0, 16) + "…");
}

/* ===== 4. 生成的档案包 ===== */
console.log("\n=== 4) 档案包结构与 schema ===");
const BRAND = "测试品牌", NAME = "测试PLA";
let entries, byName;
{
  const warns = ["示例提醒"];
  const stageA = M.buildStageAJS(NAME, fit, warns, "PLA Basic");
  const mat = M.buildMaterialJS(NAME, BRAND, fit, warns, stageA, M.MAT_SPEC);
  const matBytes = M.jsonBytes(mat);
  const stageBytes = M.jsonBytes(stageA);
  const bundle = M.buildBundleJS(BRAND, NAME, matBytes, stageBytes, M.MAT_SPEC, mat.material_summary);
  entries = [
    { name: "lumina_material_export.json", data: M.jsonBytes(M.buildExportJS(BRAND + "/" + NAME)) },
    { name: "lumina_material_bundle.json", data: M.jsonBytes(bundle) },
    { name: `materials/${BRAND}/${NAME}/material.json`, data: matBytes },
    { name: `materials/${BRAND}/${NAME}/stage_A_parameters.json`, data: stageBytes },
  ];
  byName = Object.fromEntries(entries.map(e => [e.name, e.data]));

  // 4.1 四个条目与官方/脚本一致
  ok(entries.length === 4, "共 4 个条目", entries.length);
  ok(!!byName["lumina_material_export.json"], "含 lumina_material_export.json");
  ok(!!byName["lumina_material_bundle.json"], "含 lumina_material_bundle.json");
  ok(!!byName[`materials/${BRAND}/${NAME}/material.json`], "含 material.json");
  ok(!!byName[`materials/${BRAND}/${NAME}/stage_A_parameters.json`], "含 stage_A_parameters.json");

  // 4.2 stage_A_parameters.json
  const sa = JSON.parse(txtOf(stageBytes));
  ok(sa.param_type === "stage_A", "param_type = stage_A", sa.param_type);
  ok(sa.meta.schema_version === "1.0", "meta.schema_version = 1.0");
  ok(sa.meta.source === "lumina_gradient_card_extract", "meta.source 与官方一致", sa.meta.source);
  ok(sa.meta.workflow === "single-stage-kit", "meta.workflow = single-stage-kit");
  ok(sa.meta.image_source === "manual_measurement", "image_source 标为手工测量");
  ok(Array.isArray(sa.meta.warnings), "meta.warnings 是数组");
  ok(sa.parameters.channels.length === 1 &&
     sa.parameters.channels[0].color_name === NAME &&
     sa.parameters.channels[0].E.length === 3 && sa.parameters.channels[0].k.length === 3,
     "channels[0] 含 E/k 各 3 分量");
  ok(sa.parameters.substrates.length === 2 &&
     sa.parameters.substrates[0].substrate_id === "white" &&
     sa.parameters.substrates[1].substrate_id === "black" &&
     sa.parameters.substrates.every(s => s.C0.length === 3),
     "substrates 含 white/black 的 C0");
  ok(!!sa.fitted_substrates.white.C0 && !!sa.fitted_substrates.black.C0, "fitted_substrates 含两基 C0");
  const ov = sa.validation.overall;
  ok(["mean_delta_e","max_delta_e","rmse_linear","channel_rmse"].every(k => k in ov),
     "validation.overall 含官方四个指标", Object.keys(ov).join(","));
  ok(sa.source.spec.grid_cols === 6 && sa.source.spec.step_layers.length === 18,
     "source.spec 是 11 字段规格（step_layers 18 项）");
  ok(sa.source.manifest.workflow === "single-stage-kit", "source.manifest 齐全");

  // 4.3 material.json
  const mat2 = JSON.parse(txtOf(matBytes));
  ok(mat2.kind === "lumina_stage_a_material", "kind = lumina_stage_a_material", mat2.kind);
  ok(mat2.schema_version === "1.1", "schema_version = 1.1", mat2.schema_version);
  ok(mat2.material_name === NAME && mat2.brand === BRAND, "写入品牌与耗材名");
  ok(mat2.stage_a_params_file === "stage_A_parameters.json", "stage_a_params_file 正确");
  const ms = mat2.material_summary;
  ok(ms.sample_count === 36 && ms.per_substrate_sample_count === 18, "36 / 18 样本数");
  ok(ms.warp_width_px === 1340 && ms.warp_height_px === 680,
     "warp = 1340×680（官方实测值）", ms.warp_width_px + "×" + ms.warp_height_px);
  ok(JSON.stringify(ms.thickness_layers) === JSON.stringify(M.MAT_SPEC.step_layers),
     "thickness_layers = step_layers");
  ok(ms.sample_boxes.length === 18, "sample_boxes 18 个");
  ok(ms.sample_boxes[0].x === 56 && ms.sample_boxes[0].y === 56 &&
     ms.sample_boxes[0].width === 128 && ms.sample_boxes[0].height === 128 &&
     ms.sample_boxes[0].thickness_layers === 0,
     "sample_boxes[0] 与官方一致（56,56,128,128,0）", JSON.stringify(ms.sample_boxes[0]));
  ok(ms.sample_boxes[18 - 1].x === 1156 && ms.sample_boxes[18 - 1].y === 496 &&
     ms.sample_boxes[18 - 1].thickness_layers === 25,
     "sample_boxes[17] 与官方一致（1156,496,…,25）", JSON.stringify(ms.sample_boxes[17]));
  ok(ms.white_zero_rgb.length === 3 && ms.black_zero_rgb.length === 3 &&
     ms.estimated_rgb.length === 3 && ms.estimated_k.length === 3,
     "三个 RGB 与 estimated_k 都是 3 分量");
  const officialKeys = ["sample_count","per_substrate_sample_count","grid_rows","grid_cols",
    "layer_height_mm","warp_width_px","warp_height_px","thickness_layers","sample_boxes",
    "white_zero_rgb","black_zero_rgb","estimated_rgb","estimated_k","verification_count",
    "aggregation_method","selected_run_count"];
  const missingKeys = officialKeys.filter(k => !(k in ms));
  ok(missingKeys.length === 0, "material_summary 含官方全部 16 个键", JSON.stringify(missingKeys));
  ok(mat2.fit_summary.overall_validation === sa.validation.overall ||
     JSON.stringify(mat2.fit_summary.overall_validation) === JSON.stringify(sa.validation.overall),
     "fit_summary.overall_validation 与 stage_A 的 validation 一致");
  ok(Array.isArray(mat2.verification_runs) && mat2.verification_runs[0].params.E.length === 3,
     "verification_runs[0].params 含 E/k/C0");

  // 4.4 bundle
  const bd = JSON.parse(txtOf(byName["lumina_material_bundle.json"]));
  ok(bd.kind === "lumina_material_bundle" && bd.schema_version === "2.0",
     "bundle kind/schema 与官方一致");
  ok(bd.packages.length === 1 && bd.material_count === 1, "1 个 package");
  const pk = bd.packages[0];
  ok(/^mat_[0-9a-f]{26}$/.test(pk.material_id), "material_id 形如 mat_+26hex", pk.material_id);
  ok(/^rev_[0-9a-f]{26}$/.test(pk.revision_id), "revision_id 形如 rev_+26hex", pk.revision_id);
  ok(/^sha256:[0-9a-f]{64}$/.test(pk.content_hash), "content_hash 形如 sha256:+64hex");
  ok(pk.local_directory === BRAND + "/" + NAME, "local_directory = 品牌/名称");
  ok(pk.files.length === 2 &&
     pk.files[0].role === "material_archive" &&
     pk.files[1].role === "stage_a_parameters",
     "files 两个 role 正确");
  ok(pk.files.every(f => f.required === true && /^[0-9a-f]{64}$/.test(f.sha256)),
     "每个文件都带 sha256 与 required");

  // 4.5 哈希自洽：bundle 里写的 sha256/bytes 必须与实际字节一致
  const matBytes2 = byName[`materials/${BRAND}/${NAME}/material.json`];
  const stageBytes2 = byName[`materials/${BRAND}/${NAME}/stage_A_parameters.json`];
  ok(pk.files[0].sha256 === M.sha256HexJS(matBytes2) && pk.files[0].bytes === matBytes2.length,
     "material.json 的 sha256/bytes 与实际字节一致");
  ok(pk.files[1].sha256 === M.sha256HexJS(stageBytes2) && pk.files[1].bytes === stageBytes2.length,
     "stage_A_parameters.json 的 sha256/bytes 与实际字节一致");
  const concat = new Uint8Array(matBytes2.length + stageBytes2.length);
  concat.set(matBytes2, 0); concat.set(stageBytes2, matBytes2.length);
  ok(pk.content_hash === "sha256:" + M.sha256HexJS(concat),
     "content_hash = sha256(material.json + stage_A_parameters.json)");
  ok(pk.display.estimated_rgb.length === 3, "display.estimated_rgb 已写入");

  // 4.6 文件都是合法 JSON 且以换行结尾（与脚本 dumps() 一致）
  for (const nm of ["lumina_material_bundle.json", "lumina_material_export.json",
                    `materials/${BRAND}/${NAME}/material.json`,
                    `materials/${BRAND}/${NAME}/stage_A_parameters.json`]) {
    const txt = txtOf(byName[nm]);
    let parsed = true;
    try { JSON.parse(txt); } catch (e) { parsed = false; }
    ok(parsed && txt.endsWith("\n"), nm.split("/").pop() + " 是合法 JSON 且以换行结尾");
  }
}

/* ===== 5. 真 ZIP 字节可被标准解压器读出 ===== */
console.log("\n=== 5) ZIP 字节可解析 ===");
{
  const zip = Buffer.from(M.zipBytes(entries));
  // EOCD
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  ok(eocd >= 0, "找到 EOCD");
  const count = zip.readUInt16LE(eocd + 10);
  ok(count === 4, "条目数 = 4", count);
  let off = zip.readUInt32LE(eocd + 16);
  const names = [], datas = {};
  for (let n = 0; n < count; n++) {
    const method = zip.readUInt16LE(off + 10);
    const csize = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const cmtLen = zip.readUInt16LE(off + 32);
    const lho = zip.readUInt32LE(off + 42);
    const nm = zip.slice(off + 46, off + 46 + nameLen).toString("utf8");
    const lNameLen = zip.readUInt16LE(lho + 26), lExtraLen = zip.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    let data = zip.slice(start, start + csize);
    if (method === 8) data = zlib.inflateRawSync(data);
    names.push(nm); datas[nm] = data;
    off += 46 + nameLen + extraLen + cmtLen;
  }
  ok(names.length === 4 && names.every(n => byName[n]), "解出的条目名与写入一致", names.join(" | "));
  ok(Buffer.compare(datas["lumina_material_bundle.json"], Buffer.from(byName["lumina_material_bundle.json"])) === 0,
     "解出的 bundle 字节与源一致");
  ok(datas["lumina_material_bundle.json"].length > 500, "bundle 有实际内容",
     datas["lumina_material_bundle.json"].length + " 字节");
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
