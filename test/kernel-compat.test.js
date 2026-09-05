const test = require("node:test");
const assert = require("node:assert");

function checkKernelCompat(targetVer) {
  if (!targetVer) return { ok: true };
  const clean = targetVer.replace(/^v/, "").trim();
  const major = parseInt(clean.split(".")[0], 10);
  if (!isNaN(major) && major >= 2) {
    return {
      ok: false,
      message: `检测到官方内核版本 v${targetVer} 包含跨大版本重构架构变更。请先升级 DSH Desktop 桌面外壳客户端后再升级内核。`
    };
  }
  return { ok: true };
}

test("checkKernelCompat 校验常规版本与大版本边界", () => {
  assert.strictEqual(checkKernelCompat("0.1.1").ok, true);
  assert.strictEqual(checkKernelCompat("v1.2.3").ok, true);
  assert.strictEqual(checkKernelCompat("v1.9.9-rc.1").ok, true);
  assert.strictEqual(checkKernelCompat("2.0.0").ok, false);
  assert.strictEqual(checkKernelCompat("v2.1.0").ok, false);
  assert.strictEqual(checkKernelCompat("3.0.0").ok, false);
});
