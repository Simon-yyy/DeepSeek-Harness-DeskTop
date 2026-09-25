/**
 * DSH Desktop - Kernel Compatibility Matrix
 * 官方内核版本兼容性矩阵校验与通道规范
 */

const KERNEL_CHANNELS = {
  LATEST: "latest",
  NEXT: "next",
};

// 经官方回归与沙箱实测验证通过的内核版本白名单
const VERIFIED_KERNELS = [
  "0.1.2-rc.1",
  "0.1.5-rc.1",
  "0.1.5-rc.3",
  "0.1.7-rc.2",
];

const KERNEL_COMPAT = {
  min: "0.1.0",
  max: "2.0.0",
  verified: VERIFIED_KERNELS,
  channels: KERNEL_CHANNELS,
};

// 严格 SemVer 规范正则 (包含数字主版本.次版本.修订号以及可选的预发布后缀，严禁空格、控制字符与 Shell 元字符)
const STRICT_SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * 校验目标内核版本的兼容性状态
 * @param {string} targetVer 目标版本号（如 0.1.5-rc.3, v0.1.7-rc.2）
 * @returns {{ ok: boolean, status: 'verified'|'unverified'|'incompatible'|'unknown', warning?: boolean, message?: string }}
 */
function checkKernelCompat(targetVer) {
  if (!targetVer) {
    return { ok: true, status: "unknown" };
  }

  const clean = targetVer.replace(/^v/, "").trim();

  // 严格 SemVer 全格式校验，阻断带 &、|、空格等 Shell 注入与畸形字符串 (CODE_REVIEW R-04)
  if (!STRICT_SEMVER_REGEX.test(clean)) {
    return {
      ok: false,
      status: "incompatible",
      message: `目标内核版本格式非法或包含不安全字符: ${targetVer}`,
    };
  }

  const parts = clean.split(".");
  const major = parseInt(parts[0], 10);

  if (isNaN(major) || major < 0) {
    return {
      ok: false,
      status: "incompatible",
      message: `目标内核版本格式非法: ${targetVer}`,
    };
  }

  // 大版本跨代阻断门禁 (>=2.0.0)
  if (major >= 2) {
    return {
      ok: false,
      status: "incompatible",
      message: `检测到官方内核版本 v${clean} 包含跨大版本重构架构变更。请先升级 DSH Desktop 桌面外壳客户端后再升级内核。`,
    };
  }

  // 检查是否在已验证兼容清单中
  if (VERIFIED_KERNELS.includes(clean)) {
    return {
      ok: true,
      status: "verified",
      message: `官方内核 v${clean} 已通过桌面客户端回归验证。`,
    };
  }

  // 处于 0.x / 1.x 范围内但未进入显式验证清单
  return {
    ok: true,
    status: "unverified",
    warning: true,
    message: `内核版本 v${clean} 属于 0.x/1.x 兼容范围，但尚未进入官方完整回归验证清单。升级后如遇问题可回退或重新检测。`,
  };
}

module.exports = {
  KERNEL_CHANNELS,
  VERIFIED_KERNELS,
  KERNEL_COMPAT,
  checkKernelCompat,
};
