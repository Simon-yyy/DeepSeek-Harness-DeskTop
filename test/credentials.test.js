/**
 * Unit tests for DPAPI SafeStorage Credentials Management (IMPLEMENT.md 5.1.3)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const {
  isEncryptionAvailable,
  atomicWriteFileSync,
  purgeSensitiveKeysFromSnapshot,
  saveCredentials,
  loadCredentials,
  migratePlaintextCredentials,
  injectCredentialsIntoEnv,
  secureShredFile,
} = require("../src/main/utils/credentials");

// 模拟 Electron safeStorage 的加解密行为
function createMockSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (str) => {
      if (!available) throw new Error("Encryption disabled");
      // 简单 Base64 模拟密文 Buffer
      return Buffer.from("MOCK_CIPHER:" + Buffer.from(str, "utf8").toString("base64"), "utf8");
    },
    decryptString: (buf) => {
      if (!available) throw new Error("Decryption disabled");
      const text = buf.toString("utf8");
      if (!text.startsWith("MOCK_CIPHER:")) throw new Error("Invalid mock cipher");
      const b64 = text.slice("MOCK_CIPHER:".length);
      return Buffer.from(b64, "base64").toString("utf8");
    },
  };
}

describe("凭据原生安全隔离与 DPAPI 收敛 (5.1.3)", () => {
  test("isEncryptionAvailable 正确识别可用状态", () => {
    assert.equal(isEncryptionAvailable(createMockSafeStorage(true)), true);
    assert.equal(isEncryptionAvailable(createMockSafeStorage(false)), false);
    assert.equal(isEncryptionAvailable(null), false);
  });

  test("加密不可用时拒绝持久化，绝对不允许明文降级回退 (P0 核心红线)", () => {
    const disabledProvider = createMockSafeStorage(false);
    assert.throws(
      () => {
        saveCredentials({ TEST_API_KEY: "secret-value" }, { provider: disabledProvider });
      },
      {
        message: /refusing to persist credentials in plaintext/,
      }
    );
  });

  test("saveCredentials 与 loadCredentials 端到端加密读写与增量更新", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cred-test-"));
    const mockProvider = createMockSafeStorage(true);

    try {
      // 1. 首次加密保存
      const r1 = saveCredentials(
        { DEEPSEEK_API_KEY: "sk-test-123456" },
        { provider: mockProvider, userDataDir: tmpDir }
      );
      assert.equal(r1.success, true);
      assert.equal(r1.count, 1);

      // 验证二进制物理落盘且不存在任何 sk-test 明文
      const binFile = path.join(tmpDir, "credentials.bin");
      assert.equal(fs.existsSync(binFile), true);
      const rawDisk = fs.readFileSync(binFile, "utf8");
      assert.equal(rawDisk.includes("sk-test-123456"), false); // 绝不包含明文

      // 2. 解密读取
      const loaded1 = loadCredentials({ provider: mockProvider, userDataDir: tmpDir });
      assert.equal(loaded1.DEEPSEEK_API_KEY, "sk-test-123456");

      // 3. 增量更新另一个服务的 API Key
      saveCredentials(
        { OPENAI_API_KEY: "sk-openai-999" },
        { provider: mockProvider, userDataDir: tmpDir }
      );
      const loaded2 = loadCredentials({ provider: mockProvider, userDataDir: tmpDir });
      assert.equal(loaded2.DEEPSEEK_API_KEY, "sk-test-123456");
      assert.equal(loaded2.OPENAI_API_KEY, "sk-openai-999");

      // 4. 清除特定 Key
      saveCredentials(
        { DEEPSEEK_API_KEY: "" },
        { provider: mockProvider, userDataDir: tmpDir }
      );
      const loaded3 = loadCredentials({ provider: mockProvider, userDataDir: tmpDir });
      assert.equal(loaded3.DEEPSEEK_API_KEY, undefined);
      assert.equal(loaded3.OPENAI_API_KEY, "sk-openai-999");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("migratePlaintextCredentials 自动迁移旧明文并安全擦除", () => {
    const tmpDshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-mig-"));
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-user-data-"));
    const mockProvider = createMockSafeStorage(true);

    try {
      const yamlPath = path.join(tmpDshHome, ".credentials.yaml");
      const samplePlainYaml = `version: 1\nrefs:\n  AGENT_ROUTER_API_KEY: "secret-plaintext-key-888"\nrecords:\n  sample: value\n`;
      fs.writeFileSync(yamlPath, samplePlainYaml, "utf8");

      // 执行迁移
      const migResult = migratePlaintextCredentials({
        provider: mockProvider,
        dshHome: tmpDshHome,
        userDataDir: tmpUserData,
      });

      assert.equal(migResult.migrated, true);
      assert.equal(migResult.count, 1);
      assert.deepEqual(migResult.keys, ["AGENT_ROUTER_API_KEY"]);

      // 1. 验证密文库已经接管了该 key
      const loaded = loadCredentials({ provider: mockProvider, userDataDir: tmpUserData });
      assert.equal(loaded.AGENT_ROUTER_API_KEY, "secret-plaintext-key-888");

      // 2. 验证 .credentials.yaml 中的明文已被安全擦除，替换为 [managed-by-desktop]
      const sanitizedYaml = fs.readFileSync(yamlPath, "utf8");
      assert.equal(sanitizedYaml.includes("secret-plaintext-key-888"), false);
      assert.equal(sanitizedYaml.includes("[managed-by-desktop]"), true);
      assert.equal(sanitizedYaml.includes("records:"), true);

      // 3. 幂等性：再次调用不重复迁移
      const migResult2 = migratePlaintextCredentials({
        provider: mockProvider,
        dshHome: tmpDshHome,
        userDataDir: tmpUserData,
      });
      assert.equal(migResult2.migrated, false);
      assert.equal(migResult2.count, 0);
    } finally {
      fs.rmSync(tmpDshHome, { recursive: true, force: true });
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  test("migratePlaintextCredentials 保留行内 refs map 的闭合符号", () => {
    const tmpDshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-inline-mig-"));
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-user-inline-mig-"));
    const mockProvider = createMockSafeStorage(true);

    try {
      const yamlPath = path.join(tmpDshHome, ".credentials.yaml");
      fs.writeFileSync(
        yamlPath,
        "version: 1\nrefs: { DEEPSEEK_API_KEY: secret-inline-key }\nrecords:\n  sample: value\n",
        "utf8"
      );

      const result = migratePlaintextCredentials({
        provider: mockProvider,
        dshHome: tmpDshHome,
        userDataDir: tmpUserData,
      });

      assert.equal(result.migrated, true);
      const encrypted = loadCredentials({ provider: mockProvider, userDataDir: tmpUserData });
      assert.equal(encrypted.DEEPSEEK_API_KEY, "secret-inline-key");
      const sanitizedYaml = fs.readFileSync(yamlPath, "utf8");
      assert.equal(
        sanitizedYaml,
        'version: 1\nrefs: { DEEPSEEK_API_KEY: "[managed-by-desktop]" }\nrecords:\n  sample: value\n'
      );
    } finally {
      fs.rmSync(tmpDshHome, { recursive: true, force: true });
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  test("migratePlaintextCredentials 修复旧版本生成的未闭合 refs map", () => {
    const tmpDshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-repair-"));
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-user-repair-"));
    const mockProvider = createMockSafeStorage(true);

    try {
      const yamlPath = path.join(tmpDshHome, ".credentials.yaml");
      saveCredentials(
        { DEEPSEEK_API_KEY: "secret-inline-key }" },
        { provider: mockProvider, userDataDir: tmpUserData }
      );
      fs.writeFileSync(
        yamlPath,
        "version: 1\nrefs: { DEEPSEEK_API_KEY: [managed-by-desktop]\nrecords:\n  sample: value\n",
        "utf8"
      );

      const result = migratePlaintextCredentials({
        provider: mockProvider,
        dshHome: tmpDshHome,
        userDataDir: tmpUserData,
      });

      assert.equal(result.migrated, false);
      assert.equal(result.repaired, true);
      assert.equal(
        loadCredentials({ provider: mockProvider, userDataDir: tmpUserData }).DEEPSEEK_API_KEY,
        "secret-inline-key"
      );
      assert.equal(
        fs.readFileSync(yamlPath, "utf8"),
        'version: 1\nrefs: { DEEPSEEK_API_KEY: "[managed-by-desktop]" }\nrecords:\n  sample: value\n'
      );
    } finally {
      fs.rmSync(tmpDshHome, { recursive: true, force: true });
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  test("injectCredentialsIntoEnv 预热环境变量直通内核", () => {
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-inject-test-"));
    const mockProvider = createMockSafeStorage(true);

    try {
      saveCredentials(
        { GLM_API_KEY: "test-glm-secret" },
        { provider: mockProvider, userDataDir: tmpUserData }
      );

      const targetEnv = {};
      const injectedCount = injectCredentialsIntoEnv(targetEnv, {
        provider: mockProvider,
        userDataDir: tmpUserData,
      });

      assert.equal(injectedCount, 1);
      assert.equal(targetEnv.GLM_API_KEY, "test-glm-secret");
    } finally {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  test("secureShredFile 0 字节覆盖与物理销毁", () => {
    const tmpFile = path.join(os.tmpdir(), "shred-target-" + Date.now() + ".tmp");
    fs.writeFileSync(tmpFile, "sensitive data string 1234567890", "utf8");
    assert.equal(fs.existsSync(tmpFile), true);

    secureShredFile(tmpFile);
    assert.equal(fs.existsSync(tmpFile), false);
  });

  test("atomicWriteFileSync 具备原子替换、权限设置与自动父目录创建能力 (R2-1)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-atomic-test-"));
    try {
      const targetPath = path.join(tmpDir, "nested", "sub", "test.bin");
      // 1. 自动创建父目录并写入
      atomicWriteFileSync(targetPath, "initial atomic content", { mode: 0o600 });
      assert.equal(fs.existsSync(targetPath), true);
      assert.equal(fs.readFileSync(targetPath, "utf8"), "initial atomic content");

      // 2. 覆盖原子替换
      atomicWriteFileSync(targetPath, "overwritten atomic content", { mode: 0o600 });
      assert.equal(fs.readFileSync(targetPath, "utf8"), "overwritten atomic content");

      // 3. 验证目录下没有任何遗留的 .tmp 临时碎片
      const files = fs.readdirSync(path.dirname(targetPath));
      assert.equal(files.length, 1);
      assert.equal(files[0], "test.bin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("5.9 项三: atomicWriteFileSync 确保覆盖写入时原文件受到安全保护", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-atomic-preserve-"));
    try {
      const targetPath = path.join(tmpDir, "critical-credentials.yaml");
      fs.writeFileSync(targetPath, "original-vital-content", "utf8");

      // 覆盖更新
      atomicWriteFileSync(targetPath, "new-vital-content", { mode: 0o600 });
      assert.equal(fs.readFileSync(targetPath, "utf8"), "new-vital-content");

      // 验证无任何 .tmp 碎片
      const files = fs.readdirSync(tmpDir);
      assert.equal(files.length, 1);
      assert.equal(files[0], "critical-credentials.yaml");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("5.11 项二: atomicWriteFileSync 故障注入：重命名失败时拒绝非原子直写，原文件完整保留", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-atomic-fault-"));
    try {
      const targetPath = path.join(tmpDir, "vault.yaml");
      const originalSecret = "TOP_SECRET_DO_NOT_CORRUPT";
      fs.writeFileSync(targetPath, originalSecret, "utf8");

      // 故障注入：劫持 fs.renameSync，仅在把新内容替换至目标时模拟抛出 EBUSY
      const realRenameSync = fs.renameSync;
      let injected = false;
      fs.renameSync = (oldP, newP) => {
        if (oldP.includes(".tmp") && !oldP.includes(".orig.") && !oldP.includes(".swap.") && newP === targetPath) {
          injected = true;
          const err = new Error("EBUSY: resource locked or busy");
          err.code = "EBUSY";
          throw err;
        }
        return realRenameSync(oldP, newP);
      };

      try {
        assert.throws(
          () => atomicWriteFileSync(targetPath, "CORRUPTED_NEW_CONTENT", { mode: 0o600 }),
          /EBUSY/
        );
        assert.strictEqual(injected, true, "故障必须真实注入成功");
        // 核心断言：原文件内容绝不被直写破坏
        assert.strictEqual(fs.readFileSync(targetPath, "utf8"), originalSecret);
      } finally {
        fs.renameSync = realRenameSync;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("5.12: loadCredentials 进程中断断点自愈：主文件缺失时从残留备份 (带点/无点 orig/swap) 完整自愈", () => {
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-atomic-recover-"));
    const mockProvider = createMockSafeStorage(true);

    try {
      // 1. 先保存一份有效加密凭据
      saveCredentials(
        { OPENAI_API_KEY: "sk-recovered-secret-key" },
        { provider: mockProvider, userDataDir: tmpUserData }
      );

      const binPath = path.join(tmpUserData, "credentials.bin");
      assert.strictEqual(fs.existsSync(binPath), true);
      const originalCipher = fs.readFileSync(binPath);

      // 模拟场景 A：进程在 rename 中途崩溃，主 credentials.bin 缺失，残留 .credentials.bin.orig.*.tmp
      fs.unlinkSync(binPath);
      const dotOrigBak = path.join(tmpUserData, ".credentials.bin.orig.99999999.abc.tmp");
      fs.writeFileSync(dotOrigBak, originalCipher);

      const recoveredA = loadCredentials({ provider: mockProvider, userDataDir: tmpUserData });
      assert.strictEqual(recoveredA.OPENAI_API_KEY, "sk-recovered-secret-key", "带前导点的 .orig 备份应被自愈识别");
      assert.strictEqual(fs.existsSync(binPath), true, "主 credentials.bin 必须被成功还原");
      fs.unlinkSync(binPath);
      fs.unlinkSync(dotOrigBak); // 消除场景间残留，防假阳性 (CODE_REVIEW 缺口 2)

      // 模拟场景 B：主 credentials.bin 缺失，残留历史无前导点 credentials.bin.orig.*.tmp
      const noDotOrigBak = path.join(tmpUserData, "credentials.bin.orig.88888888.def.tmp");
      fs.writeFileSync(noDotOrigBak, originalCipher);

      const recoveredB = loadCredentials({ provider: mockProvider, userDataDir: tmpUserData });
      assert.strictEqual(recoveredB.OPENAI_API_KEY, "sk-recovered-secret-key", "无前导点的 .orig 备份应被自愈识别");
      assert.strictEqual(fs.existsSync(binPath), true);
      fs.unlinkSync(binPath);
      fs.unlinkSync(noDotOrigBak); // 消除场景间残留

      // 模拟场景 C：主 credentials.bin 缺失，残留两阶段交换备份 .credentials.bin.swap.*.tmp
      const swapBak = path.join(tmpUserData, ".credentials.bin.swap.77777777.ghi.tmp");
      fs.writeFileSync(swapBak, originalCipher);

      const recoveredC = loadCredentials({ provider: mockProvider, userDataDir: tmpUserData });
      assert.strictEqual(recoveredC.OPENAI_API_KEY, "sk-recovered-secret-key", ".swap 备份应被自愈识别");
      assert.strictEqual(fs.existsSync(binPath), true);
    } finally {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  test("CODE_REVIEW R-03: 主文件损坏时能从有效备份自愈，且无有效备份时 saveCredentials 拒绝覆盖", () => {
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-corrupt-guard-"));
    const mockProvider = createMockSafeStorage(true);

    try {
      saveCredentials(
        { DEEPSEEK_API_KEY: "vital-deepseek-key", ANTHROPIC_API_KEY: "vital-claude-key" },
        { provider: mockProvider, userDataDir: tmpUserData }
      );

      const binPath = path.join(tmpUserData, "credentials.bin");
      const validCipher = fs.readFileSync(binPath);

      // 模拟场景 1：主 credentials.bin 存在但被损毁截断（如坏扇区或进程中断写出的 0 字节文件）
      // 同时存在一个历史有效备份
      fs.writeFileSync(binPath, Buffer.from("CORRUPTED_TRUNCATED_CIPHER"));
      const validBak = path.join(tmpUserData, ".credentials.bin.orig.11111111.ok.tmp");
      fs.writeFileSync(validBak, validCipher);

      const recovered = loadCredentials({ provider: mockProvider, userDataDir: tmpUserData });
      assert.strictEqual(recovered.DEEPSEEK_API_KEY, "vital-deepseek-key", "损坏主文件时应从有效备份恢复");
      assert.strictEqual(recovered.ANTHROPIC_API_KEY, "vital-claude-key");

      // 模拟场景 2：主文件彻底损坏，且无任何有效备份
      fs.writeFileSync(binPath, Buffer.from("IRRECOVERABLE_GARBAGE"));
      fs.unlinkSync(validBak);

      // loadCredentials 应抛出明确的解密失败异常
      assert.throws(
        () => loadCredentials({ provider: mockProvider, userDataDir: tmpUserData }),
        /Credential decryption failed/
      );

      // 核心安全防线：saveCredentials 绝不能以空对象静默覆盖抹除历史数据
      assert.throws(
        () => saveCredentials({ NEW_KEY: "new-key-value" }, { provider: mockProvider, userDataDir: tmpUserData }),
        /Refusing to overwrite to prevent data loss/
      );
    } finally {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  test("CODE_REVIEW 深度加固：多个有效备份并存时，严格按修改时间/时间戳由新到旧恢复，杜绝恢复较旧密钥", () => {
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-time-priority-"));
    const mockProvider = createMockSafeStorage(true);

    try {
      const binPath = path.join(tmpUserData, "credentials.bin");

      // 构造较旧的备份 (时间戳 1000000，内容为旧密钥)
      // 注意：以字母 c 开头，在字符字典序逆序中 "credentials..." 会排在 ".credentials..." 前面
      const oldCipher = mockProvider.encryptString(JSON.stringify({ SECRET: "old-stale-value" }));
      const oldBak = path.join(tmpUserData, "credentials.bin.orig.1000000000000.abc.tmp");
      fs.writeFileSync(oldBak, oldCipher);
      const oldTime = new Date("2026-01-01T00:00:00Z");
      fs.utimesSync(oldBak, oldTime, oldTime);

      // 构造较新的备份 (时间戳 2000000，内容为最新密钥)
      // 以点 . 开头
      const newCipher = mockProvider.encryptString(JSON.stringify({ SECRET: "new-latest-value" }));
      const newBak = path.join(tmpUserData, ".credentials.bin.orig.2000000000000.xyz.tmp");
      fs.writeFileSync(newBak, newCipher);
      const newTime = new Date("2026-06-01T00:00:00Z");
      fs.utimesSync(newBak, newTime, newTime);

      // 验证自愈：必须选取较新的备份，返回 new-latest-value，而非字典序优先的 old-stale-value
      const recovered = loadCredentials({ provider: mockProvider, userDataDir: tmpUserData });
      assert.strictEqual(recovered.SECRET, "new-latest-value", "必须优先恢复时间更新的有效备份");
      assert.strictEqual(fs.existsSync(binPath), true);
    } finally {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });
});



