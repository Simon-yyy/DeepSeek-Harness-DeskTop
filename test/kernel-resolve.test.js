const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  readPackageVersion,
  selectBestCandidate,
  resolveDshKernel,
  getLocalKernelVersion,
  hasNodeInstalled,
  validateKernelTargetVersion,
} = require("../src/main/utils/kernel");

test("readPackageVersion 正确读取包版本与异常防御", () => {
  // 1. 无效路径
  assert.strictEqual(readPackageVersion(""), null);
  assert.strictEqual(readPackageVersion("C:\\non_existent_path\\bin.js"), null);

  // 2. 本地真实 bundled-backend 或 node_modules 测试
  const bundledBin = path.join(__dirname, "../bundled-backend/@deepseek-ai/dsh/lib/bin.js");
  if (fs.existsSync(bundledBin)) {
    const ver = readPackageVersion(bundledBin);
    assert.strictEqual(ver, "0.1.7-rc.2");
  }
});

test("selectBestCandidate 候选版本仲裁与时间戳裁决", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kernel-test-"));
  try {
    // 构造候选 A (v0.1.2)
    const dirA = path.join(tmpDir, "candA", "lib");
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "candA", "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.2-rc.1" }),
      "utf8"
    );
    const binA = path.join(dirA, "bin.js");
    fs.writeFileSync(binA, "// binA", "utf8");

    // 构造候选 B (v0.1.5)
    const dirB = path.join(tmpDir, "candB", "lib");
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "candB", "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.3" }),
      "utf8"
    );
    const binB = path.join(dirB, "bin.js");
    fs.writeFileSync(binB, "// binB", "utf8");

    // 1. 版本仲裁：高版本 v0.1.5-rc.3 应胜出
    const res1 = selectBestCandidate([binA, binB]);
    assert.strictEqual(res1.best, binB);
    assert.strictEqual(res1.bestVer, "0.1.5-rc.3");

    // 2. 单候选仲裁
    const res2 = selectBestCandidate([binA]);
    assert.strictEqual(res2.best, binA);
    assert.strictEqual(res2.bestVer, "0.1.2-rc.1");

    // 3. 空列表仲裁
    const resEmpty = selectBestCandidate([]);
    assert.strictEqual(resEmpty.best, null);
    assert.strictEqual(resEmpty.bestVer, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveDshKernel DSH_BIN 环境变量强覆盖", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-env-test-"));
  try {
    const fakeBin = path.join(tmpDir, "bin.js");
    fs.writeFileSync(fakeBin, "// fake", "utf8");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version: "9.9.9" }),
      "utf8"
    );

    const oldEnv = process.env.DSH_BIN;
    try {
      process.env.DSH_BIN = fakeBin;
      const kernel = resolveDshKernel();
      assert.strictEqual(kernel.source, "env");
      assert.strictEqual(kernel.path, fakeBin);
      assert.strictEqual(kernel.version, "9.9.9");
    } finally {
      if (oldEnv) {
        process.env.DSH_BIN = oldEnv;
      } else {
        delete process.env.DSH_BIN;
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveDshKernel 当前工作区真实内核解析与仲裁", () => {
  const kernel = resolveDshKernel({
    appRoot: path.resolve(__dirname, "../"),
  });
  // 当前机器全局已装 0.1.5-rc.1，内置为 0.1.2-rc.1，应正确仲裁使用更高版本的全局包，解决离线包劫持问题！
  assert.ok(kernel.path, "应成功定位到内核路径");
  assert.ok(kernel.version, "应成功获取内核版本号");
  assert.strictEqual(["installed", "bundled", "npx"].includes(kernel.source), true);
  console.info(`[Test] Current resolved kernel: v${kernel.version} (${kernel.source}) at ${kernel.path}`);
});

test("hasNodeInstalled 环境感知", () => {
  assert.strictEqual(hasNodeInstalled(), true);
});

test("bundled-backend 运行时结构完整性与零垃圾防护", () => {
  const bundledDir = path.join(__dirname, "../bundled-backend/@deepseek-ai/dsh");
  if (!fs.existsSync(bundledDir)) return;

  const binPath = path.join(bundledDir, "lib", "bin.js");
  const pkgPath = path.join(bundledDir, "package.json");

  assert.strictEqual(fs.existsSync(binPath), true, "bin.js 入口文件必须存在");
  assert.strictEqual(fs.existsSync(pkgPath), true, "package.json 必须存在");

  const ver = readPackageVersion(binPath);
  assert.ok(ver, "必须能正常解析出内置内核版本号");

  // 确保 node_modules 下不再存在 .map 垃圾调试文件
  const nodeModulesDir = path.join(bundledDir, "node_modules");
  if (fs.existsSync(nodeModulesDir)) {
    let hasMapFile = false;
    function checkMaps(dir, depth = 0) {
      if (depth > 4 || hasMapFile) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".map")) {
          hasMapFile = true;
          return;
        } else if (e.isDirectory() && !e.name.startsWith(".")) {
          checkMaps(path.join(dir, e.name), depth + 1);
        }
      }
    }
    checkMaps(nodeModulesDir);
    assert.strictEqual(hasMapFile, false, "内置内核中严禁残留 .map 调试文件以保障极速安装");
  }
});

test("CODE_REVIEW R-04: validateKernelTargetVersion 严格拒绝非法版本升级，严禁静默回退为 latest", () => {
  // 1. 合法 SemVer
  assert.deepStrictEqual(validateKernelTargetVersion("0.1.7-rc.2"), {
    valid: true,
    type: "semver",
    clean: "0.1.7-rc.2",
  });
  assert.deepStrictEqual(validateKernelTargetVersion("v1.2.3"), {
    valid: true,
    type: "semver",
    clean: "1.2.3",
  });

  // 2. 合法通道
  assert.deepStrictEqual(validateKernelTargetVersion("latest"), {
    valid: true,
    type: "channel",
    clean: "latest",
  });
  assert.deepStrictEqual(validateKernelTargetVersion("next"), {
    valid: true,
    type: "channel",
    clean: "next",
  });
  assert.deepStrictEqual(validateKernelTargetVersion(""), {
    valid: true,
    type: "channel",
    clean: "latest",
  });

  // 3. 非法版本输入：必须返回 valid: false，附带明确错误信息拒绝升级
  const invalidTargets = [
    "0.1.7 & whoami",
    "0.1.7 | calc.exe",
    "invalid-ver-xyz",
    "1.2.3 malicious",
    "null",
    "undefined",
    "; rm -rf /",
  ];

  for (const inv of invalidTargets) {
    const res = validateKernelTargetVersion(inv);
    assert.strictEqual(res.valid, false, `必须拒绝非法版本: ${inv}`);
    assert.match(res.error, /指定的内核版本格式非法/);
    assert.match(res.error, /禁止静默降级升级/);
  }
});


