const fs = require("fs");
const crypto = require("crypto");

/**
 * 校验下载的 Windows 安装包完整性与防篡改哈希 (IMPLEMENT.md 5.2.8 & 5.9 项一)
 * @param {string} installerPath 安装包本地文件路径
 * @param {object} [options] 校验选项
 * @param {number} [options.minSizeBytes=5242880] 最小允许尺寸，默认 5MB
 * @param {string} [options.expectedSha256] 远端清单或 Release 声明的预期 SHA-256 哈希
 * @returns {{ verified: boolean, size: number, hash?: string, warning?: string }}
 */
function verifyInstallerIntegrity(installerPath, options = {}) {
  if (!installerPath || !fs.existsSync(installerPath)) {
    throw new Error(`安装包文件不存在: ${installerPath}`);
  }

  const minSize = typeof options.minSizeBytes === "number" ? options.minSizeBytes : 5 * 1024 * 1024;
  const stats = fs.statSync(installerPath);

  if (stats.size < minSize) {
    try {
      fs.unlinkSync(installerPath);
    } catch (_e) {}
    throw new Error(`安装包文件尺寸异常 (${stats.size} 字节，小于最小阈值 ${minSize} 字节)，下载未能完整结束`);
  }

  const fileBuffer = fs.readFileSync(installerPath);
  const actualHash = crypto.createHash("sha256").update(fileBuffer).digest("hex").toLowerCase();

  if (options.expectedSha256) {
    const expected = String(options.expectedSha256).trim().toLowerCase();
    if (actualHash !== expected) {
      try {
        fs.unlinkSync(installerPath);
      } catch (_e) {}
      throw new Error(`安装包 SHA-256 完整性哈希校验失败 (实际: ${actualHash.slice(0, 16)}..., 预期: ${expected.slice(0, 16)}...)，防范文件被劫持篡改`);
    }
    return { verified: true, size: stats.size, hash: actualHash };
  }

  return { verified: false, size: stats.size, hash: actualHash, warning: "未提供远端校验哈希" };
}

/**
 * 依据校验结果判断是否允许自动执行安装器 (IMPLEMENT.md 5.2.8 & 5.11 项一)
 * 核心安全防线：无有效可信校验依据时，绝对禁止自动 spawn 执行未经验证的二进制文件
 * @param {{ verified: boolean, size: number, hash?: string, warning?: string }} integrityResult
 * @param {object} [signatureResult] 可选代码签名结果 { valid: boolean }
 * @returns {{ canExecute: boolean, reason?: string }}
 */
function canExecuteInstaller(integrityResult, signatureResult) {
  if (!integrityResult) {
    return { canExecute: false, reason: "安装包校验结果缺失" };
  }
  if (integrityResult.verified) {
    return { canExecute: true };
  }
  if (signatureResult && signatureResult.valid) {
    return { canExecute: true };
  }
  return {
    canExecute: false,
    reason: "缺少远端可信校验哈希或代码签名依据，为防范恶意篡改或劫持，桌面端已阻断自动静默执行",
  };
}

/**
 * 规范化 Release 安装包文件名 (IMPLEMENT.md 5.12，与 scripts/release.mjs 及 package.json productName 严格契约对齐)
 * @param {string} version 版本号 (如 "1.3.0" 或 "v1.3.0")
 * @param {string} [productName="DSH Desktop"] 产品名称
 * @returns {string}
 */
function getExpectedInstallerFileName(version, productName = "DSH Desktop") {
  const cleanVer = String(version || "").trim().replace(/^v/, "");
  return `${productName} Setup ${cleanVer}.exe`;
}

/**
 * 构造 GitHub Release 安装包下载链接并完成安全转义
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {string} tag 如 "v1.3.0"
 * @param {string} [fileName] 若未提供则自动根据 tag 计算
 * @returns {string}
 */
function buildReleaseDownloadUrl(repoOwner, repoName, tag, fileName) {
  const cleanTag = String(tag || "").trim();
  const installerFileName = fileName || getExpectedInstallerFileName(cleanTag);
  const encodedFileName = encodeURIComponent(installerFileName);
  return `https://github.com/${repoOwner}/${repoName}/releases/download/${cleanTag}/${encodedFileName}`;
}

module.exports = {
  verifyInstallerIntegrity,
  canExecuteInstaller,
  getExpectedInstallerFileName,
  buildReleaseDownloadUrl,
};
