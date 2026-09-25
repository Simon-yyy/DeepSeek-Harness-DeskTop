const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  isKernelActivationUrl,
  extractBrowserSessionSecret,
  mintKernelAuthCookie,
  verifyKernelHttpReady,
} = require("../src/main/utils/readiness");

test("工作台就绪必须收到当前回环端口的官方认证 URL", () => {
  assert.equal(isKernelActivationUrl(null, 3080), false);
  assert.equal(isKernelActivationUrl("http://127.0.0.1:3080/", 3080), true);
  assert.equal(isKernelActivationUrl("http://127.0.0.1:3080/?token=abc", 3080), true);
  assert.equal(isKernelActivationUrl("http://127.0.0.1:3081/", 3080), false);
  assert.equal(isKernelActivationUrl("https://example.com:3080/", 3080), false);
  assert.equal(isKernelActivationUrl("not-a-url", 3080), false);
});

test("extractBrowserSessionSecret 能准确从 YAML 凭据中解析持久化密钥", () => {
  const sampleYaml = `
version: 1
refs: { DEEPSEEK_API_KEY: "[managed-by-desktop]" }
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: yZsBvtkNsSzOm6o6wGxLU0crQw-bssz5YQewpEI562w
  deepseek-account-platform/device:
    kind: grant
`;
  const secret = extractBrowserSessionSecret(sampleYaml);
  assert.equal(secret, "yZsBvtkNsSzOm6o6wGxLU0crQw-bssz5YQewpEI562w");

  assert.equal(extractBrowserSessionSecret(""), null);
  assert.equal(extractBrowserSessionSecret(null), null);
  assert.equal(extractBrowserSessionSecret("records: {}"), null);
});

test("mintKernelAuthCookie 正确生成官方格式签名 Cookie", () => {
  const sampleYaml = `
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: yZsBvtkNsSzOm6o6wGxLU0crQw-bssz5YQewpEI562w
`;
  const cookie = mintKernelAuthCookie(3080, { yamlContent: sampleYaml });
  assert.ok(cookie);
  assert.ok(cookie.name.startsWith("dsh-auth-"));
  assert.ok(cookie.value.startsWith("v1."));
  assert.equal(cookie.authority, "127.0.0.1:3080");
  assert.equal(cookie.url, "http://127.0.0.1:3080");
  assert.ok(cookie.expiresAt > Date.now());

  // 异常端口与无效密钥防御
  assert.equal(mintKernelAuthCookie(-1, { yamlContent: sampleYaml }), null);
  assert.equal(mintKernelAuthCookie("invalid", { yamlContent: sampleYaml }), null);
  assert.equal(mintKernelAuthCookie(3080, { yamlContent: "no-secret" }), null);
});

test("verifyKernelHttpReady 正确识别 DSH 微内核 HTTP 响应特征", async () => {
  // 创建一个测试专用模拟内核服务器
  const mockServer = http.createServer((req, res) => {
    if (req.headers.cookie && req.headers.cookie.includes("dsh-auth-")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body>DeepSeek Harness</body></html>");
    } else {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
    }
  });

  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const testPort = mockServer.address().port;

  try {
    const sampleYaml = `
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: yZsBvtkNsSzOm6o6wGxLU0crQw-bssz5YQewpEI562w
`;
    // 携带有效 Cookie 握手应为 true
    const readyWithCookie = await verifyKernelHttpReady(testPort, { yamlContent: sampleYaml });
    assert.equal(readyWithCookie, true);

    // 未携带 Cookie 但返回 401 包含官方签名特征亦判定微内核已就绪
    const readyWithoutCookie = await verifyKernelHttpReady(testPort, { yamlContent: "" });
    assert.equal(readyWithoutCookie, true);

    // 非法端口防御
    assert.equal(await verifyKernelHttpReady(-1), false);
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }

  // 严禁误判：普通第三方 Web 服务即便返回 HTTP 200 也必须拒绝 (R1-1 防端口劫持)
  const genericServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body>Welcome to generic redshift dashboard server!</body></html>");
  });
  await new Promise((resolve) => genericServer.listen(0, "127.0.0.1", resolve));
  const genericPort = genericServer.address().port;
  try {
    const isGenericReady = await verifyKernelHttpReady(genericPort);
    assert.equal(isGenericReady, false, "redshift dashboard 绝不能被误判为 DSH 内核");
  } finally {
    await new Promise((resolve) => genericServer.close(resolve));
  }

  // 防挂死断言：分段大响应触发 res.destroy() 必须在 close 事件中迅速 settle，绝不超时
  const chunkedBigServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.write("<!doctype html><html><head><title>DeepSeek Harness Workbench</title></head><body>");
    // 发送超过 500 字节的数据块
    res.write("A".repeat(800));
    setTimeout(() => {
      try { res.end("</body></html>"); } catch (_e) {}
    }, 1000);
  });
  await new Promise((resolve) => chunkedBigServer.listen(0, "127.0.0.1", resolve));
  const chunkedPort = chunkedBigServer.address().port;
  try {
    const startMs = Date.now();
    const isChunkedReady = await verifyKernelHttpReady(chunkedPort, { timeoutMs: 2000 });
    const elapsedMs = Date.now() - startMs;
    assert.equal(isChunkedReady, true);
    assert.ok(elapsedMs < 500, `探测应该在 close 时即刻 settle，实耗 ${elapsedMs}ms`);
  } finally {
    await new Promise((resolve) => chunkedBigServer.close(resolve));
  }

  // 区分认证就绪：未认证 401 在 requireAuthenticated 模式下必须返回 false
  const unauthServer = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
  });
  await new Promise((resolve) => unauthServer.listen(0, "127.0.0.1", resolve));
  const unauthPort = unauthServer.address().port;
  try {
    const asWorkbench = await verifyKernelHttpReady(unauthPort, { requireAuthenticated: true });
    assert.equal(asWorkbench, false, "401 页面不能被误判为可直接工作的有效工作台");
    const asProcessAlive = await verifyKernelHttpReady(unauthPort, { requireAuthenticated: false });
    assert.equal(asProcessAlive, true, "401 页面可证明官方微内核进程存活");
  } finally {
    await new Promise((resolve) => unauthServer.close(resolve));
  }
});

