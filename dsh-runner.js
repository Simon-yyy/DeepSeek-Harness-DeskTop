/**
 * DSH Desktop - In-Process Utility Runner
 * Runs inside Electron utilityProcess to host DeepSeek Harness Web Kernel natively.
 */

const path = require("node:path");
const fs = require("node:fs");
const { resolveDshKernel, resolveNode } = require("./src/main/utils/kernel");

async function boot() {
  // Ensure Node directory is in PATH
  const resolvedNode = resolveNode();
  const nodeRoots = [
    resolvedNode ? path.dirname(resolvedNode) : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : null,
  ].filter((root, index, roots) => root && roots.indexOf(root) === index);

  for (const root of nodeRoots) {
    if (fs.existsSync(root) && !process.env.PATH.includes(root)) {
      process.env.PATH = `${root};${process.env.PATH}`;
    }
  }

  const kernelInfo = resolveDshKernel({
    appRoot: __dirname,
    resourcesPath: process.resourcesPath,
  });

  const dshBin = kernelInfo.path;
  if (!dshBin) {
    console.error("[dsh-runner] Failed to locate @deepseek-ai/dsh bin.js");
    process.exit(1);
  }

  console.info(`[dsh-runner] Booting DSH Kernel v${kernelInfo.version || "unknown"} (source: ${kernelInfo.source}) from: ${dshBin}`);

  // Set up process argv to simulate `dsh web --no-open --host 127.0.0.1 --port <port>`
  const runnerPort = process.env.PORT || process.env.DSH_PORT;
  const portArgs = runnerPort ? ["--host", "127.0.0.1", "--port", String(runnerPort)] : ["--host", "127.0.0.1"];
  process.argv = [process.execPath, dshBin, "web", "--no-open", ...portArgs];

  // Ensure Node environment paths are available
  if (!process.env.DSH_HOME) {
    process.env.DSH_HOME = path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  }

  console.info(`[dsh-runner] Booting DSH Kernel on port ${runnerPort || "default"} from: ${dshBin}`);

  try {
    // 注入通用第三方 AI 渠道与反代防 WAF 拦截指纹兜底 (对齐 cline/3.0.0 与标头保护)
    const TARGET_UA = "cline/3.0.0";
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === "function") {
      globalThis.fetch = function (resource, options = {}) {
        if (typeof Request !== "undefined" && resource instanceof Request) {
          const headers = new Headers(resource.headers);
          const currentUa = headers.get("User-Agent") || headers.get("user-agent") || "";
          const urlStr = resource.url || "";
          const isLoopback = urlStr.includes("127.0.0.1") || urlStr.includes("localhost");
          const isOfficial = urlStr.includes("api.deepseek.com") || urlStr.includes("registry.npm");
          if (!isLoopback && !isOfficial && (urlStr.includes("/v1") || urlStr.includes("/chat") || urlStr.includes("/models") || urlStr.includes("/messages"))) {
            headers.set("User-Agent", TARGET_UA);
          }
          const newReq = new Request(resource, { headers });
          return originalFetch(newReq, options);
        }

        const urlStr = typeof resource === "string" ? resource : (resource && resource.url) || "";
        const isLoopback = urlStr.includes("127.0.0.1") || urlStr.includes("localhost");
        const isOfficialDeepSeek = urlStr.includes("api.deepseek.com") || urlStr.includes("registry.npm");

        if (!isLoopback && !isOfficialDeepSeek && (urlStr.includes("/v1/") || urlStr.includes("/v1") || urlStr.includes("/chat/") || urlStr.includes("/messages") || urlStr.includes("/models"))) {
          const opt = options || {};
          let headers = opt.headers;
          if (!headers) {
            headers = new Headers();
          } else if (!(headers instanceof Headers)) {
            headers = new Headers(headers);
          }

          headers.set("User-Agent", TARGET_UA);
          opt.headers = headers;
          return originalFetch(resource, opt);
        }
        return originalFetch(resource, options);
      };
    }

    // Dynamic import to execute DSH web profile within this utilityProcess
    const fileUrl = `file:///${dshBin.replace(/\\/g, "/")}`;
    await import(fileUrl);
    console.info("[dsh-runner] DSH Kernel booted successfully");
  } catch (err) {
    console.error("[dsh-runner] DSH Kernel boot exception:", err);
    process.exit(1);
  }
}

// Handle shutdown signal from Electron parent process
if (process.parentPort) {
  process.parentPort.on("message", (e) => {
    if (e.data && e.data.type === "shutdown") {
      console.info("[dsh-runner] Received shutdown signal from parent, exiting cleanly");
      process.exit(0);
    }
  });
}

boot();
