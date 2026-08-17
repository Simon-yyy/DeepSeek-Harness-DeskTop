const { app, BrowserWindow, shell, dialog, nativeImage, ipcMain, Tray, Menu, globalShortcut, utilityProcess, session } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

// Set AppUserModelId so Windows Taskbar binds correctly to the desktop shortcut & icon
app.setAppUserModelId("com.dsh.desktop");

// ---------------------------------------------------------------------------
// Global Error Boundary: Prevent silent crashes & display actionable dialog
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error("[dsh-desktop] Uncaught Exception:", err);
  try {
    dialog.showErrorBox(
      "DSH Desktop 运行异常",
      `应用程序遇到未捕获的错误:\n${err.message || String(err)}\n\n堆栈信息:\n${(err.stack || "").slice(0, 500)}`
    );
  } catch {}
});

process.on("unhandledRejection", (reason) => {
  console.error("[dsh-desktop] Unhandled Rejection:", reason);
});


// ---------------------------------------------------------------------------
// Single Instance Lock: prevent duplicate apps, focus existing on reopen
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Handle image paste: save to local temp file with strict extension whitelist
ipcMain.handle("save-paste-image", async (_event, { buffer, ext }) => {
  const allowedExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
  const safeExt = allowedExts.includes((ext || "").toLowerCase()) ? (ext || "").toLowerCase() : ".png";
  const tempDir = app.getPath("temp");
  const filename = `dsh-modlens-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`;
  const filePath = path.join(tempDir, filename);
  await fs.promises.writeFile(filePath, Buffer.from(buffer));
  console.log(`[dsh-desktop] Saved pasted image to ${filePath}`);
  return filePath;
});

const WEB_PORT = 3080;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const STARTUP_TIMEOUT_MS = 90_000;
const REPO_OWNER = "Simon-yyy";
const REPO_NAME = "DeepSeek-Harness-DeskTop";

// ---------------------------------------------------------------------------
// Auto-Updater: Check GitHub Releases for newer version
// ---------------------------------------------------------------------------
function checkForUpdates(silent = true) {
  const options = {
    hostname: "api.github.com",
    path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    method: "GET",
    headers: {
      "User-Agent": "DSH-Desktop-App",
      "Accept": "application/vnd.github.v3+json",
    },
    timeout: 5000,
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      try {
        if (res.statusCode !== 200) {
          if (!silent) dialog.showMessageBox(mainWindow || null, { type: "info", title: "检查更新", message: "未能连接到 GitHub 更新服务器，请稍后重试。" });
          return;
        }
        const release = JSON.parse(data);
        const latestTag = (release.tag_name || "").replace(/^v/, "");
        const currentVer = app.getVersion();

        if (latestTag && compareVersions(latestTag, currentVer) > 0) {
          dialog.showMessageBox(mainWindow || null, {
            type: "info",
            title: "🎉 发现 DSH Desktop 新版本",
            message: `发现全新版本 v${latestTag}（当前版本 v${currentVer}）！\n\n更新日志：\n${release.body ? release.body.slice(0, 300) : "性能与稳定性改进"}\n\n是否立即前往下载最新安装包？`,
            buttons: ["立即前往下载", "稍后提醒"],
            defaultId: 0,
            cancelId: 1,
          }).then(({ response }) => {
            if (response === 0) {
              shell.openExternal(release.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
            }
          });
        } else if (!silent) {
          dialog.showMessageBox(mainWindow || null, {
            type: "info",
            title: "检查更新",
            message: `当前已是最新版本 (v${currentVer})！无需更新。`,
          });
        }
      } catch (err) {
        if (!silent) dialog.showMessageBox(mainWindow || null, { type: "error", title: "检查更新", message: `解析更新数据失败: ${err.message}` });
      }
    });
  });

  req.on("error", (err) => {
    if (!silent) dialog.showMessageBox(mainWindow || null, { type: "warning", title: "检查更新", message: `检查更新失败: ${err.message}` });
  });
  req.on("timeout", () => { req.destroy(); });
  req.end();
}

function compareVersions(v1, v2) {
  const p1 = v1.split(".").map(Number);
  const p2 = v2.split(".").map(Number);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Toolchain resolution (all resolved once at startup)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Ensure Node.js binary directory is in PATH for all subprocesses & DSH Kernel
// ---------------------------------------------------------------------------
function ensureNodeInPath() {
  const nodeBin = resolveNode();
  if (nodeBin && fs.existsSync(nodeBin)) {
    const nodeDir = path.dirname(nodeBin);
    if (!process.env.PATH.includes(nodeDir)) {
      process.env.PATH = `${nodeDir};${process.env.PATH}`;
      console.log(`[dsh-desktop] Prepend ${nodeDir} to PATH`);
    }
  }
}
function resolveNode() {
  if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE;
  const roots = [
    "D:\\hclaw\\node",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "nodejs") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "nvm") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "fnm_multishells") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Volta", "bin") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "scoop", "apps", "nodejs", "current") : null,
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, "node.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = spawnSync("where", ["node"], { encoding: "utf8", shell: true, windowsHide: true });
  if (which.status === 0 && which.stdout.trim()) {
    const hit = which.stdout.trim().split(/\r?\n/).find((line) => /\.exe$/i.test(line));
    if (hit) return hit;
  }
  return process.execPath;
}

function resolveDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
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
        if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = candidate; }
      } catch { /* ignore */ }
    }
  }
  if (best) return best;
  const which = spawnSync("where", ["dsh"], { encoding: "utf8", shell: true, windowsHide: true });
  if (which.status === 0 && which.stdout.trim()) {
    const hit = which.stdout.trim().split(/\r?\n/).find((line) => /dsh\.cmd$/i.test(line));
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
let backendProc = null;
let backendSpawnedByUs = false;

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

function httpReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitForWeb(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpReady(WEB_PORT)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function spawnBackend() {
  const runnerPath = path.join(__dirname, "dsh-runner.js");
  const cwd = process.env.DSH_WORKSPACE || app.getPath("home");
  ensureNodeInPath();
  const env = { ...process.env };
  if (process.env.DSH_HOME) env.DSH_HOME = process.env.DSH_HOME;

  let child;
  // 路线 1：首选 Electron 原生 utilityProcess 内置直启（强生命周期绑定、0 孤儿进程）
  if (utilityProcess && fs.existsSync(runnerPath)) {
    console.log("[dsh-desktop] Spawning backend natively via Electron utilityProcess.fork");
    child = utilityProcess.fork(runnerPath, [], {
      cwd,
      env,
      stdio: "pipe",
      serviceName: "dsh-web-kernel",
    });

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        const str = data.toString().trim();
        if (str) console.log("[DSH Kernel]", str);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (data) => {
        const str = data.toString().trim();
        if (str) console.warn("[DSH Kernel Error]", str);
      });
    }
  } else {
    // 降级兜底：传统外部 Node.js / npx 启动
    const nodeBin = resolveNode();
    const dshBin = resolveDshBin();
    if (dshBin && /\.cmd$/i.test(dshBin)) {
      child = spawn(dshBin, ["--profile", "web"], { cwd, env, stdio: "ignore", windowsHide: true, shell: true });
    } else if (dshBin) {
      const runEnv = { ...env };
      if (path.resolve(nodeBin) === path.resolve(process.execPath)) runEnv.ELECTRON_RUN_AS_NODE = "1";
      child = spawn(nodeBin, [dshBin, "--profile", "web"], {
        cwd,
        env: runEnv,
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child = spawn("npx", ["-y", "@deepseek-ai/dsh", "--profile", "web"], { cwd, env, stdio: "ignore", windowsHide: true, shell: true });
    }
  }

  backendSpawnedByUs = true;
  backendProc = child;
  child.on("exit", () => { backendProc = null; });
  return child;
}

function stopBackendIfOurs() {
  if (backendSpawnedByUs && backendProc) {
    try {
      if (typeof backendProc.postMessage === "function") {
        // utilityProcess: 发送优雅退出信号并销毁
        backendProc.postMessage({ type: "shutdown" });
        backendProc.kill();
      } else {
        // 外部 spawn 进程：Windows 强制杀进程树
        const pid = backendProc.pid;
        if (process.platform === "win32" && pid) {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        } else if (!backendProc.killed) {
          backendProc.kill("SIGKILL");
        }
      }
    } catch { /* ignore */ }
  }
  backendProc = null;
  backendSpawnedByUs = false;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Auto-initialize 35 bundled skills into user's ~/.dsh/skills on first run
// ---------------------------------------------------------------------------
function ensureBundledSkills() {
  try {
    const userDshSkills = path.join(app.getPath("home"), ".dsh", "skills");
    const bundledSkills = path.join(__dirname, "bundled-skills");
    if (fs.existsSync(bundledSkills)) {
      if (!fs.existsSync(userDshSkills)) {
        fs.mkdirSync(userDshSkills, { recursive: true });
      }
      const entries = fs.readdirSync(bundledSkills);
      for (const entry of entries) {
        const src = path.join(bundledSkills, entry);
        const target = path.join(userDshSkills, entry);
        if (!fs.existsSync(target)) {
          fs.cpSync(src, target, { recursive: true });
        }
      }
      console.log("[dsh-desktop] Bundled skills checked and initialized.");
    }
  } catch (err) {
    console.warn("[dsh-desktop] ensureBundledSkills warning:", err.message);
  }
}

// Window & System Tray
// ---------------------------------------------------------------------------
function getAppIcon() {
  const iconCandidate = fs.existsSync(path.join(__dirname, "build", "icon.ico"))
    ? path.join(__dirname, "build", "icon.ico")
    : path.join(__dirname, "icon.ico");
  return nativeImage.createFromPath(iconCandidate);
}

function createTray(appIcon) {
  if (tray) return;
  try {
    tray = new Tray(appIcon);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "显示 DSH Desktop",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      {
        label: "新建会话",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.loadURL(WEB_URL);

  // 插件加载临时竞争态自愈重试
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (document.body && document.body.innerText && document.body.innerText.includes("Failed to load plugins")) {
          setTimeout(function() { window.location.reload(); }, 600);
        }
      })()
    `).catch(() => {});
  });
          }
        },
      },
      {
        label: "🔍 检查更新...",
        click: () => {
          checkForUpdates(false);
        },
      },
      { type: "separator" },
      {
        label: "退出应用",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setToolTip(`DSH Desktop v${app.getVersion()}`);
    tray.setContextMenu(contextMenu);
    tray.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  } catch (err) {
    console.warn("Tray creation failed:", err.message);
  }
}

function createWindow() {
  const appIcon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "DSH Desktop",
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
    },
  });

  mainWindow.setIcon(appIcon);

  // Prevent web backend from changing the desktop window title
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  // Prevent web backend favicon from overriding our desktop icon
  mainWindow.webContents.on("page-favicon-updated", (event) => {
    event.preventDefault();
  });

  // Keyboard shortcuts: Zoom (Ctrl + / - / 0) & Reload (F5, Ctrl + R)
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F5") {
      mainWindow.reload();
      event.preventDefault();
      return;
    }
    if (input.control || input.meta) {
      if (input.key.toLowerCase() === "r") {
        if (input.shift) mainWindow.webContents.reloadIgnoringCache();
        else mainWindow.reload();
        event.preventDefault();
        return;
      }
      if (input.key === "=" || input.key === "+") {
        const currentZoom = mainWindow.webContents.getZoomFactor();
        mainWindow.webContents.setZoomFactor(Math.min(currentZoom + 0.1, 2.0));
        event.preventDefault();
      } else if (input.key === "-") {
        const currentZoom = mainWindow.webContents.getZoomFactor();
        mainWindow.webContents.setZoomFactor(Math.max(currentZoom - 0.1, 0.5));
        event.preventDefault();
      } else if (input.key === "0") {
        mainWindow.webContents.setZoomFactor(1.0);
        event.preventDefault();
      }
    }
  });

  mainWindow.loadURL(WEB_URL);

  // Auto check for updates on startup (silently in background after 5s)
  setTimeout(() => {
    checkForUpdates(true);
  }, 5000);

  // Test hook: DSH_DESKTOP_TEST=1
  if (process.env.DSH_DESKTOP_TEST === "1") {
    const logPath = process.env.DSH_DESKTOP_TEST_LOG || path.join(app.getPath("temp"), "dsh-desktop-test.log");
    const log = (msg) => { try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } };
    log(`createWindow: loading ${WEB_URL}`);
    mainWindow.webContents.on("did-finish-load", () => {
      log(`did-finish-load: ${mainWindow.webContents.getURL()}`);
      const marker = process.env.DSH_DESKTOP_TEST_MARKER || path.join(app.getPath("temp"), "dsh-desktop-test-ok.txt");
      try { fs.writeFileSync(marker, `loaded ${mainWindow.webContents.getURL()} at ${new Date().toISOString()}`); } catch (e) { log(`marker write error: ${e.message}`); }
      setTimeout(() => { app.quit(); }, 500);
    });
    mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
      log(`did-fail-load: code=${code} desc=${desc}`);
      const marker = process.env.DSH_DESKTOP_TEST_MARKER || path.join(app.getPath("temp"), "dsh-desktop-test-ok.txt");
      try { fs.writeFileSync(marker, `FAIL ${code}: ${desc}`); } catch (e) { log(`marker write error: ${e.message}`); }
      setTimeout(() => { app.quit(); }, 500);
    });
  }

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin === WEB_URL) {
        return { action: "allow" };
      }
    } catch {}
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Create system tray
  createTray(appIcon);

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// App lifecycle & Second Instance handling
// ---------------------------------------------------------------------------
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  ensureBundledSkills();
  // Register global summon shortcut: Ctrl + Shift + D
  try {
    globalShortcut.register("CommandOrControl+Shift+D", () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && mainWindow.isFocused()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  } catch (err) {
    console.warn("Global shortcut register failed:", err.message);
  }

  let started = false;
  if (await portInUse(WEB_PORT)) {
    console.log(`dsh web already running on ${WEB_PORT}, reusing it`);
    started = true;
  } else {
    console.log("spawning dsh web backend...");
    spawnBackend();
    started = await waitForWeb(STARTUP_TIMEOUT_MS);
  }

  if (!started) {
    dialog.showErrorBox(
      "DSH Desktop 启动失败",
      `无法在 ${STARTUP_TIMEOUT_MS / 1000}s 内启动 dsh web 后端（${WEB_URL}）。\n请确保 dsh 已正确安装，或设置 DSH_BIN 环境变量指向 dsh 的 bin.js。`
    );
    app.quit();
    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackendIfOurs();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopBackendIfOurs();
});

app.on("window-all-closed", () => {
  stopBackendIfOurs();
  app.quit();
});

process.on("exit", () => {
  stopBackendIfOurs();
});
