const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const {
  verifyInstallerIntegrity,
  canExecuteInstaller,
  getExpectedInstallerFileName,
  buildReleaseDownloadUrl,
} = require("../src/main/utils/updater");

test("5.9 & 5.11 项一：verifyInstallerIntegrity 完整性与执行安全决策", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-updater-test-"));

  t.after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_e) {}
  });

  await t.test("安装包尺寸低于阈值时，自动删除文件并阻断抛错", () => {
    const fakeInstaller = path.join(tempDir, "broken-installer.exe");
    fs.writeFileSync(fakeInstaller, Buffer.alloc(1024)); // 1KB < 5MB

    assert.throws(
      () => verifyInstallerIntegrity(fakeInstaller, { minSizeBytes: 10 * 1024 }),
      /安装包文件尺寸异常/
    );
    assert.strictEqual(fs.existsSync(fakeInstaller), false, "破损文件应被物理安全删除");
  });

  await t.test("哈希不匹配时，自动删除文件并抛出防劫持篡改异常", () => {
    const fakeInstaller = path.join(tempDir, "tampered-installer.exe");
    const content = Buffer.alloc(20 * 1024, "A"); // 20KB
    fs.writeFileSync(fakeInstaller, content);

    const wrongHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert.throws(
      () => verifyInstallerIntegrity(fakeInstaller, { minSizeBytes: 10 * 1024, expectedSha256: wrongHash }),
      /SHA-256 完整性哈希校验失败/
    );
    assert.strictEqual(fs.existsSync(fakeInstaller), false, "篡改文件应被物理安全删除");
  });

  await t.test("哈希精确匹配时校验通过，保留文件且允许自动执行", () => {
    const fakeInstaller = path.join(tempDir, "valid-installer.exe");
    const content = Buffer.alloc(20 * 1024, "B");
    fs.writeFileSync(fakeInstaller, content);

    const actualHash = crypto.createHash("sha256").update(content).digest("hex");
    const result = verifyInstallerIntegrity(fakeInstaller, {
      minSizeBytes: 10 * 1024,
      expectedSha256: actualHash.toUpperCase(), // 支持大小写不敏感
    });

    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.hash, actualHash);
    assert.strictEqual(fs.existsSync(fakeInstaller), true);

    const decision = canExecuteInstaller(result);
    assert.strictEqual(decision.canExecute, true);
  });

  await t.test("未提供预期哈希依据时，返回未验证状态并严格阻断自动执行 (5.11 项一)", () => {
    const fakeInstaller = path.join(tempDir, "no-hash-installer.exe");
    const content = Buffer.alloc(20 * 1024, "C");
    fs.writeFileSync(fakeInstaller, content);

    const result = verifyInstallerIntegrity(fakeInstaller, { minSizeBytes: 10 * 1024 });
    assert.strictEqual(result.verified, false);
    assert.match(result.warning, /未提供远端校验哈希/);
    assert.strictEqual(fs.existsSync(fakeInstaller), true);

    // 严格阻断静默自动执行
    const decision = canExecuteInstaller(result);
    assert.strictEqual(decision.canExecute, false);
    assert.match(decision.reason, /缺少远端可信校验哈希或代码签名依据/);
  });

  await t.test("5.12: getExpectedInstallerFileName 与 release.mjs 发布规约保持一致", () => {
    // 验证带 v 与不带 v 的版本号规范化
    assert.strictEqual(getExpectedInstallerFileName("1.3.0"), "DSH Desktop Setup 1.3.0.exe");
    assert.strictEqual(getExpectedInstallerFileName("v1.3.0"), "DSH Desktop Setup 1.3.0.exe");
    assert.strictEqual(getExpectedInstallerFileName("2.0.0-beta.1"), "DSH Desktop Setup 2.0.0-beta.1.exe");

    // 验证与 scripts/release.mjs:102 中声明的文件命名模板完全匹配
    const releaseScriptPath = path.join(__dirname, "../scripts/release.mjs");
    if (fs.existsSync(releaseScriptPath)) {
      const scriptContent = fs.readFileSync(releaseScriptPath, "utf8");
      assert.match(
        scriptContent,
        /const\s+installerName\s*=\s*`DSH Desktop Setup \$\{newVersion\}\.exe`/,
        "必须与 release.mjs 中的 installerName 命名规范一致"
      );
    }
  });

  await t.test("5.12: buildReleaseDownloadUrl 正确构造 GitHub 下载地址并完成 URL 转义", () => {
    const url1 = buildReleaseDownloadUrl("Simon-yyy", "DeepSeek-Harness-DeskTop", "v1.3.0");
    assert.strictEqual(
      url1,
      "https://github.com/Simon-yyy/DeepSeek-Harness-DeskTop/releases/download/v1.3.0/DSH%20Desktop%20Setup%201.3.0.exe"
    );

    const url2 = buildReleaseDownloadUrl(
      "Simon-yyy",
      "DeepSeek-Harness-DeskTop",
      "v2.1.0",
      "Custom Installer 2.1.0.exe"
    );
    assert.strictEqual(
      url2,
      "https://github.com/Simon-yyy/DeepSeek-Harness-DeskTop/releases/download/v2.1.0/Custom%20Installer%202.1.0.exe"
    );
  });
});

