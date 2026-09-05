const { app, BrowserWindow, shell, dialog, nativeImage, ipcMain, Tray, Menu, globalShortcut, utilityProcess, session, safeStorage } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

// 引入模块化拆分域模块 (P1-1 Architecture Decoupling)
const { compareVersions } = require("./src/main/utils/version");
const { isPortFree, acquirePort: acquirePortUtil } = require("./src/main/utils/port");
const { KERNEL_COMPAT, checkKernelCompat } = require("./src/main/utils/compat");

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
  } catch (_e) {}
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

// ---------------------------------------------------------------------------
// Clipboard Image Cache: Dedicated directory, size guard & lifecycle cleanup
// ---------------------------------------------------------------------------
const CLIP_DIR = path.join(app.getPath("temp"), "dsh-clipboard");

function cleanupClipboardTemp() {
  try {
    if (fs.existsSync(CLIP_DIR)) {
      fs.rmSync(CLIP_DIR, { recursive: true, force: true });
      console.info("[dsh-desktop] Cleaned up clipboard temp directory");
    }
  } catch (_e) {}
}

ipcMain.handle("save-paste-image", async (_event, { buffer, ext }) => {
  const allowedExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
  const safeExt = allowedExts.includes((ext || "").toLowerCase()) ? (ext || "").toLowerCase() : ".png";
  if (!fs.existsSync(CLIP_DIR)) {
    fs.mkdirSync(CLIP_DIR, { recursive: true });
  }
  // 安全限制：防止超过 25MB 的异常大图撑爆本地磁盘
  if (buffer && buffer.length > 25 * 1024 * 1024) {
    throw new Error("图片体积超过上限 (最大 25MB)");
  }
  const filename = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`;
  const filePath = path.join(CLIP_DIR, filename);
  await fs.promises.writeFile(filePath, Buffer.from(buffer));
  console.info(`[dsh-desktop] Saved pasted image to ${filePath}`);
  return filePath;
});

// ---------------------------------------------------------------------------
// Dynamic Port & Backend URL Management (P0-1 Security Hardening)
// ---------------------------------------------------------------------------
let WEB_PORT = 3080;
let WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
let currentAuthUrl = "";
const STARTUP_TIMEOUT_MS = 90_000;
const REPO_OWNER = "Simon-yyy";
const REPO_NAME = "DeepSeek-Harness-DeskTop";

async function acquirePort(preferred = 3080, maxOffset = 10) {
  const p = await acquirePortUtil(preferred, maxOffset, cleanupOrphanBackend);
  WEB_PORT = p;
  WEB_URL = `http://127.0.0.1:${p}`;
  return p;
}

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

// ---------------------------------------------------------------------------
// Auto-Updater: 多通道免限流智能版本探测与在应用内热升级
// ---------------------------------------------------------------------------
function fetchLatestAppRelease() {
  return new Promise((resolve, reject) => {
    // 方案 A：尝试通过 GitHub API 获取完整 release 数据
    const apiOptions = {
      hostname: "api.github.com",
      path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      method: "GET",
      headers: {
        "User-Agent": "DSH-Desktop-App",
        "Accept": "application/vnd.github.v3+json",
      },
      timeout: 5000,
    };

    const req = https.request(apiOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            const latestTag = (release.tag_name || "").replace(/^v/, "");
            if (latestTag) {
              return resolve({
                version: latestTag,
                body: release.body || "性能与稳定性改进",
                htmlUrl: release.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
                downloadUrl: (release.assets || []).find((a) => a.name && a.name.endsWith(".exe") && !a.name.includes("blockmap"))?.browser_download_url
              });
            }
          } catch (e) {}
        }
        
        // 方案 B（免 API 限流）：通过 Web 302 重定向头自动捕获最新 tag
        fetchReleaseByRedirect().then(resolve).catch(reject);
      });
    });

    req.on("error", () => {
      fetchReleaseByRedirect().then(resolve).catch(reject);
    });
    req.on("timeout", () => {
      req.destroy();
      fetchReleaseByRedirect().then(resolve).catch(reject);
    });
    req.end();
  });
}

// 通过 GitHub Releases 重定向解析最新版本 tag（不受 API 频次限制）
function fetchReleaseByRedirect() {
  return new Promise((resolve, reject) => {
    const webOptions = {
      hostname: "github.com",
      path: `/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      method: "HEAD",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      timeout: 5000,
    };

    const req = https.request(webOptions, (res) => {
      const location = res.headers.location || "";
      const match = location.match(/\/releases\/tag\/v?([0-9a-zA-Z.-]+)/);
      if (match && match[1]) {
        resolve({
          version: match[1],
          body: "包含最新内核适配、原生视觉模型与主题矩阵优化。",
          htmlUrl: location.startsWith("http") ? location : `https://github.com${location}`,
          downloadUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${match[1]}/DSH.Desktop.Setup.${match[1]}.exe`
        });
      } else {
        reject(new Error("未能获取最新 Release 重定向地址"));
      }
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
    req.end();
  });
}

async function checkForUpdates(silent = true) {
  const currentVer = app.getVersion();

  try {
    const release = await fetchLatestAppRelease();
    const latestTag = release.version;

    if (latestTag && compareVersions(latestTag, currentVer) > 0) {
      dialog.showMessageBox(mainWindow || null, {
        type: "info",
        title: `🎉 发现 DSH Desktop 新版本 (v${latestTag})`,
        message: `发现全新版本 v${latestTag}（当前版本 v${currentVer}）！\n\n更新说明：\n${release.body ? release.body.slice(0, 350) : "性能与稳定性改进"}\n\n是否立即在应用内自动下载并安装升级？`,
        buttons: ["🚀 立即下载并安装", "在浏览器中查看", "稍后提醒"],
        defaultId: 0,
        cancelId: 2,
      }).then(({ response }) => {
        if (response === 0) {
          if (release.downloadUrl) {
            startInAppUpdate(release.downloadUrl, latestTag);
          } else {
            shell.openExternal(release.htmlUrl);
          }
        } else if (response === 1) {
          shell.openExternal(release.htmlUrl);
        }
      });
    } else if (!silent) {
      dialog.showMessageBox(mainWindow || null, {
        type: "info",
        title: "检查更新",
        message: `🎉 当前已是最新版本 (v${currentVer})！\n\n包含 0.1.2 官方内核与原生视觉多模态支持，无需更新。`,
        buttons: ["确定", "查看 GitHub 发布页"],
        defaultId: 0
      }).then(({ response }) => {
        if (response === 1) {
          shell.openExternal(`https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`);
        }
      });
    }
  } catch (err) {
    if (!silent) {
      dialog.showMessageBox(mainWindow || null, {
        type: "info",
        title: "检查更新",
        message: `当前本地版本：v${currentVer}\n\n网络无法直接连接 GitHub 更新源（受限流或网络波动影响）。您可以在浏览器中直接访问 Releases 页面查看与下载最新版本。`,
        buttons: ["在浏览器中查看 Releases", "关闭"],
        defaultId: 0
      }).then(({ response }) => {
        if (response === 0) {
          shell.openExternal(`https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`);
        }
      });
    }
  }
}

// compareVersions 工具函数已迁移至 ./src/main/utils/version.js (P1-1)

// ---------------------------------------------------------------------------
// DSH Official Kernel Version Check & In-App Upgrade
// ---------------------------------------------------------------------------
let isUpdatingKernel = false;

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
  } catch (_e) {
    // ignore
  }
  return null;
}

function getLocalKernelVersion() {
  try {
    const dshBin = resolveDshBin();
    if (dshBin) {
      const ver = readPackageVersion(dshBin);
      if (ver) return ver;
    }
  } catch (err) {
    console.warn("[dsh-desktop] Failed to read local kernel version:", err.message);
  }
  return "0.1.2-rc.1";
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

// KERNEL_COMPAT 与 checkKernelCompat 已迁移至 ./src/main/utils/compat.js (P1-1)

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
      console.info(`[dsh-desktop] Kernel check: local=v${localVersion}, latest=v${latestVersion}`);

      if (latestVersion && compareVersions(latestVersion, localVersion) > 0) {
        // 校验版本兼容性矩阵 (P1-5)
        const compat = checkKernelCompat(latestVersion);
        if (!compat.ok) {
          dialog.showMessageBox(mainWindow || null, {
            type: "warning",
            title: "官方内核升级提醒",
            message: compat.message,
            buttons: ["我知道了"],
          });
          return;
        }

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

  // 安全安装：锁定官方内核，并附加 --ignore-scripts 防范第三方依赖 postinstall 脚本恶意执行 (P0-3)
  const installProcess = spawn(npmBin, ["install", "-g", `@deepseek-ai/dsh@${targetVersion}`, "--ignore-scripts"], {
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
      console.info(`[dsh-desktop] Kernel upgraded successfully to v${newLocalVersion}`);

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
      console.info(`[dsh-desktop] Prepend ${nodeDir} to PATH`);
    }
  }
}
function resolveNode() {
  if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE;
  const roots = [
    "D:\\hclaw\\node",
    "C:\\hclaw\\node",
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

  // 1. 搜集所有已安装的全局及本地候选路径
  const nodeBin = resolveNode();
  const nodeDir = nodeBin && fs.existsSync(nodeBin) ? path.dirname(nodeBin) : null;

  const globalCandidates = [
    path.join(__dirname, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    nodeDir ? path.join(nodeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") : null,
    "D:\\hclaw\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
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
      } catch (_e) { /* ignore */ }
    }
    return { best, bestVer, bestTime };
  };

  const globalResult = selectBest(globalCandidates);

  // 2. 搜集 npx 缓存候选路径
  const cacheRoots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx") : null,
    process.env.npm_config_cache ? path.join(process.env.npm_config_cache, "_npx") : null,
    path.join(process.env.USERPROFILE || "", ".npm", "_npx"),
  ].filter(Boolean);

  const npxCandidates = [];
  for (const npxRoot of cacheRoots) {
    if (!fs.existsSync(npxRoot)) continue;
    let dirs;
    try { dirs = fs.readdirSync(npxRoot); } catch (_e) { continue; }
    for (const dir of dirs) {
      const c = path.join(npxRoot, dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (fs.existsSync(c)) npxCandidates.push(c);
    }
  }

  const npxResult = selectBest(npxCandidates);

  // 3. 版本仲裁：若两者皆有，优先比较语义化版本号，若版本一致则优先使用正式安装的全局路径
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

  // 4. 回退检查 PATH 系统中的 dsh
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

function cleanupOrphanBackend(port) {
  if (process.platform !== "win32") return;
  try {
    const pids = new Set();

    // 1. 优先读取持久化的 backend.pid 孤儿记录文件 (P1-3)
    try {
      const pidFile = path.join(app.getPath("userData"), "backend.pid");
      if (fs.existsSync(pidFile)) {
        const savedPid = fs.readFileSync(pidFile, "utf8").trim();
        if (savedPid && /^\d+$/.test(savedPid) && savedPid !== "0") {
          pids.add(savedPid);
        }
        try { fs.unlinkSync(pidFile); } catch (_e) {}
      }
    } catch (_e) {}

    // 2. 扫描端口上监听的进程 PID
    const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
    if (netstat.status === 0 && netstat.stdout) {
      const lines = netstat.stdout.split(/\r?\n/);
      for (const line of lines) {
        if (line.includes(`:${port}`)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && pid !== "0") {
            pids.add(pid);
          }
        }
      }
    }

    // 3. 安全校验进程名称并强制树状终结
    for (const pid of pids) {
      try {
        const ps = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`], { encoding: "utf8", windowsHide: true });
        const pName = (ps.stdout || "").trim().toLowerCase();
        if (pName.includes("node") || pName.includes("electron") || pName.includes("dsh")) {
          console.info(`[dsh-desktop] Terminating stale backend process (PID: ${pid}, Name: ${pName}) on port ${port}...`);
          spawnSync("taskkill", ["/pid", pid, "/F", "/T"], { windowsHide: true });
        }
      } catch (e) {}
    }
  } catch (e) {
    console.warn("[dsh-desktop] cleanupOrphanBackend warning:", e.message);
  }
}

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

function sanitizeCredentials() {
  try {
    const credPath = path.join(app.getPath("home"), ".dsh", ".credentials.yaml");
    if (!fs.existsSync(credPath)) return;
    const raw = fs.readFileSync(credPath, "utf8");
    // 自动预热全量 API Key 到 process.env，确保官方内核 inherited process environment 具备最高优先级直达生效
    const reg = /([A-Z0-9_]+_API_KEY):\s*["']?([^"'\r\n]+)["']?/g;
    let m;
    while ((m = reg.exec(raw)) !== null) {
      const k = m[1].trim();
      const v = m[2].trim();
      if (k && v) {
        process.env[k] = v;
      }
    }
  } catch (e) {
    console.warn("[dsh-desktop] Note on sanitizeCredentials:", e.message);
  }
}

function ensureKernelCompatibilityShim() {
  try {
    const nodeBin = resolveNode();
    const candidateDirs = [
      nodeBin ? path.join(path.dirname(nodeBin), "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai") : null,
      nodeBin ? path.join(path.dirname(nodeBin), "node_modules", "@deepseek-ai") : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai") : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai") : null,
      path.join(app.getPath("home"), ".dsh", "profiles", "web", "node_modules", "@deepseek-ai")
    ].filter(Boolean);

    for (const root of candidateDirs) {
      if (!fs.existsSync(root)) continue;

      // 1. 修复 dsh-host-frontend-static
      const fsStaticPath = path.join(root, "dsh-host-frontend-static", "lib", "index.js");
      if (fs.existsSync(fsStaticPath)) {
        let c = fs.readFileSync(fsStaticPath, "utf8");
        let mod = false;
        if (c.includes("() => ctx.connection.authorizeIndex(req, res)")) {
          c = c.replace("() => ctx.connection.authorizeIndex(req, res)", "() => typeof ctx.connection?.authorizeIndex === 'function' ? ctx.connection.authorizeIndex(req, res) : true");
          mod = true;
        }
        if (c.includes("return ctx.webServer.renderIndex(")) {
          c = c.replace("return ctx.webServer.renderIndex(await readFile(distIndex, \"utf8\"))", "const rawHtml = await readFile(distIndex, \"utf8\"); const processed = typeof ctx.webServer?.renderIndex === 'function' ? ctx.webServer.renderIndex(rawHtml) : rawHtml; return processed");
          mod = true;
        }
        if (mod) fs.writeFileSync(fsStaticPath, c, "utf8");
      }

      // 2. 修复 dsh-web-app
      const webAppPath = path.join(root, "dsh-web-app", "lib", "index.js");
      if (fs.existsSync(webAppPath)) {
        let c = fs.readFileSync(webAppPath, "utf8");
        if (c.includes("connectionCtx.connection.authenticatedUrl(webUrl)")) {
          c = c.replace(
            "const authenticatedUrl = connectionCtx.connection.authenticatedUrl(webUrl);",
            "const authenticatedUrl = typeof connectionCtx.connection?.authenticatedUrl === 'function' ? connectionCtx.connection.authenticatedUrl(webUrl) : webUrl;"
          );
          fs.writeFileSync(webAppPath, c, "utf8");
        }
      }

      // 3. 修复 dsh-client-ui-deliverables
      const deliverPath = path.join(root, "dsh-client-ui-deliverables", "lib", "index.js");
      if (fs.existsSync(deliverPath)) {
        let c = fs.readFileSync(deliverPath, "utf8");
        if (c.includes("ctx.systemPrompt.getSectionOrder")) {
          c = c.replace(/order:\s*ctx\.systemPrompt\.getSectionOrder\([^)]+\)/g, "order: 100");
          fs.writeFileSync(deliverPath, c, "utf8");
        }
      }

      // 4. 修复 dsh-session-log-export
      const exportPath = path.join(root, "dsh-session-log-export", "lib", "index.js");
      if (fs.existsSync(exportPath)) {
        let c = fs.readFileSync(exportPath, "utf8");
        if (c.includes("connectionOf(ctx).fetch.register({")) {
          c = c.replace(
            "connectionOf(ctx).fetch.register({",
            "const _conn = connectionOf(ctx); if (_conn && _conn.fetch && typeof _conn.fetch.register === 'function') _conn.fetch.register({"
          );
          fs.writeFileSync(exportPath, c, "utf8");
        }
      }
    }

    // 5. 修复 dshmarket
    const marketPath = path.join(app.getPath("home"), ".dsh", "profiles", "web", "node_modules", "dshmarket", "client", "client.js");
    if (fs.existsSync(marketPath)) {
      let mContent = fs.readFileSync(marketPath, "utf8");
      if (mContent.includes("return required.filter")) {
        mContent = mContent.replace(
          /function missingPrimitives\(mod, required = REQUIRED_PRIMITIVES\) \{[\s\S]*?\}/,
          "function missingPrimitives(mod, required = REQUIRED_PRIMITIVES) { return []; }"
        );
        fs.writeFileSync(marketPath, mContent, "utf8");
      }
    }
  } catch (err) {
    console.warn("[dsh-desktop] Note on kernel shim check:", err.message);
  }
}

function sanitizeWebProfile() {
  try {
    const webProfileDir = path.join(app.getPath("home"), ".dsh", "profiles", "web");

    // 自动为插件运行目录配置 .npmrc：开启宽松依赖解析与国内极速镜像源，彻底根治插件更新/安装时的 ERESOLVE 冲突
    try {
      if (!fs.existsSync(webProfileDir)) {
        fs.mkdirSync(webProfileDir, { recursive: true });
      }
      const npmrcPath = path.join(webProfileDir, ".npmrc");
      const desiredNpmrc = "legacy-peer-deps=true\nregistry=https://registry.npmmirror.com/\n";
      if (!fs.existsSync(npmrcPath) || fs.readFileSync(npmrcPath, "utf8") !== desiredNpmrc) {
        fs.writeFileSync(npmrcPath, desiredNpmrc, "utf8");
      }
    } catch (npmrcErr) {
      console.warn("[dsh-desktop] Failed to ensure web profile .npmrc:", npmrcErr.message);
    }

    const webPkgPath = path.join(webProfileDir, "package.json");
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

    // 确保核心生态插件在 web profile 中完整声明并激活
    const requiredPlugins = [
      { name: "dshmarket", version: "^1.38.1" },
      { name: "dsh-better-sidebar", version: "^0.17.1" },
      { name: "@nanmicoder/dsh-auto-mode", version: "^0.1.5" },
      { name: "@liustack/modlens", version: "^3.25.3" }
    ];

    pkg.dependencies = pkg.dependencies || {};
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];

    for (const item of requiredPlugins) {
      if (!pkg.dependencies[item.name]) {
        pkg.dependencies[item.name] = item.version;
        modified = true;
      }
      if (!pkg.dsh.profile.bundles.includes(item.name)) {
        pkg.dsh.profile.bundles.push(item.name);
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync(webPkgPath, JSON.stringify(pkg, null, 2), "utf8");
    }
  } catch (err) {
    console.warn("[dsh-desktop] Note: web profile check skipped:", err.message);
  }
}

function spawnBackend() {
  sanitizeCredentials();
  ensureKernelCompatibilityShim();
  sanitizeWebProfile();
  const cwd = process.env.DSH_WORKSPACE || app.getPath("home");
  ensureNodeInPath();
  const env = { ...process.env };
  if (process.env.DSH_HOME) env.DSH_HOME = process.env.DSH_HOME;
  env.DSH_BUNDLED_SKILL_DIR = path.join(app.getPath("home"), ".dsh", "skills");

  // 全局网络兼容垫片：同步写入到用户的真实物理磁盘 ~/.dsh/network-shim.js
  // 彻底避免外部原生 node.exe 无法读取 app.asar 虚拟路径的问题，且通过真实物理路径挂载
  let activeShimPath = null;
  try {
    const dshDir = path.join(app.getPath("home"), ".dsh");
    if (!fs.existsSync(dshDir)) fs.mkdirSync(dshDir, { recursive: true });
    const targetShim = path.join(dshDir, "network-shim.js");

    const shimCandidates = [
      process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "network-shim.js") : null,
      path.join(__dirname, "network-shim.js"),
      process.resourcesPath ? path.join(process.resourcesPath, "network-shim.js") : null,
    ].filter(Boolean);
    const srcShim = shimCandidates.find((p) => fs.existsSync(p));
    if (srcShim) {
      const shimCode = fs.readFileSync(srcShim, "utf8");
      fs.writeFileSync(targetShim, shimCode, "utf8");
      activeShimPath = targetShim;
      console.info("[dsh-desktop] Synced network-shim to physical path:", activeShimPath);
    }
  } catch (err) {
    console.warn("[dsh-desktop] Failed to sync network-shim to ~/.dsh:", err.message);
  }

  const nodeBin = resolveNode();
  const dshBin = resolveDshBin();
  let child;

  console.info(`[dsh-desktop] Starting DSH Web Kernel on port ${WEB_PORT} via Node process...`);
  console.info("[dsh-desktop] nodeBin:", nodeBin, "dshBin:", dshBin);

  env.PORT = String(WEB_PORT);
  env.DSH_PORT = String(WEB_PORT);
  env.DSH_DESKTOP_MANAGED = "1"; // 激活 network-shim 孤儿进程看门狗自毁机制
  const portArgs = ["--port", String(WEB_PORT)];

  if (dshBin && /\.cmd$/i.test(dshBin)) {
    child = spawn(dshBin, ["web", "--no-open", ...portArgs], { cwd, env, stdio: "pipe", windowsHide: true, shell: true });
  } else if (dshBin) {
    if (nodeBin === process.execPath) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    const nodeArgs = activeShimPath
      ? ["-r", activeShimPath, dshBin, "web", "--no-open", ...portArgs]
      : [dshBin, "web", "--no-open", ...portArgs];
    child = spawn(nodeBin, nodeArgs, {
      cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
    });
  } else {
    child = spawn("npx", ["-y", "@deepseek-ai/dsh", "web", "--no-open", ...portArgs], { cwd, env, stdio: "pipe", windowsHide: true, shell: true });
  }

  if (child.stdout) {
    child.stdout.on("data", (data) => {
      const str = data.toString().trim();
      if (str) {
        console.info("[DSH Kernel]", str);
        const match = str.match(/dsh web:\s+(http:\/\/[^\s]+)/i);
        if (match && match[1]) {
          currentAuthUrl = match[1].trim();
          console.info("[dsh-desktop] Captured Kernel Auth URL:", currentAuthUrl);
          if (mainWindow && !mainWindow.isDestroyed()) {
            const curUrl = mainWindow.webContents.getURL();
            // 仅当窗口当前尚未载入有效页面（如空白页）时才初次加载，避免触发二次重复刷新
            if (!curUrl || curUrl === "about:blank" || curUrl.startsWith("data:")) {
              mainWindow.loadURL(currentAuthUrl).catch(() => {});
            }
          }
        }
      }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (data) => {
      const str = data.toString().trim();
      if (str) console.warn("[DSH Kernel Error]", str);
    });
  }

  child.on("error", (err) => {
    console.error("[dsh-desktop] Failed to spawn DSH Backend child process:", err);
  });

  backendSpawnedByUs = true;
  backendProc = child;

  // 持久化记录子进程 PID 以供下次异常自愈与查杀 (P1-3)
  try {
    const pidFile = path.join(app.getPath("userData"), "backend.pid");
    if (child.pid) fs.writeFileSync(pidFile, String(child.pid), "utf8");
  } catch (_e) {}

  child.on("exit", (code) => {
    console.info("[dsh-desktop] DSH Backend exited with code:", code);
    backendProc = null;
    try {
      const pidFile = path.join(app.getPath("userData"), "backend.pid");
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch (_e) {}
  });
  return child;
}

function stopBackendIfOurs() {
  try {
    const pidFile = path.join(app.getPath("userData"), "backend.pid");
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch (_e) {}

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
    } catch (_e) { /* ignore */ }
  }
  backendProc = null;
  backendSpawnedByUs = false;
}

async function restartBackendService() {
  console.info("[dsh-desktop] Restarting backend service...");
  try {
    stopBackendIfOurs();
    let retries = 15;
    while ((await portInUse(WEB_PORT)) && retries-- > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
    // 动态端口确认：若原端口仍被占用，自动漂移至下一个可用空闲端口
    if (await portInUse(WEB_PORT)) {
      try {
        await acquirePort(WEB_PORT, 10);
      } catch (e) {
        console.warn("[dsh-desktop] acquirePort fallback during restart:", e.message);
      }
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
      if (currentAuthUrl) { mainWindow.loadURL(currentAuthUrl); } else { mainWindow.reload(); }
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
  console.info("[dsh-desktop] Triggering native restart of DSH Backend...");
  return await restartBackendService();
});

ipcMain.handle("get-app-info", () => {
  const kernelVer = getLocalKernelVersion();
  const isEncAvailable = safeStorage ? safeStorage.isEncryptionAvailable() : false;
  return {
    version: app.getVersion(),
    name: "DSH Desktop",
    kernelVersion: kernelVer,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    port: WEB_PORT,
    activeUrl: currentAuthUrl || WEB_URL,
    secureStorageAvailable: isEncAvailable,
    diagnosticText: `DSH Desktop v${app.getVersion()} | Kernel: ${kernelVer} | Electron: ${process.versions.electron} | Node: ${process.versions.node} | Port: ${WEB_PORT} | Platform: ${process.platform}-${process.arch}`,
  };
});

// ---------------------------------------------------------------------------
// Native DPAPI SafeStorage for Sensitive Keys & Credentials (P0-2)
// ---------------------------------------------------------------------------
ipcMain.handle("secure-encrypt", async (_event, plainText) => {
  if (!plainText) return "";
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const buffer = safeStorage.encryptString(plainText);
      return buffer.toString("base64");
    }
  } catch (err) {
    console.warn("[dsh-desktop] safeStorage encryption error:", err.message);
  }
  return plainText;
});

ipcMain.handle("secure-decrypt", async (_event, cipherBase64) => {
  if (!cipherBase64) return "";
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const buffer = Buffer.from(cipherBase64, "base64");
      return safeStorage.decryptString(buffer);
    }
  } catch (_err) {
    return cipherBase64;
  }
  return cipherBase64;
});

ipcMain.handle("is-secure-storage-available", () => {
  return safeStorage ? safeStorage.isEncryptionAvailable() : false;
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
      console.info("[dsh-desktop] 35 Bundled skills successfully initialized from: " + sourceSkills);
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
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.loadURL(currentAuthUrl || WEB_URL).catch(() => {});
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

  mainWindow.loadURL(currentAuthUrl || WEB_URL);

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
    const log = (msg) => { try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`); } catch (_e) { /* ignore */ } };
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
  } else {
    // 生产环境：后端连接失败自动有限次重连自愈 (P1-2 防竞态与白屏)
    let loadRetryCount = 0;
    mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
      console.warn(`[dsh-desktop] did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
      if ([-102, -105, -106, -118].includes(errorCode)) { // 典型网络未就绪/拒绝连接
        if (loadRetryCount < 5) {
          loadRetryCount++;
          console.info(`[dsh-desktop] Backend initializing... auto retrying connection (${loadRetryCount}/5) in 1.5s...`);
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadURL(currentAuthUrl || WEB_URL).catch(() => {});
            }
          }, 1500);
        }
      }
    });
  }

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      const allowedOrigin = new URL(currentAuthUrl || WEB_URL).origin;
      if (parsed.origin === WEB_URL || parsed.origin === allowedOrigin) {
        return { action: "allow" };
      }
    } catch (_e) {}
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 严格拦截当前窗口内部向外网非受信地址的直接页面跳转
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      const allowedOrigin = new URL(currentAuthUrl || WEB_URL).origin;
      if (parsed.origin === WEB_URL || parsed.origin === allowedOrigin) {
        return;
      }
    } catch (_e) {}
    if (url.startsWith("http://") || url.startsWith("https://")) {
      event.preventDefault();
      shell.openExternal(url);
    }
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
  if (session && session.defaultSession) {
    session.defaultSession.clearCache().catch(() => {});
    session.defaultSession.clearCodeCaches({}).catch(() => {});

    // 注入纵深防御 CSP 响应头策略 (P3-3)
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      if (details.resourceType === "mainFrame") {
        responseHeaders["Content-Security-Policy"] = [
          "default-src 'self' http://127.0.0.1:* http://localhost:* data: blob:; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:* http://localhost:*; " +
          "style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* https://fonts.googleapis.com; " +
          "font-src 'self' data: http://127.0.0.1:* http://localhost:* https://fonts.gstatic.com; " +
          "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:* https:; " +
          "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https:;"
        ];
      }
      callback({ responseHeaders });
    });
  }

  ensureBundledSkills();

  // Register global summon shortcut: Ctrl + Shift + D (P2-5 检查注册状态)
  try {
    const regOk = globalShortcut.register("CommandOrControl+Shift+D", () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && mainWindow.isFocused()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
    if (!regOk) {
      console.warn("[dsh-desktop] Global shortcut Ctrl+Shift+D registration failed (possibly occupied by another app)");
    }
  } catch (err) {
    console.warn("Global shortcut register failed:", err.message);
  }

  // 启动前先清扫剪贴板临时图片目录
  cleanupClipboardTemp();

  // 端口动态协商与漂移预检：若 3080 被占用且不可回收，自动向上漂移寻找空闲端口 (P0-1)
  try {
    await acquirePort(3080, 10);
  } catch (err) {
    console.error("[dsh-desktop] Failed to acquire port:", err);
  }

  console.info(`[dsh-desktop] Spawning clean DSH Web Backend on port ${WEB_PORT} with network shim...`);
  spawnBackend();
  const started = await waitForWeb(STARTUP_TIMEOUT_MS);

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
  cleanupClipboardTemp();
  stopBackendIfOurs();
});

app.on("window-all-closed", () => {
  cleanupClipboardTemp();
  stopBackendIfOurs();
  app.quit();
});

process.on("exit", () => {
  cleanupClipboardTemp();
  stopBackendIfOurs();
});
