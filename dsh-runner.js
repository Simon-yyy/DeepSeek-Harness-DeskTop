/**
 * DSH Desktop - In-Process Utility Runner
 * Runs inside Electron utilityProcess to host DeepSeek Harness Web Kernel natively.
 */

const path = require("node:path");
const fs = require("node:fs");

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

function readPackageVersion(binPath) {
  if (!binPath || !fs.existsSync(binPath)) return null;
  try {
    let dir = path.dirname(binPath);
    for (let i = 0; i < 4; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "@deepseek-ai/dsh" && pkg.version) {
          return pkg.version;
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
    return process.env.DSH_BIN;
  }
  const globalCandidates = [
    path.join("D:\\hclaw\\node", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(__dirname, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
  ].filter(Boolean);

  const selectBest = (candidates) => {
    let best = null;
    let bestVer = null;
    let bestTime = 0;
    for (const c of candidates) {
      if (!c || !fs.existsSync(c)) continue;
      try {
        const ver = readPackageVersion(c);
        const st = fs.statSync(c);
        if (!best) {
          best = c;
          bestVer = ver;
          bestTime = st.mtimeMs;
          continue;
        }
        if (ver && bestVer) {
          const cmp = compareVersions(ver, bestVer);
          if (cmp > 0) {
            best = c;
            bestVer = ver;
            bestTime = st.mtimeMs;
          } else if (cmp === 0 && st.mtimeMs > bestTime) {
            best = c;
            bestTime = st.mtimeMs;
          }
        } else if (ver && !bestVer) {
          best = c;
          bestVer = ver;
          bestTime = st.mtimeMs;
        } else if (!ver && !bestVer && st.mtimeMs > bestTime) {
          best = c;
          bestTime = st.mtimeMs;
        }
      } catch { /* ignore */ }
    }
    return { best, bestVer, bestTime };
  };

  const globalResult = selectBest(globalCandidates);

  const cacheRoots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx") : null,
    process.env.npm_config_cache ? path.join(process.env.npm_config_cache, "_npx") : null,
    path.join(process.env.USERPROFILE || "", ".npm", "_npx"),
  ].filter(Boolean);

  const npxCandidates = [];
  for (const npxRoot of cacheRoots) {
    if (!fs.existsSync(npxRoot)) continue;
    let dirs;
    try { dirs = fs.readdirSync(npxRoot); } catch { continue; }
    for (const dir of dirs) {
      const c = path.join(npxRoot, dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (fs.existsSync(c)) npxCandidates.push(c);
    }
  }

  const npxResult = selectBest(npxCandidates);

  if (globalResult.best && npxResult.best) {
    if (npxResult.bestVer && globalResult.bestVer) {
      const cmp = compareVersions(npxResult.bestVer, globalResult.bestVer);
      if (cmp > 0) return npxResult.best;
      return globalResult.best;
    }
    return globalResult.best;
  }
  if (globalResult.best) return globalResult.best;
  if (npxResult.best) return npxResult.best;
  return null;
}

async function boot() {
  // Ensure Node directory is in PATH
  const nodeRoots = ['D:\\hclaw\\node', process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null].filter(Boolean);
  for (const root of nodeRoots) {
    if (fs.existsSync(root) && !process.env.PATH.includes(root)) {
      process.env.PATH = `${root};${process.env.PATH}`;
    }
  }

  const dshBin = resolveDshBin();
  if (!dshBin) {
    console.error("[dsh-runner] Failed to locate @deepseek-ai/dsh bin.js");
    process.exit(1);
  }

  // Set up process argv to simulate `dsh web --no-open`
  process.argv = [process.execPath, dshBin, "web", "--no-open"];

  // Ensure Node environment paths are available
  if (!process.env.DSH_HOME) {
    process.env.DSH_HOME = path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  }

  console.info(`[dsh-runner] Booting DSH Kernel from: ${dshBin}`);

  try {
    // 注入通用第三方 AI 渠道与反代防 WAF 拦截指纹兜底
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === "function") {
      globalThis.fetch = function (resource, options = {}) {
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

          // 统一赋予高兼容度白名单 Client 指纹，拦截 deepseek-harness、node-fetch、undici、@deepseek-ai 等特征
          const currentUa = headers.get("User-Agent") || headers.get("user-agent") || "";
          if (
            !currentUa ||
            currentUa.includes("deepseek-harness") ||
            currentUa.includes("@deepseek-ai") ||
            currentUa.includes("node-fetch") ||
            currentUa.includes("undici")
          ) {
            headers.set("User-Agent", "claude-cli/2.1.119 (external, cli)");
          }
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
