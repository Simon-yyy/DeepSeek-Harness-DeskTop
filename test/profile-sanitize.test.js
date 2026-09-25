const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  CORE_BASE_BUNDLES,
  INCOMPATIBLE_PLUGINS,
  VERIFIED_PLUGIN_COMPAT_MATRIX,
  mergeNpmrc,
  ensureWebProfileNpmrc,
  sanitizeProfileJson,
  healPluginCompatibility,
  restorePluginToWebProfile,
  removePluginFromPatchYaml,
  uninstallPluginFromWebProfile,
  sanitizeWebProfile,
} = require("../src/main/utils/profile");

test("mergeNpmrc 非破坏性增量合并策略", () => {
  // 1. 空配置：注入必要配置
  const r1 = mergeNpmrc("");
  assert.strictEqual(r1.modified, true);
  assert.ok(r1.content.includes("legacy-peer-deps=true"));
  assert.ok(r1.content.includes("registry=https://registry.npmmirror.com/"));

  // 2. 用户已有私有源：绝不覆盖篡改已有 registry
  const customNpmrc = "registry=https://npm.mycompany.org/\nstrict-ssl=false\n";
  const r2 = mergeNpmrc(customNpmrc);
  assert.strictEqual(r2.modified, true);
  assert.ok(r2.content.includes("registry=https://npm.mycompany.org/"));
  assert.ok(!r2.content.includes("registry.npmmirror.com"));
  assert.ok(r2.content.includes("legacy-peer-deps=true"));

  // 3. 配置已完备：不触发写入修改
  const completeNpmrc = "legacy-peer-deps=true\nregistry=https://custom.org/\n";
  const r3 = mergeNpmrc(completeNpmrc);
  assert.strictEqual(r3.modified, false);
  assert.strictEqual(r3.content, completeNpmrc);
});

test("sanitizeProfileJson 结构清洗与物理自愈剔除", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-profile-test-"));
  try {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    // 模拟本地真实安装的合法第三方插件
    const installedPluginDir = path.join(nodeModulesDir, "my-installed-plugin");
    fs.mkdirSync(installedPluginDir, { recursive: true });

    const rawPkg = {
      name: "dsh-web-profile",
      dependencies: {
        "@deepseek-harness-tui/dsh-tui": "^1.0.0", // 需过滤的 TTY 插件
        "my-installed-plugin": "^1.0.0",
      },
      dsh: {
        profile: {
          bundles: [
            "@deepseek-harness-tui/dsh-tui", // 需过滤
            "ghost-missing-plugin",          // 物理缺失，需自愈剔除
            "my-installed-plugin",          // 物理存在，需保留
          ],
        },
      },
    };

    const { pkg, modified } = sanitizeProfileJson(rawPkg, { nodeModulesDir });

    assert.strictEqual(modified, true);
    // 1. TTY 插件已彻底移除
    assert.strictEqual(pkg.dependencies["@deepseek-harness-tui/dsh-tui"], undefined);
    assert.ok(!pkg.dsh.profile.bundles.includes("@deepseek-harness-tui/dsh-tui"));

    // 2. 缺失的幽灵插件已被自愈剔除
    assert.ok(!pkg.dsh.profile.bundles.includes("ghost-missing-plugin"));

    // 3. 真实存在的插件完整保留
    assert.ok(pkg.dsh.profile.bundles.includes("my-installed-plugin"));

    // 4. 官方基底强制置顶
    assert.strictEqual(pkg.dsh.profile.bundles[0], "@deepseek-ai/dsh-base");
    assert.strictEqual(pkg.dsh.profile.bundles[1], "@deepseek-ai/dsh-web-app");

    // 5. 纯净原则：绝不向 clean package 强塞未请求的第三方依赖
    assert.strictEqual(pkg.dependencies["dshmarket"], undefined);
    assert.strictEqual(pkg.dependencies["dsh-better-sidebar"], undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sanitizeWebProfile 端到端物理目录清洗与幂等性", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-profile-e2e-"));
  try {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "test-profile",
        dsh: { profile: { bundles: [] } },
      }),
      "utf8"
    );

    // 第一次清洗：应注入官方核心基底并生成 .npmrc
    const mod1 = sanitizeWebProfile(tmpDir);
    assert.strictEqual(mod1, true);

    const npmrcPath = path.join(tmpDir, ".npmrc");
    assert.ok(fs.existsSync(npmrcPath));

    const savedPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    assert.deepStrictEqual(savedPkg.dsh.profile.bundles, CORE_BASE_BUNDLES);

    // 第二次清洗：幂等性保证，无变化不重复写入
    const mod2 = sanitizeWebProfile(tmpDir);
    assert.strictEqual(mod2, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("healPluginCompatibility 第三方插件硬编码白名单补全与防崩自愈", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugin-heal-"));
  try {
    const autoModeDir = path.join(tmpDir, "node_modules", "@nanmicoder", "dsh-auto-mode");
    fs.mkdirSync(path.join(autoModeDir, "lib"), { recursive: true });

    const compatJsonPath = path.join(autoModeDir, "compatibility.json");
    fs.writeFileSync(
      compatJsonPath,
      JSON.stringify({
        schemaVersion: 1,
        supportedHosts: [{ version: "0.1.2-rc.1", track: "recommended" }],
      }, null, 2),
      "utf8"
    );

    const compatJsPath = path.join(autoModeDir, "lib", "harness-compat.js");
    fs.writeFileSync(
      compatJsPath,
      `export function assertHarnessCompatibility() { throw new Error(\`Auto Mode: unsupported or mixed Harness packages (err)\`); }`,
      "utf8"
    );

    // 执行针对现代内核 0.1.5-rc.3 的自愈
    const healed = healPluginCompatibility(tmpDir, "0.1.5-rc.3");
    assert.strictEqual(healed, true);

    // 验证 compatibility.json 已注入支持
    const updatedCompat = JSON.parse(fs.readFileSync(compatJsonPath, "utf8"));
    const has015 = updatedCompat.supportedHosts.some((h) => h.version === "0.1.5-rc.3");
    assert.ok(has015, "compatibility.json 必须包含 0.1.5-rc.3 支持声明");

    // 验证 harness-compat.js 中的致命抛错已替换为防崩警告
    const updatedCode = fs.readFileSync(compatJsPath, "utf8");
    assert.ok(!updatedCode.includes("throw new Error(`Auto Mode: unsupported"), "致命崩溃已被剔除");
    assert.ok(updatedCode.includes("console.warn"), "必须包含非崩溃式告警");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("removePluginFromPatchYaml 精确剥离 cordis.patch.yml 插件条目", () => {
  const sampleYaml = `# Explicitly mount core community plugins
- id: dsh-market
  name: 'dshmarket'
- id: auto-permission-mode
  name: '@nanmicoder/dsh-auto-mode'
- id: modlens
  name: '@liustack/modlens'
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
`;

  // 1. 精确根据包名移除
  const { content: c1, modified: m1 } = removePluginFromPatchYaml(sampleYaml, "@nanmicoder/dsh-auto-mode");
  assert.strictEqual(m1, true);
  assert.ok(!c1.includes("@nanmicoder/dsh-auto-mode"));
  assert.ok(!c1.includes("auto-permission-mode"));
  assert.ok(c1.includes("dsh-market"));
  assert.ok(c1.includes("modlens"));
  assert.ok(c1.includes("ui-settings-general"));
  assert.ok(c1.includes("welcomeNoticeVersion: 2026-08-13.1"));

  // 2. 匹配不存在的条目：幂等无变更
  const { content: c2, modified: m2 } = removePluginFromPatchYaml(c1, "non-existent-plugin");
  assert.strictEqual(m2, false);
  assert.strictEqual(c2, c1);
});

test("uninstallPluginFromWebProfile 全链路彻底物理卸载与死循环自愈", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-uninstall-test-"));
  try {
    // 构造 package.json
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "dsh-profile-web",
        dependencies: {
          "@nanmicoder/dsh-auto-mode": "^0.1.7",
          "dshmarket": "^1.65.1",
        },
        dsh: {
          profile: {
            bundles: [
              "@deepseek-ai/dsh-base",
              "@deepseek-ai/dsh-web-app",
              "dshmarket",
              "@nanmicoder/dsh-auto-mode",
            ],
          },
        },
      }, null, 2),
      "utf8"
    );

    // 构造 cordis.patch.yml
    const patchPath = path.join(tmpDir, "cordis.patch.yml");
    fs.writeFileSync(
      patchPath,
      `- id: dsh-market\n  name: 'dshmarket'\n- id: auto-mode\n  name: '@nanmicoder/dsh-auto-mode'\n`,
      "utf8"
    );

    // 构造 .dsh-market/state.json
    const marketDir = path.join(tmpDir, ".dsh-market");
    fs.mkdirSync(marketDir, { recursive: true });
    const statePath = path.join(marketDir, "state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ disabled: ["@nanmicoder/dsh-auto-mode", "other-plugin"] }),
      "utf8"
    );

    // 构造物理 node_modules 目录
    const pluginDir = path.join(tmpDir, "node_modules", "@nanmicoder", "dsh-auto-mode");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "package.json"), "{}", "utf8");

    // 执行卸载
    const res = uninstallPluginFromWebProfile(tmpDir, "@nanmicoder/dsh-auto-mode");
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.packageJsonModified, true);
    assert.strictEqual(res.patchModified, true);
    assert.strictEqual(res.stateModified, true);
    assert.strictEqual(res.directoryRemoved, true);

    // 验证 package.json
    const updatedPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    assert.strictEqual(updatedPkg.dependencies["@nanmicoder/dsh-auto-mode"], undefined);
    assert.ok(!updatedPkg.dsh.profile.bundles.includes("@nanmicoder/dsh-auto-mode"));
    assert.ok(updatedPkg.dsh.profile.bundles.includes("dshmarket"));

    // 验证 cordis.patch.yml
    const updatedPatch = fs.readFileSync(patchPath, "utf8");
    assert.ok(!updatedPatch.includes("@nanmicoder/dsh-auto-mode"));
    assert.ok(updatedPatch.includes("dsh-market"));

    // 验证 state.json
    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(!updatedState.disabled.includes("@nanmicoder/dsh-auto-mode"));
    assert.ok(updatedState.disabled.includes("other-plugin"));

    // 验证物理目录已被删除
    assert.strictEqual(fs.existsSync(pluginDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("validatePluginPackageName 严格白名单校验防注入 (5.2.4)", () => {
  const { validatePluginPackageName } = require("../src/main/utils/profile");
  // 合法包名
  assert.strictEqual(validatePluginPackageName("dshmarket"), true);
  assert.strictEqual(validatePluginPackageName("@nanmicoder/dsh-auto-mode"), true);
  assert.strictEqual(validatePluginPackageName("@deepseek-ai/dsh-base"), true);

  // 非法包名：路径穿透与非法字符
  assert.strictEqual(validatePluginPackageName("../../victim"), false);
  assert.strictEqual(validatePluginPackageName("../dsh-plugin"), false);
  assert.strictEqual(validatePluginPackageName("foo/../../bar"), false);
  assert.strictEqual(validatePluginPackageName("/absolute/path"), false);
  assert.strictEqual(validatePluginPackageName("c:\\windows\\system32"), false);
  assert.strictEqual(validatePluginPackageName("evil;rm -rf /"), false);
  assert.strictEqual(validatePluginPackageName(""), false);
  assert.strictEqual(validatePluginPackageName(null), false);
});

test("uninstallPluginFromWebProfile 阻断目录逃逸攻击与生成 .bak 备份 (5.2.4)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-escape-test-"));
  try {
    const modulesDir = path.join(tmpDir, "node_modules");
    fs.mkdirSync(modulesDir, { recursive: true });

    // 在 profile 外创建一个敏感文件
    const secretFile = path.join(tmpDir, "sensitive-victim.txt");
    fs.writeFileSync(secretFile, "should not be deleted", "utf8");

    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "profile", dependencies: {} }), "utf8");

    // 尝试传入带 .. 逃逸路径的插件名
    const res = uninstallPluginFromWebProfile(tmpDir, "../../sensitive-victim.txt");
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes("Invalid plugin package name") || res.error.includes("Security violation"));

    // 敏感文件必须完好无损
    assert.strictEqual(fs.existsSync(secretFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sanitizeProfileJson 当 node_modules 目录完全缺失时正确剔除非官方核心 bundle (5.2.3)", () => {
  const nonExistentModulesDir = path.join(os.tmpdir(), "non-existent-modules-" + Date.now());

  const rawPkg = {
    name: "profile-without-modules",
    dependencies: { "phantom-plugin": "1.0.0" },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "phantom-plugin",
          "@deepseek-ai/dsh-web-app",
        ],
      },
    },
  };

  const { pkg, modified } = sanitizeProfileJson(rawPkg, { nodeModulesDir: nonExistentModulesDir });
  assert.strictEqual(modified, true);
  // phantom-plugin 应当被自愈剔除，只保留核心 bundle
  assert.ok(!pkg.dsh.profile.bundles.includes("phantom-plugin"));
  assert.strictEqual(pkg.dsh.profile.bundles.length, 2);
  assert.strictEqual(pkg.dsh.profile.bundles[0], "@deepseek-ai/dsh-base");
  assert.strictEqual(pkg.dsh.profile.bundles[1], "@deepseek-ai/dsh-web-app");
});

test("sanitizeWebProfile 禁用不兼容插件时保留安装并移除挂载", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-disable-plugin-"));
  try {
    const pluginDir = path.join(tmpDir, "node_modules", "dsh-better-sidebar");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "dsh-better-sidebar", version: "0.18.1" }));

    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: "dsh-profile-web",
      dependencies: { "dsh-better-sidebar": "^0.18.1" },
      dsh: { profile: { bundles: [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-better-sidebar",
      ] } },
    }), "utf8");
    const patchPath = path.join(tmpDir, "cordis.patch.yml");
    fs.writeFileSync(patchPath, "- id: dsh-better-sidebar\n  name: 'dsh-better-sidebar'\n", "utf8");

    sanitizeWebProfile(tmpDir, { excludeBundles: ["dsh-better-sidebar"] });

    const updatedPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    assert.equal(updatedPkg.dependencies["dsh-better-sidebar"], "^0.18.1");
    assert.equal(updatedPkg.dsh.profile.bundles.includes("dsh-better-sidebar"), false);
    assert.equal(fs.existsSync(pluginDir), true);
    assert.equal(fs.readFileSync(patchPath, "utf8").includes("dsh-better-sidebar"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("R1-5: 插件升级到兼容版本后，支持安全可逆恢复其在 cordis.patch.yml 与 package.json 中的挂载", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-restore-plugin-"));
  try {
    const pluginDir = path.join(tmpDir, "node_modules", "dsh-better-sidebar");
    fs.mkdirSync(pluginDir, { recursive: true });
    // 模拟升级到官方适配兼容的现代版本
    fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "dsh-better-sidebar", version: "0.21.0" }));

    // 此时 package.json 与 patch.yml 中由于历史清洗缺失了该 bundle
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: "dsh-profile-web",
      dependencies: { "dsh-better-sidebar": "^0.21.0" },
      dsh: { profile: { bundles: [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
      ] } },
    }), "utf8");

    const patchPath = path.join(tmpDir, "cordis.patch.yml");
    fs.writeFileSync(patchPath, "# cordis patch configuration\n", "utf8");
    // 模拟备份文件保留了原始配置
    fs.writeFileSync(patchPath + ".bak", "# cordis patch configuration\n- id: dsh-better-sidebar\n  name: 'dsh-better-sidebar'\n", "utf8");

    // 执行包含 restoreBundles 的 profile 清洗流程
    sanitizeWebProfile(tmpDir, { restoreBundles: ["dsh-better-sidebar"] });

    // 1. 验证 package.json 中成功可逆恢复该 bundle
    const restoredPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    assert.equal(restoredPkg.dsh.profile.bundles.includes("dsh-better-sidebar"), true);

    // 2. 验证 cordis.patch.yml 中成功可逆恢复挂载条目
    const restoredPatch = fs.readFileSync(patchPath, "utf8");
    assert.equal(restoredPatch.includes("dsh-better-sidebar"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("R2-2: 未经矩阵验证的第三方插件版本严禁盲目篡改源码", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-matrix-heal-"));
  try {
    const autoModeDir = path.join(tmpDir, "node_modules", "@nanmicoder", "dsh-auto-mode");
    fs.mkdirSync(path.join(autoModeDir, "lib"), { recursive: true });

    // 1. 模拟未验证的全新大版本 (如 9.9.9)
    fs.writeFileSync(path.join(autoModeDir, "package.json"), JSON.stringify({ name: "@nanmicoder/dsh-auto-mode", version: "9.9.9" }));
    const compatJson = { supportedHosts: [{ version: "0.1.2" }] };
    fs.writeFileSync(path.join(autoModeDir, "compatibility.json"), JSON.stringify(compatJson, null, 2));
    const originalJs = "throw new Error(`Auto Mode: unsupported or mixed Harness packages`);";
    fs.writeFileSync(path.join(autoModeDir, "lib", "harness-compat.js"), originalJs);

    // 执行自愈：由于不在矩阵中，必须安全跳过，严禁篡改
    const healedUnknown = healPluginCompatibility(tmpDir, "0.1.7-rc.2");
    assert.equal(healedUnknown, false);
    assert.equal(fs.readFileSync(path.join(autoModeDir, "lib", "harness-compat.js"), "utf8"), originalJs);

    // 2. 模拟受支持的已知版本 0.1.2：允许受控自愈
    fs.writeFileSync(path.join(autoModeDir, "package.json"), JSON.stringify({ name: "@nanmicoder/dsh-auto-mode", version: "0.1.2" }));
    const healedKnown = healPluginCompatibility(tmpDir, "0.1.7-rc.2");
    assert.equal(healedKnown, true);
    assert.notEqual(fs.readFileSync(path.join(autoModeDir, "lib", "harness-compat.js"), "utf8"), originalJs);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("5.9 项二: 未经矩阵验证的目标内核版本严禁盲目改写第三方 compatibility.json 或源码", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kernel-matrix-heal-"));
  try {
    const autoModeDir = path.join(tmpDir, "node_modules", "@nanmicoder", "dsh-auto-mode");
    fs.mkdirSync(path.join(autoModeDir, "lib"), { recursive: true });

    // 插件版本为受支持的 0.1.2，但目标内核版本为未经矩阵验证的未知版本 9.9.9
    fs.writeFileSync(path.join(autoModeDir, "package.json"), JSON.stringify({ name: "@nanmicoder/dsh-auto-mode", version: "0.1.2" }));
    const originalCompatJson = { supportedHosts: [{ version: "0.1.2" }] };
    const compatPath = path.join(autoModeDir, "compatibility.json");
    fs.writeFileSync(compatPath, JSON.stringify(originalCompatJson, null, 2));
    const originalJs = "throw new Error(`Auto Mode: unsupported or mixed Harness packages`);";
    const jsPath = path.join(autoModeDir, "lib", "harness-compat.js");
    fs.writeFileSync(jsPath, originalJs);

    // 执行自愈：由于内核版本不在矩阵中，必须安全跳过并保持两个文件原样不变
    const healed = healPluginCompatibility(tmpDir, "9.9.9");
    assert.equal(healed, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(compatPath, "utf8")), originalCompatJson);
    assert.equal(fs.readFileSync(jsPath, "utf8"), originalJs);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});



