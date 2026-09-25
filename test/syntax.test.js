const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

test("语法自动门禁：全量关键入口脚本语法完整性检查", async (t) => {
  const rootDir = path.resolve(__dirname, "..");
  const criticalFiles = [
    "main.js",
    "preload.js",
    "dsh-runner.js",
    "network-shim.js",
    "afterPack.js",
    "scripts/release.mjs",
    "scripts/prune-backend.mjs",
  ];

  for (const relFile of criticalFiles) {
    const fullPath = path.join(rootDir, relFile);
    await t.test(`node --check ${relFile}`, () => {
      assert.strictEqual(fs.existsSync(fullPath), true, `文件必须存在: ${relFile}`);
      assert.doesNotThrow(() => {
        execFileSync(process.execPath, ["--check", fullPath], {
          encoding: "utf8",
          stdio: "pipe",
        });
      }, `${relFile} 语法校验失败`);
    });
  }
});
