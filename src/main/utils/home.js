/**
 * DSH Desktop - Unified DSH_HOME & Runtime Path Resolution
 * 严格对齐 @deepseek-ai/dsh-home-paths 规范，统一数据根目录解析，彻底消除系统 home 混用
 */

const os = require("node:os");
const path = require("node:path");

const DSH_HOME_DIR_NAME = ".dsh";
const DSH_HOME_ENV = "DSH_HOME";

/**
 * 展开波浪号 ~ 路径
 * @param {string} inputPath
 * @param {string} [customHome]
 * @returns {string}
 */
function expandHomePath(inputPath, customHome = os.homedir()) {
  if (!inputPath || typeof inputPath !== "string") return "";
  if (inputPath === "~") return customHome;
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(customHome, inputPath.slice(2));
  }
  return inputPath;
}

/**
 * 获取默认的系统用户 DSH 根目录 (~/.dsh)
 * @param {string} [customHome]
 * @returns {string}
 */
function defaultDshHome(customHome = os.homedir()) {
  return path.join(customHome, DSH_HOME_DIR_NAME);
}

/**
 * 解析唯一的 DSH 用户数据根目录
 * 优先级（从高到低）：
 * 1. 显式传入的 configured 路径
 * 2. process.env.DSH_HOME 环境变量（非空）
 * 3. 操作系统用户主目录下的 ~/.dsh
 * @param {string} [configured]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 绝对规范化路径
 */
function resolveDshHome(configured, env = process.env) {
  const fromEnv = env ? env[DSH_HOME_ENV] : undefined;
  let target = configured;
  if (!target || (typeof target === "string" && target.trim().length === 0)) {
    if (fromEnv !== undefined && typeof fromEnv === "string" && fromEnv.trim().length > 0) {
      target = fromEnv.trim();
    } else {
      target = defaultDshHome();
    }
  }
  return path.resolve(expandHomePath(target));
}

/**
 * 在当前解析的 DSH_HOME 根目录下拼接子路径
 * @param  {...string} segments
 * @returns {string}
 */
function dshHomePath(...segments) {
  return path.join(resolveDshHome(), ...segments);
}

/**
 * 获取 Web Profile 物理目录
 * @param {string} [profileName] 默认为 'web'
 * @param {string} [customDshHome]
 * @returns {string}
 */
function getWebProfileDir(profileName = "web", customDshHome) {
  const base = customDshHome ? resolveDshHome(customDshHome) : resolveDshHome();
  return path.join(base, "profiles", profileName);
}

/**
 * 获取 DSH 技能存放根目录
 * @param {string} [customDshHome]
 * @returns {string}
 */
function getSkillsDir(customDshHome) {
  const base = customDshHome ? resolveDshHome(customDshHome) : resolveDshHome();
  return path.join(base, "skills");
}

/**
 * 获取物理磁盘全局网络垫片路径 (network-shim.js)
 * @param {string} [customDshHome]
 * @returns {string}
 */
function getNetworkShimPath(customDshHome) {
  const base = customDshHome ? resolveDshHome(customDshHome) : resolveDshHome();
  return path.join(base, "network-shim.js");
}

/**
 * 获取明文凭据文件路径 (.credentials.yaml)
 * @param {string} [customDshHome]
 * @returns {string}
 */
function getCredentialsYamlPath(customDshHome) {
  const base = customDshHome ? resolveDshHome(customDshHome) : resolveDshHome();
  return path.join(base, ".credentials.yaml");
}

/**
 * 获取 DPAPI 加密凭据存储文件 (credentials.bin)
 * @param {string} [userDataDir] 可选 Electron app.getPath("userData")
 * @returns {string}
 */
function getEncryptedCredentialsPath(userDataDir) {
  if (userDataDir && typeof userDataDir === "string") {
    return path.join(userDataDir, "credentials.bin");
  }
  return path.join(resolveDshHome(), "credentials.bin");
}

/**
 * 获取进程锁/PID 记录文件 (backend.pid)
 * @param {string} [userDataDir] 可选 Electron app.getPath("userData")
 * @returns {string}
 */
function getPidFilePath(userDataDir) {
  if (userDataDir && typeof userDataDir === "string") {
    return path.join(userDataDir, "backend.pid");
  }
  return path.join(resolveDshHome(), "backend.pid");
}

module.exports = {
  DSH_HOME_DIR_NAME,
  DSH_HOME_ENV,
  expandHomePath,
  defaultDshHome,
  resolveDshHome,
  dshHomePath,
  getWebProfileDir,
  getSkillsDir,
  getNetworkShimPath,
  getCredentialsYamlPath,
  getEncryptedCredentialsPath,
  getPidFilePath,
};
