const test = require("node:test");
const assert = require("node:assert");
const { shouldOverrideUa, TARGET_UA } = require("../network-shim");

test("network-shim TARGET_UA 指纹白名单契约", () => {
  assert.strictEqual(TARGET_UA, "cline/3.0.0");
});

test("shouldOverrideUa 护栏一：本地回环与官方基础设施绝对豁免", () => {
  // 1. 本地回环地址
  assert.strictEqual(shouldOverrideUa("http://127.0.0.1:3080/v1/chat", ""), false);
  assert.strictEqual(shouldOverrideUa("http://localhost:3080/v1/models", ""), false);

  // 2. 官方 DeepSeek API
  assert.strictEqual(shouldOverrideUa("https://api.deepseek.com/v1/chat/completions", ""), false);

  // 3. NPM 镜像与官方源
  assert.strictEqual(shouldOverrideUa("https://registry.npmjs.org/@deepseek-ai/dsh", ""), false);
  assert.strictEqual(shouldOverrideUa("https://registry.npmmirror.com/@deepseek-ai/dsh", ""), false);

  // 4. GitHub 基础设施
  assert.strictEqual(shouldOverrideUa("https://github.com/deepseek-ai/deepseek-harness", ""), false);
  assert.strictEqual(shouldOverrideUa("https://raw.githubusercontent.com/deepseek-ai/repo", ""), false);
});

test("shouldOverrideUa 护栏二：仅针对大模型推理与对话端点", () => {
  // 非 AI 端点应放行
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/healthz", ""), false);
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v2/users", ""), false);
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/billing", ""), false);

  // 大模型端点应命中
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v1/chat/completions", "openai-node/4.0.0"), true);
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/chat/completions", ""), true);
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v1/models", "undici"), true);
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v1/messages", "deepseek-harness/0.1.5"), true);
});

test("shouldOverrideUa 护栏三：UA 识别与自定义客户端保护", () => {
  // 空 UA 或标准库 UA 应覆盖
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v1/chat", ""), true);
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v1/chat", "node-fetch/1.0"), true);
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v1/chat", "@deepseek-ai/dsh"), true);

  // 已经带有 cline 或第三方自定义特殊 UA 则不覆盖
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v1/chat", "cline/3.0.0"), false);
  assert.strictEqual(shouldOverrideUa("https://api.thirdparty.com/v1/chat", "MyCustomAgent/1.0"), false);
});

test("fetch Request 实例标头继承与 Authorization 保护 (DSH-NetworkShim-Request-Headers)", async () => {
  if (typeof Request === "undefined" || typeof Headers === "undefined") {
    return; // Node 环境若无全局 Web Request 则跳过
  }

  const req = new Request("https://api.thirdparty.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer sk-test-token-123456",
      "Content-Type": "application/json",
      "User-Agent": "openai-node/4.0.0",
    },
    body: JSON.stringify({ model: "test" }),
  });

  // 模拟拦截逻辑
  const headers = new Headers(req.headers);
  const currentUa = headers.get("User-Agent") || "";
  if (shouldOverrideUa(req.url, currentUa)) {
    headers.set("User-Agent", TARGET_UA);
  }
  const interceptedReq = new Request(req, { headers });

  // 断言：UA 成功替换为白名单指纹
  assert.strictEqual(interceptedReq.headers.get("User-Agent"), TARGET_UA);
  // 断言：Authorization 凭据绝对不得丢失！
  assert.strictEqual(interceptedReq.headers.get("Authorization"), "Bearer sk-test-token-123456");
  assert.strictEqual(interceptedReq.headers.get("Content-Type"), "application/json");
});

test("fetch 真实包装器：当同时传入 Request 实例与 options.headers 时无损合并 (5.1.4)", async () => {
  if (typeof Request === "undefined" || typeof Headers === "undefined") {
    return;
  }

  // 模拟挂载底层 fetch 监控器
  let capturedHeaders = null;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (reqOrUrl, opts) => {
      if (reqOrUrl instanceof Request) {
        capturedHeaders = reqOrUrl.headers;
      } else if (opts && opts.headers) {
        capturedHeaders = new Headers(opts.headers);
      }
      return { ok: true, status: 200 };
    };

    // 重新触发 network-shim 的劫持挂载
    delete require.cache[require.resolve("../network-shim")];
    require("../network-shim");

    // 构造原 Request：带有 Authorization
    const baseReq = new Request("https://api.thirdparty.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer sk-secret-token",
        "Content-Type": "application/json",
      },
    });

    // 调用被垫片包装的 fetch，并附带额外的 options.headers
    await globalThis.fetch(baseReq, {
      headers: {
        "X-Custom-Trace": "trace-999",
      },
    });

    assert.ok(capturedHeaders !== null);
    // 1. 原 Request 中的 Authorization 必须完好保留
    assert.strictEqual(capturedHeaders.get("Authorization"), "Bearer sk-secret-token");
    // 2. options 中的额外 Header 必须合并注入
    assert.strictEqual(capturedHeaders.get("X-Custom-Trace"), "trace-999");
    // 3. 原 Request 的 Content-Type 必须完好保留
    assert.strictEqual(capturedHeaders.get("Content-Type"), "application/json");
    // 4. 且 User-Agent 必须由垫片安全重写为 cline/3.0.0
    assert.strictEqual(capturedHeaders.get("User-Agent"), TARGET_UA);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("network-shim 孤儿看门狗脱壳防误杀护栏：宿主进程活着时即便 stdin EOF 也不自杀", () => {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const code = `
    process.env.DSH_DESKTOP_MANAGED = "1";
    process.env.DSH_DESKTOP_MAIN_PID = "${process.pid}";
    require("./network-shim.js");
    process.stdin.emit("end");
    process.stdin.emit("close");
    setTimeout(() => {
      console.log("ALIVE");
      process.exit(0);
    }, 50);
  `;
  const res = spawnSync(process.execPath, ["-e", code], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "pipe",
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes("ALIVE"), "宿主存活时不得被看门狗误杀");
});

test("network-shim 孤儿看门狗正常工作：宿主进程已死亡时触发自毁", () => {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const code = `
    process.env.DSH_DESKTOP_MANAGED = "1";
    process.env.DSH_DESKTOP_MAIN_PID = "99999999";
    require("./network-shim.js");
    process.stdin.emit("end");
    setTimeout(() => {
      console.log("FAILED");
      process.exit(1);
    }, 50);
  `;
  const res = spawnSync(process.execPath, ["-e", code], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "pipe",
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.includes("FAILED"), false, "宿主死亡时必须正常自毁退出");
});


