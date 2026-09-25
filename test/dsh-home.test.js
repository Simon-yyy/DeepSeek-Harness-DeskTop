/**
 * Unit tests for Unified DSH_HOME & Path Resolution (IMPLEMENT.md 5.2.5)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const {
  resolveDshHome,
  expandHomePath,
  dshHomePath,
  getWebProfileDir,
  getSkillsDir,
  getNetworkShimPath,
  getCredentialsYamlPath,
  getEncryptedCredentialsPath,
  getPidFilePath,
} = require("../src/main/utils/home");

describe("DSH_HOME 路径解析与多实例隔离 (5.2.5)", () => {
  const realHome = os.homedir();

  test("默认无环境变量时回退到系统的 ~/.dsh", () => {
    const resolved = resolveDshHome(undefined, {});
    assert.equal(resolved, path.resolve(path.join(realHome, ".dsh")));
  });

  test("环境变量 DSH_HOME 具备生效优先级", () => {
    const custom = "C:\\test\\custom_dsh";
    const resolved = resolveDshHome(undefined, { DSH_HOME: custom });
    assert.equal(resolved, path.resolve(custom));
  });

  test("空白或纯空格的 DSH_HOME 被忽略，安全回退到 ~/.dsh", () => {
    const resolved = resolveDshHome(undefined, { DSH_HOME: "   " });
    assert.equal(resolved, path.resolve(path.join(realHome, ".dsh")));
  });

  test("显式 configured 参数具备最高优先级，覆盖 DSH_HOME", () => {
    const configured = "D:\\explicit\\dsh";
    const resolved = resolveDshHome(configured, { DSH_HOME: "C:\\ignored" });
    assert.equal(resolved, path.resolve(configured));
  });

  test("支持 ~ 与 ~/ 波浪号展开", () => {
    const mockHome = path.join(os.tmpdir(), "dsh-mock-user");
    const exp1 = expandHomePath("~", mockHome);
    assert.equal(exp1, mockHome);

    const exp2 = expandHomePath("~/my-dsh", mockHome);
    assert.equal(exp2, path.join(mockHome, "my-dsh"));
  });

  test("派生路径均在解析出的 DSH_HOME 之下，保证隔离性", () => {
    const fakeDshHome = path.join(os.tmpdir(), "dsh-test-isolate-" + Date.now());
    const savedEnv = process.env.DSH_HOME;
    try {
      process.env.DSH_HOME = fakeDshHome;

      const profile = getWebProfileDir();
      assert.equal(profile, path.join(fakeDshHome, "profiles", "web"));

      const skills = getSkillsDir();
      assert.equal(skills, path.join(fakeDshHome, "skills"));

      const shim = getNetworkShimPath();
      assert.equal(shim, path.join(fakeDshHome, "network-shim.js"));

      const creds = getCredentialsYamlPath();
      assert.equal(creds, path.join(fakeDshHome, ".credentials.yaml"));

      const customPid = getPidFilePath("C:\\userDataDir");
      assert.equal(customPid, "C:\\userDataDir\\backend.pid");

      const defaultPid = getPidFilePath();
      assert.equal(defaultPid, path.join(fakeDshHome, "backend.pid"));
    } finally {
      if (savedEnv !== undefined) {
        process.env.DSH_HOME = savedEnv;
      } else {
        delete process.env.DSH_HOME;
      }
    }
  });
});
