/**
 * DSH Desktop - Native DPAPI SafeStorage Credentials Management (IMPLEMENT.md 5.1.3)
 * 凭据安全收敛：强制 DPAPI 加密、0o600 权限、绝无明文降级、旧明文安全擦除与进程注入
 */

const fs = require("node:fs");
const path = require("node:path");
const { getCredentialsYamlPath, getEncryptedCredentialsPath } = require("./home");

const MANAGED_CREDENTIAL_MARKER = "[managed-by-desktop]";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPlaintextApiKeys(rawYaml) {
  const extracted = {};
  const keyPattern = /([A-Z0-9_]+_API_KEY):\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,}\r\n#]+))/g;
  let match;
  while ((match = keyPattern.exec(rawYaml)) !== null) {
    const key = match[1].trim();
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (key && value && value !== MANAGED_CREDENTIAL_MARKER && !value.startsWith("$ref:")) {
      extracted[key] = value;
    }
  }
  return extracted;
}

function replaceApiKeyWithManagedMarker(rawYaml, key) {
  const escapedKey = escapeRegExp(key);
  const scalarPattern = new RegExp(
    `(${escapedKey}:\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,}\\r\\n#]+)`,
    "g"
  );
  return rawYaml.replace(scalarPattern, `$1"${MANAGED_CREDENTIAL_MARKER}"`);
}

function repairLegacyManagedRefsMap(rawYaml) {
  const parts = rawYaml.split(/(\r?\n)/);
  let repaired = false;

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    if (!/^\s*refs:\s*\{/.test(line)) continue;
    if (!line.includes(MANAGED_CREDENTIAL_MARKER)) continue;

    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    if (openBraces !== closeBraces + 1) continue;

    parts[index] = line.replaceAll(MANAGED_CREDENTIAL_MARKER, `"${MANAGED_CREDENTIAL_MARKER}"`) + " }";
    repaired = true;
  }

  return { yaml: parts.join(""), repaired };
}

/**
 * 安全覆盖擦除文件（防物理磁盘残留）
 * @param {string} filePath
 */
function secureShredFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size > 0) {
      const zeros = Buffer.alloc(stat.size, 0);
      fs.writeFileSync(filePath, zeros);
    }
    fs.unlinkSync(filePath);
  } catch (err) {
    console.warn(`[dsh-desktop] secureShredFile notice (${filePath}):`, err.message);
  }
}

/**
 * 获取加密存储后端提供者（默认 Electron safeStorage）
 * @param {object} [customProvider]
 * @returns {object|null}
 */
function getStorageProvider(customProvider) {
  if (customProvider) return customProvider;
  try {
    const electron = require("electron");
    return electron.safeStorage || null;
  } catch (_e) {
    return null;
  }
}

/**
 * 校验加密环境可用性
 * @param {object} [provider]
 * @returns {boolean}
 */
function isEncryptionAvailable(provider) {
  const p = getStorageProvider(provider);
  return Boolean(p && typeof p.isEncryptionAvailable === "function" && p.isEncryptionAvailable());
}

/**
 * 健壮的原子写文件函数：临时文件写入 -> fsync 刷盘 -> rename 原子覆盖
 * 防止进程异常中断或断电造成文件损毁 (R2-1)
 * @param {string} filePath 目标文件路径
 * @param {string|Buffer} data 要写入的数据
 * @param {object} [options]
 * @param {number} [options.mode=0o600] 文件权限
 * @param {string} [options.encoding="utf8"] 编码
 */
function atomicWriteFileSync(filePath, data, options = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const mode = options.mode || 0o600;
  const encoding = typeof data === "string" ? (options.encoding || "utf8") : null;
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);

  try {
    const fd = fs.openSync(tempPath, "w", mode);
    try {
      if (typeof data === "string") {
        fs.writeSync(fd, data, 0, encoding);
      } else {
        fs.writeSync(fd, data);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.chmodSync(tempPath, mode);
    } catch (_e) {}

    // 原子替换：保留原文件直至新文件安全就位 (5.11 项二 & R2-1)
    if (!fs.existsSync(filePath)) {
      fs.renameSync(tempPath, filePath);
    } else {
      const base = path.basename(filePath);
      const origBakPath = path.join(dir, `.${base}.orig.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
      // 备份必须确保成功建立；若备份失败，立即抛错终止，绝对不在无备份条件下触碰原文件
      fs.copyFileSync(filePath, origBakPath);

      try {
        // 首选重命名覆盖
        fs.renameSync(tempPath, filePath);
        // 新文件已安全就位，清理备份
        try { if (fs.existsSync(origBakPath)) fs.unlinkSync(origBakPath); } catch (_e) {}
      } catch (renameErr) {
        // Windows 上若因目标锁占用无法直接 rename，采用原子两阶段交换事务
        const swapPath = path.join(dir, `.${base}.swap.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
        try {
          fs.renameSync(filePath, swapPath);
          try {
            fs.renameSync(tempPath, filePath);
            try { fs.unlinkSync(swapPath); } catch (_e) {}
            try { if (fs.existsSync(origBakPath)) fs.unlinkSync(origBakPath); } catch (_e) {}
          } catch (swapInErr) {
            // 新文件未能就位，立即将 swapPath 还原为 filePath
            try {
              fs.renameSync(swapPath, filePath);
            } catch (_rErr) {
              try { fs.copyFileSync(swapPath, filePath); } catch (_cErr) {}
            }
            throw swapInErr;
          }
        } catch (swapErr) {
          // 严禁使用 copyFileSync 直写原文件 (5.11 项二)
          // 若重命名两阶段交换受阻，确保原文件从安全备份完好还原，并显式抛出错误阻断
          if (!fs.existsSync(filePath) && fs.existsSync(origBakPath)) {
            try {
              fs.renameSync(origBakPath, filePath);
            } catch (_rErr) {
              try { fs.copyFileSync(origBakPath, filePath); } catch (_cErr) {}
            }
          }
          throw swapErr;
        }
      }
    }
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_e) {}
    throw err;
  }
}

/**
 * 彻底清洗配置快照中的所有敏感 API Key (R0-1 核心红线)
 * @param {object} snapshot
 * @returns {boolean} 是否清洗了敏感字段
 */
function purgeSensitiveKeysFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.providers)) return false;
  let hadSensitive = false;
  for (const p of snapshot.providers) {
    if ("apiKey" in p) {
      delete p.apiKey;
      hadSensitive = true;
    }
    if (p.modelConfigs && typeof p.modelConfigs === "object") {
      for (const m of Object.keys(p.modelConfigs)) {
        if (p.modelConfigs[m] && "apiKey" in p.modelConfigs[m]) {
          delete p.modelConfigs[m].apiKey;
          hadSensitive = true;
        }
      }
    }
  }
  return hadSensitive;
}

/**
 * 向 credentials.bin 增量安全写入 DPAPI 加密的凭据映射 (原子事务写入)
 * @param {Record<string, string>} credentialsMap
 * @param {object} [options]
 * @param {object} [options.provider]
 * @param {string} [options.userDataDir]
 * @returns {{ success: boolean, count: number }}
 */
function saveCredentials(credentialsMap, options = {}) {
  const provider = getStorageProvider(options.provider);
  if (!provider || !provider.isEncryptionAvailable || !provider.isEncryptionAvailable()) {
    throw new Error("SafeStorage encryption is unavailable; refusing to persist credentials in plaintext (5.1.3)");
  }

  const binPath = getEncryptedCredentialsPath(options.userDataDir);
  const existsBefore = fs.existsSync(binPath);

  // 1. 读取既有凭据并增量合并
  let current = {};
  try {
    const existing = loadCredentials(options);
    if (existing && typeof existing === "object") {
      current = { ...existing };
    }
  } catch (readErr) {
    if (existsBefore) {
      // 核心保护：已有主文件但解密/读取失败，绝不以空对象覆盖，抛错保护现场 (CODE_REVIEW R-03)
      throw new Error(`Cannot save credentials: existing credentials file is unreadable (${readErr.message}). Refusing to overwrite to prevent data loss.`);
    }
    throw readErr;
  }

  for (const [k, v] of Object.entries(credentialsMap || {})) {
    if (v === null || v === undefined || v === "") {
      delete current[k];
    } else {
      current[k] = String(v).trim();
    }
  }

  const jsonText = JSON.stringify(current);
  const cipherBuffer = provider.encryptString(jsonText);

  atomicWriteFileSync(binPath, cipherBuffer, { mode: 0o600 });

  return { success: true, count: Object.keys(current).length };
}

/**
 * 从 credentials.bin 读取并解密凭据映射
 * @param {object} [options]
 * @param {object} [options.provider]
 * @param {string} [options.userDataDir]
 * @returns {Record<string, string>}
 */
function loadCredentials(options = {}) {
  const binPath = getEncryptedCredentialsPath(options.userDataDir);
  const provider = getStorageProvider(options.provider);
  if (!provider || !provider.isEncryptionAvailable || !provider.isEncryptionAvailable()) {
    throw new Error("SafeStorage encryption is unavailable; cannot decrypt credentials");
  }

  // 内部辅助：尝试安全解密指定文件
  const tryDecryptCredentialsFile = (targetFile) => {
    try {
      if (!fs.existsSync(targetFile)) return null;
      const cipherBuffer = fs.readFileSync(targetFile);
      if (!cipherBuffer || cipherBuffer.length === 0) return null;
      const plainJson = provider.decryptString(cipherBuffer);
      const parsed = JSON.parse(plainJson);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_e) {
      return null;
    }
  };

  // 1. 如果主文件存在，优先尝试直接解密
  if (fs.existsSync(binPath)) {
    const creds = tryDecryptCredentialsFile(binPath);
    if (creds !== null) {
      return creds;
    }
    // 主文件存在但解密失败（损坏或异常截断），尝试从历史备份自愈 (CODE_REVIEW R-03)
    console.warn(`[dsh-desktop] ${path.basename(binPath)} exists but is invalid or corrupted; attempting recovery from backup...`);
  }

  // 2. 主文件缺失或已损坏：查找可用的备份自愈
  const dir = path.dirname(binPath);
  if (fs.existsSync(dir)) {
    const base = path.basename(binPath);
    const baks = fs.readdirSync(dir).filter((f) => {
      return (
        (f.startsWith(`.${base}.orig.`) ||
          f.startsWith(`${base}.orig.`) ||
          f.startsWith(`.${base}.swap.`) ||
          f.startsWith(`${base}.swap.`)) &&
        f.endsWith(".tmp")
      );
    });

    if (baks.length > 0) {
      // 提取真实修改时间与文件名时间戳，严格按最新优先 (降序) 排序，防止依字母序恢复较旧备份 (CODE_REVIEW R-03)
      const getBackupScore = (fileName) => {
        const full = path.join(dir, fileName);
        try {
          const stats = fs.statSync(full);
          const match = fileName.match(/\.(?:orig|swap)\.(\d+)\./);
          const nameTime = match ? Number(match[1]) : 0;
          return Math.max(stats.mtimeMs || 0, nameTime);
        } catch (_e) {
          return 0;
        }
      };

      baks.sort((a, b) => getBackupScore(b) - getBackupScore(a));

      // 遍历候选备份，寻找第一个能通过 safeStorage 成功解密的有效备份
      for (const bak of baks) {
        const bakPath = path.join(dir, bak);
        const recoveredCreds = tryDecryptCredentialsFile(bakPath);
        if (recoveredCreds !== null) {
          try {
            fs.copyFileSync(bakPath, binPath);
            console.info(`[dsh-desktop] Recovered and restored ${base} from valid backup: ${bak}`);
          } catch (_wErr) {}
          return recoveredCreds;
        }
      }
    }
  }

  // 3. 如果主文件与备份均不存在，视为首次运行返回空映射
  if (!fs.existsSync(binPath)) {
    return {};
  }

  // 4. 若主文件存在且损坏，且没有任何有效备份可自愈，抛出解密异常阻断
  throw new Error("Credential decryption failed: credentials.bin is corrupted and no valid backup available");
}

/**
 * 旧明文 .credentials.yaml 一次性自动安全迁移流程 (5.1.3)
 * 1. 扫描提取明文 API Key
 * 2. safeStorage 加密验证写入 credentials.bin
 * 3. 验证解密回读一致
 * 4. 0 字节覆写旧明文，擦除暴露风险，替换为安全引用标记并置 0o600
 * @param {object} [options]
 * @param {object} [options.provider]
 * @param {string} [options.dshHome]
 * @param {string} [options.userDataDir]
 * @returns {{ migrated: boolean, count: number, keys: string[] }}
 */
function migratePlaintextCredentials(options = {}) {
  const yamlPath = getCredentialsYamlPath(options.dshHome);
  if (!fs.existsSync(yamlPath)) {
    return { migrated: false, repaired: false, count: 0, keys: [] };
  }

  // 必须确保加密能力就绪，否则严禁触碰以免数据损毁
  if (!isEncryptionAvailable(options.provider)) {
    console.warn("[dsh-desktop] Encryption unavailable, postponing credential migration.");
    return { migrated: false, repaired: false, count: 0, keys: [] };
  }

  let rawYaml = fs.readFileSync(yamlPath, "utf8");
  const legacyRepair = repairLegacyManagedRefsMap(rawYaml);
  if (legacyRepair.repaired) {
    rawYaml = legacyRepair.yaml;
    atomicWriteFileSync(yamlPath, rawYaml, { encoding: "utf8", mode: 0o600 });
    console.info("[dsh-desktop] Repaired legacy managed credentials YAML structure.");

    // The same legacy regex also captured the inline map's trailing ` }` into
    // the encrypted value. Only correct that suffix when the matching YAML
    // corruption was detected above.
    const storedCredentials = loadCredentials(options);
    const recoveredCredentials = {};
    for (const [key, value] of Object.entries(storedCredentials)) {
      if (/_API_KEY$/.test(key) && typeof value === "string" && /\s+}$/.test(value)) {
        recoveredCredentials[key] = value.replace(/\s+}$/, "");
      }
    }
    if (Object.keys(recoveredCredentials).length > 0) {
      saveCredentials(recoveredCredentials, options);
      console.info(`[dsh-desktop] Recovered ${Object.keys(recoveredCredentials).length} encrypted credential value(s) affected by the legacy inline-map migration.`);
    }
  }

  const extracted = extractPlaintextApiKeys(rawYaml);

  const keys = Object.keys(extracted);
  if (keys.length === 0) {
    return { migrated: false, repaired: legacyRepair.repaired, count: 0, keys: [] };
  }

  // 1. 加密落盘
  saveCredentials(extracted, options);

  // 2. 读回验证
  const verified = loadCredentials(options);
  for (const k of keys) {
    if (verified[k] !== extracted[k]) {
      throw new Error(`Credential verification failed for ${k}; aborting migration wipe`);
    }
  }

  // 3. 安全擦除明文并重写为受管引用 (原子事务替换，杜绝 0 字节悬挂破坏)
  let sanitizedYaml = rawYaml;
  for (const k of keys) {
    sanitizedYaml = replaceApiKeyWithManagedMarker(sanitizedYaml, k);
  }

  // 原子写回清洗后的 YAML，杜绝崩溃破坏源文件
  atomicWriteFileSync(yamlPath, sanitizedYaml, { encoding: "utf8", mode: 0o600 });

  console.info(`[dsh-desktop] Securely migrated ${keys.length} plaintext API keys to DPAPI encrypted store.`);
  return { migrated: true, repaired: legacyRepair.repaired, count: keys.length, keys };
}

/**
 * 将解密后的所有凭据直通预热注入目标环境变量（如拉起内核的 env）
 * 利用官方内核最高优先级的 inherited process environment 机制生效，免去磁盘明文依赖
 * @param {NodeJS.ProcessEnv} targetEnv
 * @param {object} [options]
 * @returns {number} 注入的密钥数量
 */
function injectCredentialsIntoEnv(targetEnv = process.env, options = {}) {
  try {
    if (!isEncryptionAvailable(options.provider)) return 0;
    const creds = loadCredentials(options);
    let count = 0;
    for (const [k, v] of Object.entries(creds)) {
      if (k && v && typeof v === "string") {
        targetEnv[k] = v;
        count++;
      }
    }
    return count;
  } catch (err) {
    console.warn("[dsh-desktop] Note on injectCredentialsIntoEnv:", err.message);
    return 0;
  }
}

module.exports = {
  secureShredFile,
  isEncryptionAvailable,
  atomicWriteFileSync,
  purgeSensitiveKeysFromSnapshot,
  saveCredentials,
  loadCredentials,
  migratePlaintextCredentials,
  injectCredentialsIntoEnv,
};

