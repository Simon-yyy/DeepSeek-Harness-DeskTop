/**
 * DSH Desktop - Global Network Compatibility Shim
 * 预加载网络拦截补丁：统一为发往第三方 AI 服务商的请求注入白名单客户端指纹
 */
(() => {
  const TARGET_UA = "cline/3.0.0";

  function shouldOverrideUa(urlStr, currentUa) {
    if (!urlStr) return false;

    // 护栏一：严禁拦截本地回环与公共基础设施（NPM、GitHub、DeepSeek 官方）
    const lowerUrl = urlStr.toLowerCase();
    if (
      lowerUrl.includes("127.0.0.1") ||
      lowerUrl.includes("localhost") ||
      lowerUrl.includes("api.deepseek.com") ||
      lowerUrl.includes("registry.npmjs") ||
      lowerUrl.includes("npmmirror.com") ||
      lowerUrl.includes("github.com") ||
      lowerUrl.includes("githubusercontent.com")
    ) {
      return false;
    }

    // 护栏二：仅针对大模型推理与对话端点（/v1/, /chat/, /models, /messages 等）
    const isAiEndpoint =
      lowerUrl.includes("/v1") ||
      lowerUrl.includes("/chat") ||
      lowerUrl.includes("/models") ||
      lowerUrl.includes("/messages");
    if (!isAiEndpoint) return false;

    // 护栏三：补齐 OpenAI SDK、DSH 内核客户端及底层网络库标识
    const ua = (currentUa || "").toLowerCase();
    return (
      !ua ||
      ua.includes("openai") ||
      ua.includes("deepseek-harness") ||
      ua.includes("@deepseek-ai") ||
      ua.includes("node-fetch") ||
      ua.includes("undici")
    );
  }

  // 1. 劫持 globalThis.fetch
  if (typeof globalThis.fetch === "function") {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function (resource, options = {}) {
      // 兼容 Request 实例：继承已有 headers（包括 Authorization / Content-Type 等），避免覆盖丢失认证凭据
      if (typeof Request !== "undefined" && resource instanceof Request) {
        const headers = new Headers(resource.headers);
        const currentUa = headers.get("User-Agent") || headers.get("user-agent") || "";
        if (shouldOverrideUa(resource.url, currentUa)) {
          headers.set("User-Agent", TARGET_UA);
        }
        const newReq = new Request(resource, { headers });
        return origFetch(newReq, options);
      }

      const urlStr = typeof resource === "string" ? resource : (resource && resource.url) || "";
      const opt = options || {};
      let headers = opt.headers;
      if (!headers) {
        headers = new Headers();
      } else if (!(headers instanceof Headers)) {
        headers = new Headers(headers);
      }

      const currentUa = headers.get("User-Agent") || headers.get("user-agent") || "";
      if (shouldOverrideUa(urlStr, currentUa)) {
        headers.set("User-Agent", TARGET_UA);
      }
      opt.headers = headers;
      return origFetch(resource, opt);
    };
  }

  // 2. 劫持 http 与 https request
  try {
    const http = require("http");
    const https = require("https");
    for (const mod of [http, https]) {
      const origRequest = mod.request;
      mod.request = function (...args) {
        try {
          let urlStr = "";
          let options = {};
          if (typeof args[0] === "string") {
            urlStr = args[0];
            options = args[1] || {};
          } else if (args[0] && typeof args[0] === "object") {
            if (args[0] instanceof URL) {
              urlStr = args[0].href;
            } else {
              const proto = mod === https ? "https:" : "http:";
              const host = args[0].host || args[0].hostname || "localhost";
              const path = args[0].path || "/";
              urlStr = `${proto}//${host}${path}`;
            }
            options = typeof args[1] === "object" ? args[1] : args[0];
          }

          if (options && options.headers) {
            let foundUaKey = Object.keys(options.headers).find((k) => k.toLowerCase() === "user-agent");
            let currentUa = foundUaKey ? options.headers[foundUaKey] : "";
            if (shouldOverrideUa(urlStr, currentUa)) {
              if (foundUaKey) delete options.headers[foundUaKey];
              options.headers["User-Agent"] = TARGET_UA;
            }
          } else if (options) {
            if (shouldOverrideUa(urlStr, "")) {
              options.headers = { "User-Agent": TARGET_UA };
            }
          }
        } catch {}
        return origRequest.apply(this, args);
      };
    }
  } catch {}
})();
