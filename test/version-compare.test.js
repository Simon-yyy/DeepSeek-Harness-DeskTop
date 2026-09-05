const test = require("node:test");
const assert = require("node:assert");

function compareVersions(v1, v2) {
  const clean1 = (v1 || "").replace(/^v/, "").trim();
  const clean2 = (v2 || "").replace(/^v/, "").trim();
  if (clean1 === clean2) return 0;

  const [main1, pre1] = clean1.split("-");
  const [main2, pre2] = clean2.split("-");

  const p1 = (main1 || "").split(".").map((n) => parseInt(n, 10) || 0);
  const p2 = (main2 || "").split(".").map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  if (!pre1 && pre2) return 1;
  if (pre1 && !pre2) return -1;
  if (pre1 && pre2) {
    return pre1.localeCompare(pre2, undefined, { numeric: true, sensitivity: "base" });
  }
  return 0;
}

test("compareVersions 基础版本比较", () => {
  assert.strictEqual(compareVersions("1.2.3", "1.2.3"), 0);
  assert.strictEqual(compareVersions("v1.2.4", "1.2.3"), 1);
  assert.strictEqual(compareVersions("1.2.3", "1.2.4"), -1);
  assert.strictEqual(compareVersions("2.0.0", "1.9.9"), 1);
  assert.strictEqual(compareVersions("0.1.1", "0.1.0"), 1);
});

test("compareVersions 预发布与RC版本比较", () => {
  assert.strictEqual(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.strictEqual(compareVersions("1.0.0-rc.2", "1.0.0-rc.1"), 1);
  assert.strictEqual(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
});
