// 验证「导出全部页图片→ZIP」：文件名推导 + ZIP 结构（交 Python zipfile 校验）
const fs = require("fs");
const html = fs.readFileSync("lumina_singlestage_gui.html", "utf8");

// 抽出真实代码：CAL_MODES 区块 + ZIP 写入器
const a1 = html.indexOf("const CAL_MODES = [");
const a2 = html.indexOf('document.getElementById("calMode").addEventListener("change"');
const b1 = html.indexOf("const ZIP_CRC");
const b2 = html.indexOf("function canvasPngBytes");
if ([a1,a2,b1,b2].some(x => x < 0)) { console.error("抽取失败", a1,a2,b1,b2); process.exit(1); }
const code = html.slice(a1, a2) + "\n" + html.slice(b1, b2);

const factory = new Function("Blob", "document", "localStorage", "showStatus", "hideStatus", "confirm",
  code + "\nreturn { CAL_MODES, zipBytes, zipStore, zipCrc32 };");
const stub = { getElementById: () => ({ value:"", textContent:"", innerHTML:"", style:{}, className:"", addEventListener(){} }),
               querySelectorAll: () => [], querySelector: () => null, addEventListener(){} };
const { CAL_MODES, zipBytes } = factory(Blob, stub, { getItem:()=>null, setItem(){}, removeItem(){} }, ()=>{}, ()=>{}, ()=>true);

// 与处理函数里同一套命名规则
function namesFor(modeKey) {
  const m = CAL_MODES.find(x => x.key === modeKey);
  const safe = m.label.replace(/[\\/:*?"<>|]/g, "_");
  return m.pages.map((p, idx) => `校准板_${safe}` + (m.pages.length > 1 ? `_第${idx+1}页` : "") + ".png");
}

console.log("=== 各模式「全部页」会产出的文件名 ===");
for (const m of CAL_MODES) console.log("  " + m.key.padEnd(6) + " 页数=" + m.pages.length + "  ->  " + JSON.stringify(namesFor(m.key)));

// 造两张假的 PNG（真魔数 + 载荷），打包
const png = n => { const a = new Uint8Array(60 + n); a.set([137,80,78,71,13,10,26,10], 0); a.fill(n & 255, 8); return a; };
for (const key of ["C8", "BW"]) {
  const names = namesFor(key);
  const zb = zipBytes(names.map((n, i) => ({ name: n, data: png(i + 1) })));
  fs.mkdirSync(".test-out", { recursive: true });
  fs.writeFileSync(`.test-out/calzip-${key}.zip`, Buffer.from(zb));
  console.log(`\n${key}: 写出 .test-out/calzip-${key}.zip  ${zb.length} 字节，${names.length} 个条目`);
}
console.log("\n=== 静态核对：处理函数里的命名表达式 ===");
const h = html.slice(html.indexOf('calExpAll").addEventListener'), html.indexOf('calExpAll").addEventListener') + 2200);
const line = h.split("\n").find(l => l.includes("第${idx+1}页"));
console.log("  源码: " + (line || "(未找到)").trim());
console.log("  一致: " + /`校准板_\$\{safe\}` \+ \(m\.pages\.length > 1 \? `_第\$\{idx\+1\}页` : ""\) \+ "\.png"/.test(line || ""));
