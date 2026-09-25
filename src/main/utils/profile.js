/**
 * DSH Desktop - Web Profile & Plugin Environment Utility
 * Profile 纯净自愈清洗与 .npmrc 非侵入式增量合并工具
 */

const fs = require("node:fs");
const path = require("node:path");

const CORE_BASE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
const INCOMPATIBLE_PLUGINS = ["@deepseek-harness-tui/dsh-tui"];

const NPM_PACKAGE_REGEX = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;

/**
 * 校验 npm 插件包名格式，阻断任意路径注入与目录逃逸
 * @param {string} name
 * @returns {boolean}
 */
function validatePluginPackageName(name) {
  if (!name || typeof name !== "string") return false;
  if (name.includes("..") || name.includes("\\") || name.startsWith("/") || name.endsWith("/")) {
    return false;
  }
  return NPM_PACKAGE_REGEX.test(name);
}


/**
 * 非破坏性增量合并 .npmrc 配置
 * 保护用户既有的私有镜像源、Token 或自定义字段，仅在缺失时追加必要保障项
 * @param {string} existingText 原 .npmrc 文本内容
 * @returns {{ content: string, modified: boolean }}
 */
function mergeNpmrc(existingText = "") {
  let content = existingText || "";
  let modified = false;

  // 1. 检查 legacy-peer-deps（避免插件版本代差安装冲突）
  if (!/^legacy-peer-deps\s*=/m.test(content)) {
    content = (content ? content.trimEnd() + "\n" : "") + "legacy-peer-deps=true\n";
    modified = true;
  }

  // 2. 检查 registry（若用户已配置任意自定义镜像源，绝不覆盖篡改）
  if (!/^registry\s*=/m.test(content)) {
    content = (content ? content.trimEnd() + "\n" : "") + "registry=https://registry.npmmirror.com/\n";
    modified = true;
  }

  return { content, modified };
}

/**
 * 确保目标 profile 目录的 .npmrc 包含基础防冲突配置
 * @param {string} profileDir Profile 物理根目录
 * @returns {boolean} 是否发生了写入修改
 */
function ensureWebProfileNpmrc(profileDir) {
  try {
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    const npmrcPath = path.join(profileDir, ".npmrc");
    const existing = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, "utf8") : "";
    const { content, modified } = mergeNpmrc(existing);
    if (modified) {
      fs.writeFileSync(npmrcPath, content, "utf8");
    }
    return modified;
  } catch (err) {
    console.warn("[dsh-desktop] Failed to ensure web profile .npmrc:", err.message);
    return false;
  }
}

/**
 * 对 package.json 数据结构进行纯净自愈清洗
 * 1. 过滤已知的 Web 不兼容插件 (如 TTY 异常插件)；
 * 2. 确保官方核心基底 (@deepseek-ai/dsh-base 等) 置顶；
 * 3. 物理核查第三方 bundle 实体是否存在，缺失时自愈剔除，杜绝 composeProfile 崩溃；
 * 4. 严禁向用户 profile 强塞未安装的第三方依赖。
 * @param {object} pkg package.json 结构体
 * @param {object} [options]
 * @param {string} [options.nodeModulesDir] 本地 node_modules 目录（用于物理存在探测）
 * @returns {{ pkg: object, modified: boolean }}
 */
function sanitizeProfileJson(pkg, options = {}) {
  if (!pkg || typeof pkg !== "object") {
    return { pkg, modified: false };
  }

  let modified = false;
  const nodeModulesDir = options.nodeModulesDir || null;

  // 1. 过滤 Web 不兼容插件
  if (pkg.dependencies && typeof pkg.dependencies === "object") {
    for (const p of INCOMPATIBLE_PLUGINS) {
      if (pkg.dependencies[p]) {
        delete pkg.dependencies[p];
        modified = true;
      }
    }
  }

  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) {
    pkg.dsh.profile.bundles = [];
  }

  const originalLen = pkg.dsh.profile.bundles.length;
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(
    (b) => !INCOMPATIBLE_PLUGINS.includes(b)
  );
  if (pkg.dsh.profile.bundles.length !== originalLen) {
    modified = true;
  }

  // 2. 官方基底强制置顶保证
  for (let i = CORE_BASE_BUNDLES.length - 1; i >= 0; i--) {
    const baseBundle = CORE_BASE_BUNDLES[i];
    if (!pkg.dsh.profile.bundles.includes(baseBundle)) {
      pkg.dsh.profile.bundles.unshift(baseBundle);
      modified = true;
    } else {
      const curIdx = pkg.dsh.profile.bundles.indexOf(baseBundle);
      if (curIdx > i) {
        pkg.dsh.profile.bundles.splice(curIdx, 1);
        pkg.dsh.profile.bundles.splice(i, 0, baseBundle);
        modified = true;
      }
    }
  }

  // 3. 物理探测自愈：若 bundles 声明的第三方包在本地 node_modules 不存在，自愈剔除
  if (nodeModulesDir) {
    const modulesExist = fs.existsSync(nodeModulesDir);
    const validBundles = pkg.dsh.profile.bundles.filter((bundleName) => {
      if (CORE_BASE_BUNDLES.includes(bundleName)) return true;
      if (!modulesExist) {
        console.info(`[dsh-desktop] Self-healing: pruned uninstalled bundle '${bundleName}' (node_modules directory absent).`);
        return false;
      }
      const bundleDir = path.join(nodeModulesDir, ...bundleName.split("/"));
      const exists = fs.existsSync(bundleDir);
      if (!exists) {
        console.info(`[dsh-desktop] Self-healing: pruned uninstalled bundle '${bundleName}' from web profile.`);
      }
      return exists;
    });

    if (validBundles.length !== pkg.dsh.profile.bundles.length) {
      pkg.dsh.profile.bundles = validBundles;
      modified = true;
    }
  }

  return { pkg, modified };
}

// 已严格验证的第三方插件自愈兼容矩阵 (R2-2 契约)
const VERIFIED_PLUGIN_COMPAT_MATRIX = {
  "@nanmicoder/dsh-auto-mode": {
    supportedPluginVersions: ["0.1.2"],
    testedKernelVersions: ["0.1.5-rc.1", "0.1.5-rc.2", "0.1.5-rc.3", "0.1.7-rc.1", "0.1.7-rc.2"],
  },
};

/**
 * 第三方插件版本白名单与防崩自愈
 * 基于精确已验证版本矩阵，严禁在未知版本组合下盲目改写第三方源码 (R2-2)
 * @param {string} profileDir Profile 物理根目录
 * @param {string} [targetKernelVer] 当前运行的目标内核版本号
 * @returns {boolean} 是否进行了自愈修复
 */
function healPluginCompatibility(profileDir, targetKernelVer) {
  if (!profileDir || !fs.existsSync(profileDir)) return false;
  let healed = false;

  try {
    const autoModeDir = path.join(profileDir, "node_modules", "@nanmicoder", "dsh-auto-mode");
    if (fs.existsSync(autoModeDir)) {
      // 0. 读取插件自身 package.json 版本，精确比对矩阵 (R2-2)
      const autoModePkgPath = path.join(autoModeDir, "package.json");
      let pluginVersion = "0.1.2"; // 官方已知受灾发布基准版本
      if (fs.existsSync(autoModePkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(autoModePkgPath, "utf8"));
          if (pkg.version) pluginVersion = String(pkg.version);
        } catch (_e) {}
      }

      const matrix = VERIFIED_PLUGIN_COMPAT_MATRIX["@nanmicoder/dsh-auto-mode"];
      const isPluginSupported = pluginVersion && matrix.supportedPluginVersions.includes(pluginVersion);
      const isKernelSupported = targetKernelVer && matrix.testedKernelVersions.includes(targetKernelVer);

      if (!isPluginSupported || !isKernelSupported) {
        console.warn(`[dsh-desktop] Skipping auto-heal for @nanmicoder/dsh-auto-mode: combination of plugin '${pluginVersion}' and kernel '${targetKernelVer}' is not in verified matrix.`);
        return false;
      }

      // 1. 自愈 compatibility.json 白名单（仅注入受控矩阵内已验证的现代版本，严禁追加未验证内核）
      const compatJsonPath = path.join(autoModeDir, "compatibility.json");
      if (fs.existsSync(compatJsonPath)) {
        try {
          const compat = JSON.parse(fs.readFileSync(compatJsonPath, "utf8"));
          if (Array.isArray(compat.supportedHosts)) {
            const versionsToAdd = [...matrix.testedKernelVersions];
            let modified = false;
            for (const v of versionsToAdd) {
              if (!compat.supportedHosts.some((h) => h.version === v)) {
                compat.supportedHosts.unshift({ version: v, track: "compatible-healed" });
                modified = true;
              }
            }
            if (modified) {
              fs.writeFileSync(compatJsonPath, JSON.stringify(compat, null, 2), "utf8");
              console.info(`[dsh-desktop] Healed @nanmicoder/dsh-auto-mode compatibility.json with verified modern kernel support.`);
              healed = true;
            }
          }
        } catch (_e) {}
      }

      // 2. 防崩兜底：修补 harness-compat.js，将抛出致命崩溃替换为非致命警告
      const compatJsPath = path.join(autoModeDir, "lib", "harness-compat.js");
      if (fs.existsSync(compatJsPath)) {
        try {
          let code = fs.readFileSync(compatJsPath, "utf8");
          if (code.includes("throw new Error(`Auto Mode: unsupported or mixed Harness packages")) {
            code = code.replace(
              /throw new Error\(`Auto Mode: unsupported or mixed Harness packages[^`]*`\);/g,
              "console.warn('[dsh-desktop auto-heal] Auto Mode compatibility notice bypassed for modern kernel.'); return;"
            );
            fs.writeFileSync(compatJsPath, code, "utf8");
            console.info(`[dsh-desktop] Defensively patched @nanmicoder/dsh-auto-mode/lib/harness-compat.js against crash.`);
            healed = true;
          }
        } catch (_e) {}
      }
    }
  } catch (err) {
    console.warn("[dsh-desktop] healPluginCompatibility warning:", err.message);
  }

  return healed;
}

/**
 * 当检测到已排除的插件被升级为兼容版本时，安全可逆地恢复其在 profile 中的挂载 (R1-5)
 * @param {string} profileDir
 * @param {string} pluginName
 * @returns {boolean} 是否成功恢复
 */
function restorePluginToWebProfile(profileDir, pluginName) {
  if (!profileDir || !pluginName || !fs.existsSync(profileDir)) return false;
  let restored = false;

  try {
    const webPkgPath = path.join(profileDir, "package.json");
    if (!fs.existsSync(webPkgPath)) return false;

    // 1. 确认 node_modules 中确实存在该插件物理实体
    const pluginPkgPath = path.join(profileDir, "node_modules", ...pluginName.split("/"), "package.json");
    if (!fs.existsSync(pluginPkgPath)) return false;

    // 2. 检查并恢复 package.json 中的 bundles 挂载
    const rawPkg = fs.readFileSync(webPkgPath, "utf8");
    const pkg = JSON.parse(rawPkg);
    if (!pkg.dsh) pkg.dsh = {};
    if (!pkg.dsh.profile) pkg.dsh.profile = {};
    if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];

    if (!pkg.dsh.profile.bundles.includes(pluginName)) {
      pkg.dsh.profile.bundles.push(pluginName);
      fs.writeFileSync(webPkgPath, JSON.stringify(pkg, null, 2), "utf8");
      restored = true;
    }

    // 3. 检查并恢复 cordis.patch.yml 挂载
    const patchPath = path.join(profileDir, "cordis.patch.yml");
    if (fs.existsSync(patchPath)) {
      let patchContent = fs.readFileSync(patchPath, "utf8");
      const escapedName = pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hasPluginEntry = new RegExp(`^-\\s+id:\\s*["']?${escapedName}["']?`, "m").test(patchContent);
      if (!hasPluginEntry) {
        // 如果存在 .bak 备份文件，尝试提取原配置条目
        const bakPath = patchPath + ".bak";
        let entryToRestore = null;
        if (fs.existsSync(bakPath)) {
          const bakContent = fs.readFileSync(bakPath, "utf8");
          const match = bakContent.match(new RegExp(`(^-\\s+id:\\s*["']?${escapedName}["']?[\\s\\S]*?)(?=^-\\s+id:|$)`, "m"));
          if (match && match[1]) {
            entryToRestore = match[1].trimEnd();
          }
        }
        if (!entryToRestore) {
          entryToRestore = `- id: ${pluginName}\n  package: ${pluginName}`;
        }
        if (!patchContent.endsWith("\n")) patchContent += "\n";
        patchContent += entryToRestore + "\n";
        fs.writeFileSync(patchPath, patchContent, "utf8");
        restored = true;
      }
    }

    if (restored) {
      console.info(`[dsh-desktop] Successfully restored compatible plugin '${pluginName}' into web profile.`);
    }
  } catch (err) {
    console.warn(`[dsh-desktop] Failed to reversibly restore plugin '${pluginName}':`, err.message);
  }

  return restored;
}

/**
 * 从 cordis.patch.yml 纯文本中精确剔除指定插件条目
 * @param {string} yamlText 原 YAML 文本
 * @param {string} pluginName 目标插件包名或 ID
 * @returns {{ content: string, modified: boolean }}
 */
function removePluginFromPatchYaml(yamlText = "", pluginName) {
  if (!yamlText || !pluginName) return { content: yamlText, modified: false };
  const lines = yamlText.split(/\r?\n/);
  const blocks = [];
  let currentBlock = [];
  const prefixLines = [];
  let inEntries = false;

  for (const line of lines) {
    if (/^-\s+id:\s*/.test(line)) {
      inEntries = true;
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
      currentBlock.push(line);
    } else if (inEntries) {
      currentBlock.push(line);
    } else {
      prefixLines.push(line);
    }
  }
  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  let modified = false;
  const targetName = pluginName.toLowerCase();
  const filteredBlocks = blocks.filter((block) => {
    const text = block.join("\n");
    const nameMatch = text.match(/name:\s*['"]?([^'"\s\n]+)['"]?/);
    const idMatch = text.match(/-\s+id:\s*['"]?([^'"\s\n]+)['"]?/);
    if (nameMatch && nameMatch[1].toLowerCase() === targetName) {
      modified = true;
      return false;
    }
    if (idMatch && idMatch[1].toLowerCase() === targetName) {
      modified = true;
      return false;
    }
    return true;
  });

  if (!modified) {
    return { content: yamlText, modified: false };
  }

  const result = [...prefixLines, ...filteredBlocks.flatMap((b) => b)].join("\n") + "\n";
  return { content: result, modified: true };
}

/**
 * 从用户的 Web Profile 中彻底卸载指定插件
 * 涵盖：package.json (dependencies & bundles)、cordis.patch.yml、state.json 及本地 node_modules 目录
 * @param {string} profileDir Web Profile 物理目录
 * @param {string} pluginName 目标插件包名
 * @returns {{ success: boolean, packageJsonModified: boolean, patchModified: boolean, stateModified: boolean, directoryRemoved: boolean, error?: string }}
 */
function uninstallPluginFromWebProfile(profileDir, pluginName) {
  if (!profileDir || !pluginName) return { success: false, error: "invalid arguments" };
  if (!validatePluginPackageName(pluginName)) {
    return { success: false, error: `Invalid plugin package name: ${pluginName}` };
  }
  const result = {
    pluginName,
    packageJsonModified: false,
    patchModified: false,
    stateModified: false,
    directoryRemoved: false,
    success: true,
  };

  try {
    // 路径逃逸安全防御：确保物理目录严格位于 node_modules 边界内 (IMPLEMENT.md 5.2.4)
    const targetModules = path.resolve(profileDir, "node_modules");
    const pluginDir = path.resolve(targetModules, ...pluginName.split("/"));
    const rel = path.relative(targetModules, pluginDir);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
      return { ...result, success: false, error: `Security violation: plugin path escape attempt detected: ${pluginName}` };
    }

    // 1. 清洗 package.json
    const pkgPath = path.join(profileDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, "utf8");
      const pkg = JSON.parse(raw);
      let pkgModified = false;
      if (pkg.dependencies && pkg.dependencies[pluginName]) {
        delete pkg.dependencies[pluginName];
        pkgModified = true;
      }
      if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
        const origLen = pkg.dsh.profile.bundles.length;
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== pluginName);
        if (pkg.dsh.profile.bundles.length !== origLen) {
          pkgModified = true;
        }
      }
      if (pkgModified) {
        try {
          const bakPath = pkgPath + ".bak";
          if (!fs.existsSync(bakPath)) fs.copyFileSync(pkgPath, bakPath);
        } catch (_bakErr) {}
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf8");
        result.packageJsonModified = true;
        console.info(`[dsh-desktop] Cleanly purged '${pluginName}' from package.json.`);
      }
    }

    // 2. 清洗 cordis.patch.yml 补丁映射
    const patchPath = path.join(profileDir, "cordis.patch.yml");
    if (fs.existsSync(patchPath)) {
      const patchContent = fs.readFileSync(patchPath, "utf8");
      const { content, modified } = removePluginFromPatchYaml(patchContent, pluginName);
      if (modified) {
        fs.writeFileSync(patchPath, content, "utf8");
        result.patchModified = true;
        console.info(`[dsh-desktop] Cleanly purged '${pluginName}' from cordis.patch.yml.`);
      }
    }

    // 3. 清洗 .dsh-market/state.json 状态
    const statePath = path.join(profileDir, ".dsh-market", "state.json");
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        let stateMod = false;
        if (Array.isArray(state.disabled) && state.disabled.includes(pluginName)) {
          state.disabled = state.disabled.filter((n) => n !== pluginName);
          stateMod = true;
        }
        if (stateMod) {
          fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
          result.stateModified = true;
        }
      } catch (_e) {}
    }

    // 4. 物理清理 node_modules 目录（避开 Windows 锁）
    if (fs.existsSync(pluginDir)) {
      try {
        fs.rmSync(pluginDir, { recursive: true, force: true });
        result.directoryRemoved = true;
        console.info(`[dsh-desktop] Purged directory for '${pluginName}': ${pluginDir}`);
      } catch (rmErr) {
        console.warn(`[dsh-desktop] Note: directory cleanup deferred (${rmErr.message})`);
      }
    }

    return result;
  } catch (err) {
    console.error(`[dsh-desktop] Failed to uninstall ${pluginName}:`, err);
    return { ...result, success: false, error: err.message };
  }
}

/**
 * 完整清洗指定用户的 Web Profile
 * @param {string} profileDir
 * @param {object} [options]
 * @param {string} [options.kernelVersion] 当前运行的内核版本
 * @param {string[]} [options.excludeBundles] 需临时剔除的崩溃插件列表
 * @param {string[]} [options.uninstallPlugins] 需彻底卸载拔除的插件列表
 * @returns {boolean}
 */
function sanitizeWebProfile(profileDir, options = {}) {
  try {
    ensureWebProfileNpmrc(profileDir);

    // A disabled bundle must also be removed from the profile-level patch;
    // otherwise Cordis mounts it even after package.json no longer lists it.
    if (Array.isArray(options.excludeBundles) && options.excludeBundles.length > 0) {
      const patchPath = path.join(profileDir, "cordis.patch.yml");
      if (fs.existsSync(patchPath)) {
        let patchContent = fs.readFileSync(patchPath, "utf8");
        let patchModified = false;
        for (const pluginName of options.excludeBundles) {
          const next = removePluginFromPatchYaml(patchContent, pluginName);
          patchContent = next.content;
          patchModified = patchModified || next.modified;
        }
        if (patchModified) {
          const backupPath = patchPath + ".bak";
          if (!fs.existsSync(backupPath)) fs.copyFileSync(patchPath, backupPath);
          fs.writeFileSync(patchPath, patchContent, "utf8");
          console.info(`[dsh-desktop] Disabled incompatible profile patch mount(s): ${options.excludeBundles.join(", ")}`);
        }
      }
    }

    // 运行特定指定插件的彻底物理卸载清洗
    if (Array.isArray(options.uninstallPlugins) && options.uninstallPlugins.length > 0) {
      for (const p of options.uninstallPlugins) {
        uninstallPluginFromWebProfile(profileDir, p);
      }
    }

    // 运行第三方插件版本自愈 (受控版本矩阵)
    healPluginCompatibility(profileDir, options.kernelVersion);

    // R1-5: 可逆恢复支持：如果传入了 restoreBundles，安全恢复其在 profile 中的挂载
    if (Array.isArray(options.restoreBundles) && options.restoreBundles.length > 0) {
      for (const p of options.restoreBundles) {
        restorePluginToWebProfile(profileDir, p);
      }
    }

    const webPkgPath = path.join(profileDir, "package.json");
    if (!fs.existsSync(webPkgPath)) return false;

    const raw = fs.readFileSync(webPkgPath, "utf8");
    const pkg = JSON.parse(raw);
    const nodeModulesDir = path.join(profileDir, "node_modules");

    // 排除特定冲突 bundle
    let excludedBundleModified = false;
    if (Array.isArray(options.excludeBundles) && options.excludeBundles.length > 0) {
      if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
        const originalLength = pkg.dsh.profile.bundles.length;
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(
          (b) => !options.excludeBundles.includes(b)
        );
        excludedBundleModified = pkg.dsh.profile.bundles.length !== originalLength;
      }
    }

    const { modified } = sanitizeProfileJson(pkg, { nodeModulesDir });
    if (modified || excludedBundleModified) {
      try {
        const bakPath = webPkgPath + ".bak";
        if (!fs.existsSync(bakPath)) fs.copyFileSync(webPkgPath, bakPath);
      } catch (_bakErr) {}
      fs.writeFileSync(webPkgPath, JSON.stringify(pkg, null, 2), "utf8");
      console.info("[dsh-desktop] Cleaned up web profile package.json successfully.");
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[dsh-desktop] Note: web profile check skipped:", err.message);
    return false;
  }
}

module.exports = {
  CORE_BASE_BUNDLES,
  INCOMPATIBLE_PLUGINS,
  VERIFIED_PLUGIN_COMPAT_MATRIX,
  validatePluginPackageName,
  mergeNpmrc,
  ensureWebProfileNpmrc,
  sanitizeProfileJson,
  healPluginCompatibility,
  restorePluginToWebProfile,
  removePluginFromPatchYaml,
  uninstallPluginFromWebProfile,
  sanitizeWebProfile,
};


