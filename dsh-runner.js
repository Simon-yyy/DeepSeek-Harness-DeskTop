/**
 * DSH Desktop - In-Process Utility Runner
 * Runs inside Electron utilityProcess to host DeepSeek Harness Web Kernel natively.
 */

const path = require("node:path");
const fs = require("node:fs");

function resolveDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
    return process.env.DSH_BIN;
  }
  const cacheRoots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx") : null,
    process.env.npm_config_cache ? path.join(process.env.npm_config_cache, "_npx") : null,
    path.join(process.env.USERPROFILE || "", ".npm", "_npx"),
  ].filter(Boolean);

  let best = null;
  let bestTime = 0;
  for (const npxRoot of cacheRoots) {
    if (!fs.existsSync(npxRoot)) continue;
    let dirs;
    try { dirs = fs.readdirSync(npxRoot); } catch { continue; }
    for (const dir of dirs) {
      const candidate = path.join(npxRoot, dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (!fs.existsSync(candidate)) continue;
      try {
        const st = fs.statSync(candidate);
        if (st.mtimeMs > bestTime) {
          bestTime = st.mtimeMs;
          best = candidate;
        }
      } catch { /* ignore */ }
    }
  }
  return best;
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

  // Set up process argv to simulate `dsh web`
  process.argv = [process.execPath, dshBin, "web"];

  // Ensure Node environment paths are available
  if (!process.env.DSH_HOME) {
    process.env.DSH_HOME = path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  }

  console.log(`[dsh-runner] Booting DSH Kernel from: ${dshBin}`);

  try {
    // Dynamic import to execute DSH web profile within this utilityProcess
    const fileUrl = `file:///${dshBin.replace(/\\/g, "/")}`;
    await import(fileUrl);
    console.log("[dsh-runner] DSH Kernel booted successfully");
  } catch (err) {
    console.error("[dsh-runner] DSH Kernel boot exception:", err);
    process.exit(1);
  }
}

// Handle shutdown signal from Electron parent process
if (process.parentPort) {
  process.parentPort.on("message", (e) => {
    if (e.data && e.data.type === "shutdown") {
      console.log("[dsh-runner] Received shutdown signal from parent, exiting cleanly");
      process.exit(0);
    }
  });
}

boot();
