const test = require("node:test");
const assert = require("node:assert");
const { checkKernelCompat, VERIFIED_KERNELS, KERNEL_CHANNELS } = require("../src/main/utils/compat");

test("checkKernelCompat 校验常规版本与大版本边界", () => {
  // 已验证版本
  const resVerified = checkKernelCompat("0.1.5-rc.3");
  assert.strictEqual(resVerified.ok, true);
  assert.strictEqual(resVerified.status, "verified");

  // 未显式验证但在兼容范围内的版本
  const resUnverified = checkKernelCompat("0.1.1");
  assert.strictEqual(resUnverified.ok, true);
  assert.strictEqual(resUnverified.status, "unverified");
  assert.strictEqual(resUnverified.warning, true);

  assert.strictEqual(checkKernelCompat("v1.2.3").ok, true);
  assert.strictEqual(checkKernelCompat("v1.9.9-rc.1").ok, true);

  // 跨大版本阻断门禁
  const resMajor = checkKernelCompat("2.0.0");
  assert.strictEqual(resMajor.ok, false);
  assert.strictEqual(resMajor.status, "incompatible");
  assert.strictEqual(checkKernelCompat("v2.1.0").ok, false);
  assert.strictEqual(checkKernelCompat("3.0.0").ok, false);

  // 空值容错
  assert.strictEqual(checkKernelCompat("").ok, true);
});

test("KERNEL_CHANNELS 常量完整性", () => {
  assert.strictEqual(KERNEL_CHANNELS.LATEST, "latest");
  assert.strictEqual(KERNEL_CHANNELS.NEXT, "next");
});

test("CODE_REVIEW R-04: checkKernelCompat 严格阻断带 Shell 元字符与畸形版本字符串", () => {
  const badInputs = [
    "0.1.7 & whoami",
    "0.1.7 | calc.exe",
    "0.1.7; echo pwned",
    "0.1.7`id`",
    "0.1.7$(whoami)",
    "0.1.7\nwhoami",
    "0.1.7 > output.txt",
    "0.1.7<input.txt",
    "1.2.3 extra-text",
    "v1.2.3 & whoami",
    "abc.def.ghi",
  ];

  for (const bad of badInputs) {
    const res = checkKernelCompat(bad);
    assert.strictEqual(res.ok, false, `必须阻断恶意或畸形版本输入: ${bad}`);
    assert.strictEqual(res.status, "incompatible");
    assert.match(res.message, /目标内核版本格式非法/);
  }
});
