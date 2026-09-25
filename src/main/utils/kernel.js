/**
 * DSH Desktop - Kernel Resolution & Toolchain Utility
 * 官方内核查找、版本仲裁与工具链定位工具
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { compareVersions } = require("./version");

/**
 * 递归向上查找并读取 @deepseek-ai/dsh 的 package.json 版本号
 * @param {string} binPath 目标入口文件路径（如 lib/bin.js）
 * @returns {string|null} 版本号字符串，未找到时返回 null
 */
function readPackageVersion(binPath) {
  if (!binPath || !fs.existsSync(binPath)) return null;
  try {
    let dir = path.dirname(binPath);
    for (let i = 0; i < 4; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "@deepseek-ai/dsh" && pkg.version) {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // 忽略异常，容错返回
  }
  return null;
}

/**
 * 定位宿主机 Node.js 可执行文件路径
 * @returns {string|null}
 */
function resolveNode() {
  if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) {
    return process.env.DSH_NODE;
  }
  const roots = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "nodejs") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "nvm") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "fnm_multishells") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Volta", "bin") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "scoop", "apps", "nodejs", "current") : null,
  ].filter(Boolean);

  for (const root of roots) {
    const nodeExe = path.join(root, "node.exe");
    if (fs.existsSync(nodeExe)) return nodeExe;
  }

  const which = spawnSync("where", ["node"], { encoding: "utf8", shell: true, windowsHide: true });
  if (which.status === 0 && which.stdout.trim()) {
    const hit = which.stdout.trim().split(/\r?\n/).find((line) => /node\.exe$/i.test(line));
    if (hit) return hit;
  }

  return process.execPath;
}

/**
 * 定位 npm 可执行文件路径
 * @returns {string}
 */
function resolveNpm() {
  const nodeBin = resolveNode();
  if (nodeBin && fs.existsSync(nodeBin)) {
    const nodeDir = path.dirname(nodeBin);
    const npmCmd = path.join(nodeDir, "npm.cmd");
    if (fs.existsSync(npmCmd)) return npmCmd;
    const npmExe = path.join(nodeDir, "npm.exe");
    if (fs.existsSync(npmExe)) return npmExe;
  }
  const which = spawnSync("where", ["npm"], { encoding: "utf8", shell: true, windowsHide: true });
  if (which.status === 0 && which.stdout.trim()) {
    const hit = which.stdout.trim().split(/\r?\n/).find((line) => /npm\.cmd$/i.test(line) || /npm$/i.test(line));
    if (hit) return hit;
  }
  return "npm";
}

/**
 * 定位 npx 可执行文件路径
 * @returns {string}
 */
function resolveNpx() {
  const nodeBin = resolveNode();
  if (nodeBin && fs.existsSync(nodeBin)) {
    const nodeDir = path.dirname(nodeBin);
    const npxCmd = path.join(nodeDir, "npx.cmd");
    if (fs.existsSync(npxCmd)) return npxCmd;
    const npxExe = path.join(nodeDir, "npx.exe");
    if (fs.existsSync(npxExe)) return npxExe;
  }
  const which = spawnSync("where", ["npx"], { encoding: "utf8", shell: true, windowsHide: true });
  if (which.status === 0 && which.stdout.trim()) {
    const hit = which.stdout.trim().split(/\r?\n/).find((line) => /npx\.cmd$/i.test(line) || /npx$/i.test(line));
    if (hit) return hit;
  }
  return "npx";
}

/**
 * 评估一组候选路径中最优的内核文件
 * @param {string[]} candidates 候选 bin.js 路径列表
 * @returns {{ best: string|null, bestVer: string|null, bestTime: number }}
 */
function selectBestCandidate(candidates) {
  let best = null;
  let bestVer = null;
  let bestTime = 0;

  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    try {
      const ver = readPackageVersion(c);
      const st = fs.statSync(c);
      if (!best) {
        best = c;
        bestVer = ver;
        bestTime = st.mtimeMs;
        continue;
      }

      if (ver && bestVer) {
        const cmp = compareVersions(ver, bestVer);
        if (cmp > 0) {
          best = c;
          bestVer = ver;
          bestTime = st.mtimeMs;
        } else if (cmp === 0 && st.mtimeMs > bestTime) {
          best = c;
          bestTime = st.mtimeMs;
        }
      } else if (ver && !bestVer) {
        best = c;
        bestVer = ver;
        bestTime = st.mtimeMs;
      } else if (!ver && !bestVer && st.mtimeMs > bestTime) {
        best = c;
        bestTime = st.mtimeMs;
      }
    } catch {
      // 忽略单个文件的读取错误
    }
  }

  return { best, bestVer, bestTime };
}

/**
 * 专门解析随包内置的离线兜底内核
 * @param {object} [options]
 * @returns {{ path: string|null, version: string|null, source: 'bundled' }}
 */
function resolveBundledKernel(options = {}) {
  const appRoot = options.appRoot || path.resolve(__dirname, "../../../");
  const resPath = options.resourcesPath || (process.resourcesPath || null);
  const cwd = process.cwd();

  const bundledCandidates = [
    resPath ? path.join(resPath, "backend", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    resPath ? path.join(resPath, "app.asar.unpacked", "bundled-backend", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    resPath ? path.join(resPath, "bundled-backend", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    path.join(appRoot, "bundled-backend", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(cwd, "bundled-backend", "@deepseek-ai", "dsh", "lib", "bin.js"),
  ].filter(Boolean);

  const res = selectBestCandidate(bundledCandidates);
  return {
    path: res.best,
    version: res.bestVer,
    source: "bundled",
  };
}

/**
 * 核心仲裁：解析并返回系统当前应当使用的最优 DSH 内核 bin.js 路径及元数据
 * 规则：
 * 1. DSH_BIN 环境变量最高优先级；
 * 2. 仲裁全局正式安装/本地包 vs 随包内置离线包；
 *    若外部安装了版本号更高的内核（如通过 upgradeKernel 升级成功），优先使用更新版本；
 *    若外部未安装或版本 <= 内置版本，优先使用内置离线包以保证确定性。
 * @param {object} [options]
 * @param {string} [options.appRoot] 应用程序根目录（默认为 __dirname 两层上）
 * @param {string} [options.resourcesPath] Electron 打包资源路径
 * @returns {{ path: string|null, version: string|null, source: 'env'|'installed'|'bundled'|'npx'|null }}
 */
function resolveDshKernel(options = {}) {
  // 1. 显式环境变量强覆盖
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
    return {
      path: process.env.DSH_BIN,
      version: readPackageVersion(process.env.DSH_BIN),
      source: "env",
    };
  }

  const appRoot = options.appRoot || path.resolve(__dirname, "../../../");
  const resPath = options.resourcesPath || (process.resourcesPath || null);
  const cwd = process.cwd();

  // 2. 搜集随包内置的离线微内核候选路径
  const bundledResult = resolveBundledKernel(options);



  // 3. 搜集全局/本地已安装的正式候选路径
  const nodeBin = resolveNode();
  const nodeDir = nodeBin && fs.existsSync(nodeBin) ? path.dirname(nodeBin) : null;

  const globalCandidates = [
    path.join(appRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(cwd, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    nodeDir ? path.join(nodeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
  ].filter(Boolean);

  const globalResult = selectBestCandidate(globalCandidates);

  // 4. 搜集 npx 缓存候选路径
  const cacheRoots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx") : null,
    process.env.npm_config_cache ? path.join(process.env.npm_config_cache, "_npx") : null,
    path.join(process.env.USERPROFILE || "", ".npm", "_npx"),
  ].filter(Boolean);

  const npxCandidates = [];
  for (const npxRoot of cacheRoots) {
    if (!fs.existsSync(npxRoot)) continue;
    let dirs;
    try {
      dirs = fs.readdirSync(npxRoot);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const c = path.join(npxRoot, dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (fs.existsSync(c)) npxCandidates.push(c);
    }
  }

  const npxResult = selectBestCandidate(npxCandidates);

  // 5. 比较外部已安装版本（全局 vs npx 缓存）
  let externalResult = globalResult;
  let externalSource = "installed";

  if (globalResult.best && npxResult.best) {
    if (npxResult.bestVer && globalResult.bestVer) {
      const cmp = compareVersions(npxResult.bestVer, globalResult.bestVer);
      if (cmp > 0) {
        externalResult = npxResult;
        externalSource = "npx";
      }
    }
  } else if (!globalResult.best && npxResult.best) {
    externalResult = npxResult;
    externalSource = "npx";
  }

  // 6. 最终版本优先级仲裁（外部升级包 vs 离线内置包）
  // 如果外部存在安装包，且外部版本严格大于内置离线包版本，优先使用外部新版本！
  // 否则若内置包存在，使用内置包保证开箱即用稳定性；
  if (externalResult.best && bundledResult.best) {
    if (externalResult.bestVer && bundledResult.bestVer) {
      const cmp = compareVersions(externalResult.bestVer, bundledResult.bestVer);
      if (cmp > 0) {
        return {
          path: externalResult.best,
          version: externalResult.bestVer,
          source: externalSource,
        };
      }
    }
    return {
      path: bundledResult.best,
      version: bundledResult.bestVer,
      source: "bundled",
    };
  }

  if (externalResult.best) {
    return {
      path: externalResult.best,
      version: externalResult.bestVer,
      source: externalSource,
    };
  }

  if (bundledResult.best) {
    return {
      path: bundledResult.best,
      version: bundledResult.bestVer,
      source: "bundled",
    };
  }

  return {
    path: null,
    version: null,
    source: null,
  };
}

/**
 * 保持兼容的路径解析单方法（返回字符串路径）
 * @returns {string|null}
 */
function resolveDshBin(options = {}) {
  const kernel = resolveDshKernel(options);
  return kernel.path;
}

/**
 * 获取当前就绪的本地内核版本号
 * @returns {string}
 */
function getLocalKernelVersion(options = {}) {
  const kernel = resolveDshKernel(options);
  return kernel.version || "unknown";
}

/**
 * 判断宿主机或当前进程环境是否具备可运行的 Node/内核环境
 * @returns {boolean}
 */
function hasNodeInstalled(options = {}) {
  if (resolveDshBin(options)) return true;
  const nodeBin = resolveNode();
  return Boolean(nodeBin && nodeBin !== process.execPath && fs.existsSync(nodeBin));
}

/**
 * 校验升级目标版本参数的合法性 (CODE_REVIEW R-04)
 * @param {string} targetVersion 目标版本输入
 * @returns {{ valid: boolean, type: 'semver'|'channel', clean: string, error?: string }}
 */
function validateKernelTargetVersion(targetVersion = "latest") {
  const rawTarget = String(targetVersion || "").trim();
  const clean = rawTarget.replace(/^v/, "").trim();
  const STRICT_SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

  if (STRICT_SEMVER_REGEX.test(clean)) {
    return { valid: true, type: "semver", clean };
  }

  const isChannel = clean === "" || clean === "latest" || clean === "next";
  if (isChannel) {
    return { valid: true, type: "channel", clean: clean || "latest" };
  }

  return {
    valid: false,
    clean,
    error: `指定的内核版本格式非法: "${targetVersion}"。版本号必须满足严格 SemVer 规范 (如 0.1.7-rc.2) 或合法通道标识 (latest/next)，禁止静默降级升级`,
  };
}

module.exports = {
  readPackageVersion,
  resolveNode,
  resolveNpm,
  resolveNpx,
  selectBestCandidate,
  resolveDshKernel,
  resolveBundledKernel,
  resolveDshBin,
  getLocalKernelVersion,
  hasNodeInstalled,
  validateKernelTargetVersion,
};
