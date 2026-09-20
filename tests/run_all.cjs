// 一次性跑完全部测试。
// 目的：避免逐个 node.exe 调用 —— 在 Windows 上每个子进程都会创建自己的可见
// 控制台窗口，逐个调用会让用户屏幕上不断弹窗。
// 这里只启动【一个】进程，内部所有子进程都用 windowsHide: true（不创建可见窗口）。
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const NODE_TESTS = [
  "workshop_package_test.cjs",
  "official_spec_test.cjs",
  "review2_fixes_test.cjs",
  "review_fixes_test.cjs",
  "p0p1p2_test.cjs",
  "p0_test.cjs",
  "calzip_test.cjs",
  "zip2_test.cjs",
];

const HIDDEN = { windowsHide: true, encoding: "utf8", cwd: ROOT, timeout: 300000 };

function run(exe, args) {
  const r = spawnSync(exe, args, HIDDEN);
  const out = (r.stdout || "") + (r.stderr || "");
  return { code: r.status, out, err: r.error ? String(r.error.message || r.error) : null };
}

const rows = [];
let bad = 0;

for (const t of NODE_TESTS) {
  const r = run(process.execPath, [path.join("tests", t)]);
  const m = r.out.match(/通过 (\d+)，失败 (\d+)/);
  const passed = m ? Number(m[1]) : null;
  const failed = m ? Number(m[2]) : null;
  const ok = r.code === 0 && r.err === null;
  if (!ok) bad++;
  rows.push({ name: t, ok, code: r.code, passed, failed, note: r.err || "" });
}

// Python 自检（拟合结果 + Lab 定点 + 板面规格定点）
let pyPassed = null;
const PY = path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe");
if (fs.existsSync(PY)) {
  const r = run(PY, ["tools/lumina_profile_writer.py", "--selftest"]);
  const ok = r.code === 0 && r.err === null;
  if (!ok) bad++;
  const diffs = (r.out.match(/DIFF/g) || []).length;
  pyPassed = ok && diffs === 0;
  rows.push({ name: "python --selftest", ok, code: r.code, passed: null, failed: null,
              note: r.err || (diffs ? `${diffs} 处 DIFF` : "官方对照全 OK") });
} else {
  rows.push({ name: "python --selftest", ok: false, code: null, passed: null, failed: null,
              note: "找不到 python.exe" });
  bad++;
}

const lines = [];
lines.push("测试汇总（单进程、全部子进程隐藏窗口）");
lines.push("=".repeat(58));
let totalNode = 0;
for (const r of rows) {
  const num = r.passed === null ? "" : `${r.passed}/${(r.passed || 0) + (r.failed || 0)}`;
  if (r.passed !== null) totalNode += r.passed;
  lines.push(`  ${r.ok ? "OK  " : "FAIL"} ${r.name.padEnd(26)} ${num.padEnd(9)} ${r.note}`);
}
lines.push("=".repeat(58));
lines.push(`  Node 断言合计 ${totalNode} 项，Python 自检 ${pyPassed ? "通过" : "失败"}，失败脚本 ${bad} 个`);
lines.push(bad ? "  结论：有失败" : "  结论：全部通过");
console.log(lines.join("\n"));
process.exit(bad ? 1 : 0);
