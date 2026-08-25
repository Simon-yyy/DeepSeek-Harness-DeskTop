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
// Auto-Updater: In-App Download, Auto-Install & GitHub Release Sync
// ---------------------------------------------------------------------------
let isDownloadingUpdate = false;

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "User-Agent": "DSH-Desktop-App",
      },
    };

    https.get(options, (res) => {
      // 处理 HTTP 301 / 302 / 307 / 308 重定向 (GitHub Releases -> AWS S3 / CDN)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(downloadFile(res.headers.location, destPath, onProgress));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`下载失败，服务器返回 HTTP ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
      let downloadedBytes = 0;
      const fileStream = fs.createWriteStream(destPath);

      res.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        fileStream.write(chunk);
        if (onProgress && totalBytes > 0) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          onProgress(percent, downloadedBytes, totalBytes);
        }
      });

      res.on("end", () => {
        fileStream.end();
        resolve(destPath);
      });

      res.on("error", (err) => {
        fileStream.destroy();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on("error", reject);
  });
}

function startInAppUpdate(assetUrl, newVersion) {
  if (isDownloadingUpdate) {
    dialog.showMessageBox(mainWindow || null, {
      type: "info",
      title: "正在更新",
      message: "新版本安装包正在后台下载中，请稍候...",
    });
    return;
  }

  isDownloadingUpdate = true;
  const tempDir = app.getPath("temp");
  const installerPath = path.join(tempDir, `DSH-Desktop-Setup-${newVersion}.exe`);

  dialog.showMessageBox(mainWindow || null, {
    type: "info",
    title: "⚡ 开始下载更新",
    message: `已开始下载全新版本 v${newVersion} 安装包。\n下载完成后将自动启动安装并重启应用，请稍候！`,
    buttons: ["知道了"],
  });

  downloadFile(assetUrl, installerPath, (_percent, _downloaded, _total) => {
    // 进度回调
  }).then(() => {
    isDownloadingUpdate = false;
    dialog.showMessageBox(mainWindow || null, {
      type: "info",
      title: "🎉 下载完成",
      message: `v${newVersion} 安装包已下载完成！\n点击确定后应用将自动退出并启动安装升级。`,
      buttons: ["立即安装升级"],
      defaultId: 0,
    }).then(() => {
      try {
        // 启动下载好的 NSIS 安装包覆盖安装
        spawn(installerPath, ["--updated"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        isQuitting = true;
        stopBackendIfOurs();
        app.quit();
      } catch (err) {
        dialog.showErrorBox("启动安装程序失败", `无法自动执行安装包: ${err.message}`);
      }
    });
  }).catch((err) => {
    isDownloadingUpdate = false;
    dialog.showMessageBox(mainWindow || null, {
      type: "error",
      title: "更新下载失败",
      message: `下载更新包遇到错误: ${err.message}\n您可以前往浏览器手动下载。`,
      buttons: ["前往官网下载", "取消"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        shell.openExternal(`https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
      }
    });
  });
}

function checkForUpdates(silent = true) {
  const options = {
    hostname: "api.github.com",
    path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    method: "GET",
    headers: {
      "User-Agent": "DSH-Desktop-App",
      "Accept": "application/vnd.github.v3+json",
    },
    timeout: 8000,
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
          const exeAsset = (release.assets || []).find((a) => a.name && a.name.endsWith(".exe") && !a.name.includes("blockmap"));

          dialog.showMessageBox(mainWindow || null, {
            type: "info",
            title: `🎉 发现 DSH Desktop 新版本 (v${latestTag})`,
            message: `发现全新版本 v${latestTag}（当前版本 v${currentVer}）！\n\n更新说明：\n${release.body ? release.body.slice(0, 350) : "性能与稳定性改进"}\n\n是否立即在应用内自动下载并安装升级？`,
            buttons: ["🚀 立即下载并安装", "在浏览器中查看", "稍后提醒"],
            defaultId: 0,
            cancelId: 2,
          }).then(({ response }) => {
            if (response === 0) {
              if (exeAsset && exeAsset.browser_download_url) {
                startInAppUpdate(exeAsset.browser_download_url, latestTag);
              } else {
                shell.openExternal(release.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
              }
            } else if (response === 1) {
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

  // 没有 pre 标识的为正式版，正式版高于预发布版 (如 0.1.1 > 0.1.1-rc.2)
  if (!pre1 && pre2) return 1;
  if (pre1 && !pre2) return -1;
  if (pre1 && pre2) {
    return pre1.localeCompare(pre2, undefined, { numeric: true, sensitivity: "base" });
  }
  return 0;
}

// ---------------------------------------------------------------------------
// DSH Official Kernel Version Check & In-App Upgrade
// ---------------------------------------------------------------------------
let isUpdatingKernel = false;

function getLocalKernelVersion() {
  try {
    const dshBin = resolveDshBin();
    if (dshBin && fs.existsSync(dshBin)) {
      let dir = path.dirname(dshBin);
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
    }
  } catch (err) {
    console.warn("[dsh-desktop] Failed to read local kernel version:", err.message);
  }
  return "0.1.0-rc.8";
}

function fetchLatestKernelVersion() {
  return new Promise((resolve, reject) => {
    const fetchFromUrl = (targetUrl) => {
      return new Promise((res, rej) => {
        const parsed = new URL(targetUrl);
        const req = https.get(
          {
            hostname: parsed.hostname,
            path: parsed.pathname,
            headers: { "User-Agent": "DSH-Desktop-App" },
            timeout: 6000,
          },
          (response) => {
            if (response.statusCode !== 200) {
              return rej(new Error(`HTTP ${response.statusCode}`));
            }
            let data = "";
            response.on("data", (chunk) => { data += chunk; });
            response.on("end", () => {
              try {
                const json = JSON.parse(data);
                if (json && json.version) {
                  res(json.version);
                } else {
                  rej(new Error("Invalid package metadata"));
                }
              } catch (e) {
                rej(e);
              }
            });
          }
        );
        req.on("error", rej);
        req.on("timeout", () => { req.destroy(); rej(new Error("请求超时")); });
      });
    };

    // 优先使用国内 npmmirror 镜像源（延迟极低），失败时自动回退至 npm 官方源
    fetchFromUrl("https://registry.npmmirror.com/@deepseek-ai/dsh/latest")
      .then(resolve)
      .catch(() => {
        fetchFromUrl("https://registry.npmjs.org/@deepseek-ai/dsh/latest")
          .then(resolve)
          .catch(reject);
      });
  });
}

function checkForKernelUpdates(silent = true) {
  if (isDownloadingUpdate || isUpdatingKernel) {
    if (!silent) {
      dialog.showMessageBox(mainWindow || null, {
        type: "info",
        title: "提示",
        message: "当前正在进行其他更新任务，请稍候再试。",
      });
    }
    return;
  }

  fetchLatestKernelVersion()
    .then((latestVersion) => {
      const localVersion = getLocalKernelVersion();
      console.log(`[dsh-desktop] Kernel check: local=v${localVersion}, latest=v${latestVersion}`);

      if (latestVersion && compareVersions(latestVersion, localVersion) > 0) {
        dialog.showMessageBox(mainWindow || null, {
          type: "info",
          title: `⚡ 发现 DeepSeek 官方新内核 (v${latestVersion})`,
          message: `检测到 DeepSeek 官方已发布全新内核版本 v${latestVersion}（当前本地版本为 v${localVersion}）！\n\n是否立即一键自动升级内核并热重启服务？`,
          buttons: ["🚀 立即一键升级内核", "稍后再说"],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) {
            upgradeKernel(latestVersion);
          }
        });
      } else if (!silent) {
        dialog.showMessageBox(mainWindow || null, {
          type: "info",
          title: "检查官方内核更新",
          message: `当前已是最新内核版本 (v${localVersion})！无需更新。`,
        });
      }
    })
    .catch((err) => {
      if (!silent) {
        dialog.showMessageBox(mainWindow || null, {
          type: "warning",
          title: "检查官方内核更新",
          message: `获取官方内核版本失败: ${err.message}\n请检查网络连接后重试。`,
        });
      }
    });
}

function upgradeKernel(targetVersion = "latest") {
  if (isUpdatingKernel) {
    dialog.showMessageBox(mainWindow || null, {
      type: "info",
      title: "正在升级",
      message: "官方内核正在后台升级中，请稍候...",
    });
    return;
  }

  isUpdatingKernel = true;
  const npmBin = resolveNpm();
  ensureNodeInPath();

  dialog.showMessageBox(mainWindow || null, {
    type: "info",
    title: "⚡ 开始升级内核",
    message: `已开始在后台下载并安装官方最新内核 (@deepseek-ai/dsh@${targetVersion})。\n安装完成后将自动热重启后端服务并刷新界面，请稍候！`,
    buttons: ["好的"],
  });

  const installProcess = spawn(npmBin, ["install", "-g", `@deepseek-ai/dsh@${targetVersion}`], {
    shell: true,
    windowsHide: true,
    env: process.env,
  });

  let errorLogs = "";
  if (installProcess.stderr) {
    installProcess.stderr.on("data", (data) => {
      errorLogs += data.toString();
    });
  }

  installProcess.on("close", async (code) => {
    isUpdatingKernel = false;
    if (code === 0) {
      const newLocalVersion = getLocalKernelVersion();
      console.log(`[dsh-desktop] Kernel upgraded successfully to v${newLocalVersion}`);

      // 优雅热重启后台服务
      await restartBackendService();

      dialog.showMessageBox(mainWindow || null, {
        type: "info",
        title: "🎉 内核升级成功",
        message: `DeepSeek 官方内核已成功升级至 v${newLocalVersion}！\n后端服务已自动热重启完成。`,
      });
    } else {
      console.error("[dsh-desktop] Kernel upgrade failed with code:", code, errorLogs);
      dialog.showMessageBox(mainWindow || null, {
        type: "error",
        title: "内核升级失败",
        message: `升级内核过程遇到错误 (Exit Code: ${code})。\n您可以尝试在终端手动执行: npm i -g @deepseek-ai/dsh@latest\n\n错误日志:\n${errorLogs.slice(0, 300)}`,
      });
    }
  });

  installProcess.on("error", (err) => {
    isUpdatingKernel = false;
    dialog.showMessageBox(mainWindow || null, {
      type: "error",
      title: "启动升级失败",
      message: `无法调用 npm 工具链: ${err.message}\n请确认系统中已正确安装 Node.js 与 npm。`,
    });
  });
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

function resolveNpm() {
  const nodeBin = resolveNode();
  if (nodeBin && fs.existsSync(nodeBin)) {
    const nodeDir = path.dirname(nodeBin);
    const npmCmd = path.join(nodeDir, "npm.cmd");
    if (fs.existsSync(npmCmd)) return npmCmd;
    const npmExe = path.join(nodeDir, "npm.exe");
    if (fs.existsSync(npmExe)) return npmExe;
  }
  const which = spawnSync("where", ["npm"], { encoding: "utf8", shell: true, windowsHide: true });
  if (which.status === 0 && which.stdout.trim()) {
    const hit = which.stdout.trim().split(/\r?\n/).find((line) => /npm\.cmd$/i.test(line) || /npm$/i.test(line));
    if (hit) return hit;
  }
  return "npm";
}

function resolveDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
  const globalCandidates = [
    path.join("D:\\hclaw\\node", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
  ].filter(Boolean);

  let best = null;
  let bestTime = 0;

  for (const candidate of globalCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        const st = fs.statSync(candidate);
        if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = candidate; }
      } catch { /* ignore */ }
    }
  }

  const cacheRoots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx") : null,
    process.env.npm_config_cache ? path.join(process.env.npm_config_cache, "_npx") : null,
    path.join(process.env.USERPROFILE || "", ".npm", "_npx"),
  ].filter(Boolean);

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

function sanitizeWebProfile() {
  try {
    const webPkgPath = path.join(app.getPath("home"), ".dsh", "profiles", "web", "package.json");
    if (!fs.existsSync(webPkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(webPkgPath, "utf8"));
    let modified = false;

    // 过滤掉任何仅适用于命令行终端且会导致 Web 模式抛出 TTY 致命异常的插件
    const incompatiblePlugins = ["@deepseek-harness-tui/dsh-tui"];

    if (pkg.dependencies) {
      for (const p of incompatiblePlugins) {
        if (pkg.dependencies[p]) {
          delete pkg.dependencies[p];
          modified = true;
        }
      }
    }

    if (pkg.dsh?.profile?.bundles && Array.isArray(pkg.dsh.profile.bundles)) {
      const originalLen = pkg.dsh.profile.bundles.length;
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(
        (b) => !incompatiblePlugins.includes(b)
      );
      if (pkg.dsh.profile.bundles.length !== originalLen) modified = true;
    }

    if (modified) {
      fs.writeFileSync(webPkgPath, JSON.stringify(pkg, null, 2), "utf8");
      console.log("[dsh-desktop] Auto-healed web profile package.json (removed incompatible plugins).");
    }
  } catch (err) {
    console.warn("[dsh-desktop] Note: web profile check skipped:", err.message);
  }
}

function spawnBackend() {
  sanitizeWebProfile();
  const cwd = process.env.DSH_WORKSPACE || app.getPath("home");
  ensureNodeInPath();
  const env = { ...process.env };
  if (process.env.DSH_HOME) env.DSH_HOME = process.env.DSH_HOME;
  env.DSH_BUNDLED_SKILL_DIR = path.join(app.getPath("home"), ".dsh", "skills");

  const nodeBin = resolveNode();
  const dshBin = resolveDshBin();
  let child;

  console.log("[dsh-desktop] Starting DSH Web Kernel via Node process...");
  console.log("[dsh-desktop] nodeBin:", nodeBin, "dshBin:", dshBin);

  if (dshBin && /\.cmd$/i.test(dshBin)) {
    child = spawn(dshBin, ["web", "--no-open"], { cwd, env, stdio: "pipe", windowsHide: true, shell: true });
  } else if (dshBin) {
    child = spawn(nodeBin, [dshBin, "web", "--no-open"], {
      cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
    });
  } else {
    child = spawn("npx", ["-y", "@deepseek-ai/dsh", "web", "--no-open"], { cwd, env, stdio: "pipe", windowsHide: true, shell: true });
  }

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

  backendSpawnedByUs = true;
  backendProc = child;
  child.on("exit", (code) => {
    console.log("[dsh-desktop] DSH Backend exited with code:", code);
    backendProc = null;
  });
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

async function restartBackendService() {
  console.log("[dsh-desktop] Restarting backend service...");
  try {
    stopBackendIfOurs();
    let retries = 25;
    while ((await portInUse(WEB_PORT)) && retries-- > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
    spawnBackend();
    const ready = await waitForWeb(30_000);
    if (ready && mainWindow && !mainWindow.isDestroyed()) {
      try {
        await mainWindow.webContents.executeJavaScript(`
          try {
            sessionStorage.removeItem("dshm-restart");
            sessionStorage.removeItem("dshm-pending");
            sessionStorage.removeItem("dshm-restart-dismissed");
          } catch (e) {}
        `);
      } catch (e) {}
      mainWindow.reload();
      return { success: true };
    }
    return { success: ready };
  } catch (err) {
    console.error("[dsh-desktop] Failed to restart backend service:", err);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Native Desktop IPC: Restart Backend Service & App Info & Updates
// ---------------------------------------------------------------------------
ipcMain.handle("restart-backend-service", async () => {
  console.log("[dsh-desktop] Triggering native restart of DSH Backend...");
  return await restartBackendService();
});

ipcMain.handle("get-app-info", () => {
  return {
    version: app.getVersion(),
    name: "DSH Desktop",
    kernelVersion: getLocalKernelVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
});

ipcMain.handle("check-for-updates-manual", () => {
  checkForUpdates(false);
  return { success: true };
});

ipcMain.handle("check-for-kernel-updates-manual", () => {
  checkForKernelUpdates(false);
  return { success: true };
});

ipcMain.handle("upgrade-kernel-manual", () => {
  upgradeKernel("latest");
  return { success: true };
});


// ---------------------------------------------------------------------------
// Auto-initialize 35 bundled skills into user's ~/.dsh/skills on first run
// ---------------------------------------------------------------------------
// Auto-initialize 35 bundled skills into user's ~/.dsh/skills on first run
// ---------------------------------------------------------------------------
// Auto-initialize 35 bundled skills into user's ~/.dsh/skills & ~/.agents/skills
// ---------------------------------------------------------------------------
function copyDirSyncSafe(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSyncSafe(srcPath, destPath);
    } else if (entry.isFile()) {
      if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
        const data = fs.readFileSync(srcPath);
        fs.writeFileSync(destPath, data);
      }
    }
  }
}

function ensureBundledSkills() {
  try {
    const userHome = process.env.USERPROFILE || process.env.HOME || app.getPath("home");
    const targetDirs = [
      path.join(userHome, ".dsh", "skills"),
      path.join(userHome, ".agents", "skills")
    ];

    const candidates = [
      path.join(__dirname.replace("app.asar", "app.asar.unpacked"), "bundled-skills"),
      path.join(__dirname, "bundled-skills"),
      process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "bundled-skills") : null,
      process.resourcesPath ? path.join(process.resourcesPath, "bundled-skills") : null,
    ].filter(Boolean);

    const sourceSkills = candidates.find((p) => fs.existsSync(p));

    if (sourceSkills) {
      for (const targetDir of targetDirs) {
        copyDirSyncSafe(sourceSkills, targetDir);
      }
      console.log("[dsh-desktop] 35 Bundled skills successfully initialized from: " + sourceSkills);
    } else {
      console.warn("[dsh-desktop] Bundled skills source folder not found in candidates:", candidates);
    }
  } catch (err) {
    console.warn("[dsh-desktop] ensureBundledSkills warning:", err.message);
  }
}

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
        label: "🔍 检查客户端更新...",
        click: () => {
          checkForUpdates(false);
        },
      },
      {
        label: "⚡ 检查官方内核更新...",
        click: () => {
          checkForKernelUpdates(false);
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

  // 错峰静默检查更新：启动 5 秒检查客户端外壳，10 秒检查官方内核
  setTimeout(() => {
    checkForUpdates(true);
  }, 5000);

  setTimeout(() => {
    if (!isDownloadingUpdate) {
      checkForKernelUpdates(true);
    }
  }, 10000);

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
  if (session && session.defaultSession) { session.defaultSession.clearCache().catch(() => {}); session.defaultSession.clearCodeCaches({}).catch(() => {}); }
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
