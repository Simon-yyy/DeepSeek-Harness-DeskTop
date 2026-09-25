/**
 * DSH Desktop - Global Network Compatibility Shim
 * 预加载网络拦截补丁：统一为发往第三方 AI 服务商的请求注入白名单客户端指纹
 */
(() => {
  const TARGET_UA = "cline/3.0.0";

  // 护栏零：孤儿进程免疫看门狗 (P1-3)
  // 当以受管子进程方式由 Electron 拉起时，监听 stdin 管道状态。
  // 若主进程发生 crash、被杀死或退出，操作系统管道立即断开，本子进程秒级自毁，杜绝孤儿残留占用端口。
  // 同时具备脱壳防误杀护栏：若由插件市场 (dshmarket) 等第三方后台脱壳重启，双重校验主进程 PID，绝不误杀。
  function isProcessAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  }

  if (process.env.DSH_DESKTOP_MANAGED === "1" && process.stdin && typeof process.stdin.on === "function") {
    try {
      const mainPid = process.env.DSH_DESKTOP_MAIN_PID;
      let hasReceivedData = false;

      const handlePotentialOrphan = () => {
        if (mainPid) {
          // 仅当指定的桌面主进程真正死亡时，才执行自毁退出！
          if (!isProcessAlive(mainPid)) {
            process.exit(0);
          }
          // 若宿主进程仍然存活（如 dshmarket 等插件在后台脱壳无管道启动），绝对不自杀
        } else if (hasReceivedData) {
          // 若未声明 mainPid 但此前建立过真实数据通信流，管道断开说明父进程退出
          process.exit(0);
        }
      };

      process.stdin.resume();
      process.stdin.on("data", () => {
        hasReceivedData = true;
      });
      process.stdin.on("end", handlePotentialOrphan);
      process.stdin.on("close", handlePotentialOrphan);
    } catch (_e) {}
  }

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
      // 兼容 Request 实例：合并原 Request 标头与 options 标头（确保 Authorization 与 UA 绝不丢失） (5.1.4)
      if (typeof Request !== "undefined" && resource instanceof Request) {
        const mergedHeaders = new Headers(resource.headers);
        if (options && options.headers) {
          const extraHeaders = new Headers(options.headers);
          for (const [key, val] of extraHeaders.entries()) {
            mergedHeaders.set(key, val);
          }
        }
        const currentUa = mergedHeaders.get("User-Agent") || mergedHeaders.get("user-agent") || "";
        if (shouldOverrideUa(resource.url, currentUa)) {
          mergedHeaders.set("User-Agent", TARGET_UA);
        }
        const mergedOptions = { ...options, headers: mergedHeaders };
        return origFetch(new Request(resource, mergedOptions));
      }

      const urlStr = typeof resource === "string" ? resource : (resource && resource.url) || "";
      const opt = { ...options };
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

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      TARGET_UA,
      shouldOverrideUa,
    };
  }
})();
