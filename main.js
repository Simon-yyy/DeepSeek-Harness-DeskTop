const { app, BrowserWindow, shell, dialog, nativeImage, ipcMain, Tray, Menu, globalShortcut } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

// Set AppUserModelId so Windows Taskbar binds correctly to the desktop shortcut & icon
app.setAppUserModelId("com.dsh.desktop");

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

// ---------------------------------------------------------------------------
// Toolchain resolution (all resolved once at startup)
// ---------------------------------------------------------------------------
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
  const nodeBin = resolveNode();
  const dshBin = resolveDshBin();
  const cwd = process.env.DSH_WORKSPACE || app.getPath("home");
  const env = { ...process.env };
  if (process.env.DSH_HOME) env.DSH_HOME = process.env.DSH_HOME;

  let child;
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
  backendSpawnedByUs = true;
  backendProc = child;
  child.on("exit", () => { backendProc = null; });
  return child;
}

function stopBackendIfOurs() {
  if (backendSpawnedByUs && backendProc && !backendProc.killed) {
    try { backendProc.kill(); } catch { /* ignore */ }
  }
  backendProc = null;
  backendSpawnedByUs = false;
}

// ---------------------------------------------------------------------------
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
          }
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
    tray.setToolTip("DSH Desktop - DeepSeek Harness");
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

  // Zoom shortcuts (Ctrl + Plus, Ctrl + Minus, Ctrl + 0)
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control || input.meta) {
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

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  stopBackendIfOurs();
  app.quit();
});
