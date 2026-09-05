/**
 * DSH Desktop - Kernel Compatibility Matrix
 * 官方内核版本兼容性矩阵校验
 */
const KERNEL_COMPAT = { min: "0.1.0", max: "2.0.0" };

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

module.exports = {
  KERNEL_COMPAT,
  checkKernelCompat,
};
