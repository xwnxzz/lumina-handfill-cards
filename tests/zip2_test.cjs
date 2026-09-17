// 抽出真实的 ZIP 写入器，产出真实 zip，交给 Python zipfile 校验。
const fs = require("fs");
const html = fs.readFileSync("lumina_singlestage_gui.html", "utf8");

const s = html.indexOf("const ZIP_CRC");
const e = html.indexOf("function canvasPngBytes");
if (s < 0 || e < 0) { console.error("抽取失败", s, e); process.exit(1); }
const code = html.slice(s, e);
console.log("抽取 ZIP 写入器 " + code.length + " 字符");

const factory = new Function("Blob", code + "\nreturn { zipStore, zipCrc32 };");
const { zipStore, zipCrc32 } = factory(Blob);

(async () => {
  const enc = new TextEncoder();
  // 用真实的 PNG 头 + 一些字节模拟两张图
  const pngA = new Uint8Array([137,80,78,71,13,10,26,10, 0,0,0,13, 73,72,68,82, ...Array(40).fill(7)]);
  const pngB = new Uint8Array([137,80,78,71,13,10,26,10, ...Array(120).fill(200)]);
  const entries = [
    { name: "白底板.png", data: pngA },
    { name: "黑底板.png", data: pngB },
  ];
  const blob = zipStore(entries);
  const buf = Buffer.from(await blob.arrayBuffer());
  fs.mkdirSync(".test-out", { recursive: true });
fs.writeFileSync(".test-out/ziptest2.zip", buf);
  console.log("已写出 .test-out/ziptest2.zip  " + buf.length + " 字节，条目 " + entries.length);
  console.log("PNG-A crc32 = 0x" + zipCrc32(pngA).toString(16));
})();
