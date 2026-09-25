const { test } = require("node:test");
const assert = require("node:assert/strict");
const { verifyProcessIdentity, checkPortOwnerFromNetstat, parseNetstatListeningPorts } = require("../src/main/utils/process-guard");

test("5.9 项四：verifyProcessIdentity 证据齐备制与防误杀安全核验", async (t) => {
  const now = 1727265842000;
  const validRecord = {
    pid: 12345,
    managed: "dsh-desktop",
    commandLineSnippet: "dsh web --port 3080",
    startTime: now,
  };
  const validProcInfo = {
    ProcessName: "node.exe",
    CommandLine: "node.exe d:\\app\\dsh web --port 3080 --host 127.0.0.1",
    CreationDate: String(now + 1000), // 相差 1 秒，容差内
  };

  await t.test("证据全齐且匹配时，判定身份合法并允许终止", () => {
    const res = verifyProcessIdentity(validRecord, validProcInfo, true);
    assert.strictEqual(res.verified, true);
  });

  await t.test("反例 1：PID 重用（CreationDate 与 startTime 相差 > 60s），严格拒绝终止", () => {
    const reusedProcInfo = {
      ...validProcInfo,
      CreationDate: String(now + 120_000), // 相差 120 秒
    };
    const res = verifyProcessIdentity(validRecord, reusedProcInfo, true);
    assert.strictEqual(res.verified, false);
    assert.match(res.reason, /PID 重用警报/);
  });

  await t.test("反例 2：时间证据缺失（缺少 startTime 或 CreationDate），严格拒绝终止", () => {
    const missingStartRecord = { ...validRecord, startTime: undefined };
    const res1 = verifyProcessIdentity(missingStartRecord, validProcInfo, true);
    assert.strictEqual(res1.verified, false);
    assert.match(res1.reason, /关键时间证据缺失/);

    const missingCreationProc = { ...validProcInfo, CreationDate: undefined };
    const res2 = verifyProcessIdentity(validRecord, missingCreationProc, true);
    assert.strictEqual(res2.verified, false);
    assert.match(res2.reason, /关键时间证据缺失/);
  });

  await t.test("反例 3：CreationDate 格式不可解析，严格拒绝终止", () => {
    const unparseableProc = { ...validProcInfo, CreationDate: "invalid-date-string" };
    const res = verifyProcessIdentity(validRecord, unparseableProc, true);
    assert.strictEqual(res.verified, false);
    assert.match(res.reason, /无法解析为有效时间戳/);
  });

  await t.test("反例 4：命令行相似但不包含专属特征片段，严格拒绝终止", () => {
    const otherProcInfo = {
      ...validProcInfo,
      CommandLine: "node.exe other-service.js --port 3080",
    };
    const res = verifyProcessIdentity(validRecord, otherProcInfo, true);
    assert.strictEqual(res.verified, false);
    assert.match(res.reason, /进程命令行特征与记录片段不匹配/);
  });

  await t.test("反例 5：目标端口当前并未由该 PID 监听（端口不归属），严格拒绝终止", () => {
    const res = verifyProcessIdentity(validRecord, validProcInfo, false);
    assert.strictEqual(res.verified, false);
    assert.match(res.reason, /目标端口当前并未由该 PID 监听/);
  });

  await t.test("反例 6：缺失 managed 托管标记，严格拒绝终止", () => {
    const unmanagedRecord = { ...validRecord, managed: "external" };
    const res = verifyProcessIdentity(unmanagedRecord, validProcInfo, true);
    assert.strictEqual(res.verified, false);
    assert.match(res.reason, /缺失或无效的 managed 托管标记/);
  });
});

test("5.11 项三：netstat 精确端口与 PID 解析，消除 3080 误匹配 30801", async (t) => {
  const sampleNetstatOutput = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1120
  TCP    0.0.0.0:3080           0.0.0.0:0              LISTENING       12345
  TCP    127.0.0.1:30801        0.0.0.0:0              LISTENING       67890
  TCP    [::]:3080              [::]:0                 LISTENING       12345
  TCP    [::1]:30801            [::]:0                 LISTENING       67890
  TCP    127.0.0.1:3080         127.0.0.1:54321        ESTABLISHED     12345
`;

  await t.test("正确匹配 3080 端口与对应 PID 12345 (IPv4 & IPv6)", () => {
    const isOwner = checkPortOwnerFromNetstat(sampleNetstatOutput, 12345, 3080);
    assert.strictEqual(isOwner, true);
  });

  await t.test("核心反例：查询 3080 端口时，不误匹配 30801 端口的 PID 67890", () => {
    const isOwner = checkPortOwnerFromNetstat(sampleNetstatOutput, 67890, 3080);
    assert.strictEqual(isOwner, false, "3080 不得误匹配监听 30801 的进程");
  });

  await t.test("正确匹配 30801 端口与对应 PID 67890", () => {
    const isOwner = checkPortOwnerFromNetstat(sampleNetstatOutput, 67890, 30801);
    assert.strictEqual(isOwner, true);
  });

  await t.test("反例：端口匹配 3080 但 PID 不符时返回 false", () => {
    const isOwner = checkPortOwnerFromNetstat(sampleNetstatOutput, 99999, 3080);
    assert.strictEqual(isOwner, false);
  });

  await t.test("非 LISTENING 状态 (如 ESTABLISHED) 被正确忽略", () => {
    const establishedOnlyOutput = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:3080         127.0.0.1:54321        ESTABLISHED     12345
`;
    const isOwner = checkPortOwnerFromNetstat(establishedOnlyOutput, 12345, 3080);
    assert.strictEqual(isOwner, false);
  });
});
