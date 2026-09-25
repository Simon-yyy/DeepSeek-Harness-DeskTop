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
const { KERNEL_COMPAT, checkKernelCompat, KERNEL_CHANNELS, VERIFIED_KERNELS } = require("./src/main/utils/compat");
const {
  resolveDshKernel,
  resolveBundledKernel,
  resolveDshBin,
  getLocalKernelVersion,
  hasNodeInstalled,
  resolveNode,
  resolveNpm,
  resolveNpx,
  readPackageVersion,
  validateKernelTargetVersion,
} = require("./src/main/utils/kernel");
const { sanitizeWebProfile: sanitizeWebProfileUtil, uninstallPluginFromWebProfile } = require("./src/main/utils/profile");
const {
  isKernelActivationUrl,
  mintKernelAuthCookie,
  verifyKernelHttpReady,
} = require("./src/main/utils/readiness");
const {
  resolveDshHome,
  dshHomePath,
  getWebProfileDir,
  getSkillsDir,
  getNetworkShimPath,
  getCredentialsYamlPath,
  getPidFilePath,
} = require("./src/main/utils/home");
const {
  saveCredentials,
  loadCredentials,
  migratePlaintextCredentials,
  injectCredentialsIntoEnv,
  isEncryptionAvailable,
} = require("./src/main/utils/credentials");
const {
  verifyInstallerIntegrity,
  canExecuteInstaller,
  getExpectedInstallerFileName,
  buildReleaseDownloadUrl,
} = require("./src/main/utils/updater");
const { verifyProcessIdentity, checkPortOwnerFromNetstat } = require("./src/main/utils/process-guard");


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

ipcMain.handle("save-paste-image", async (_event, { buffer, ext } = {}) => {
  if (!isTrustedSender(_event)) {
    throw new Error("拒绝非受信任的渲染源调用安全 IPC (5.2.7)");
  }
  const allowedExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
  const safeExt = allowedExts.includes((ext || "").toLowerCase()) ? (ext || "").toLowerCase() : ".png";
  if (!fs.existsSync(CLIP_DIR)) {
    fs.mkdirSync(CLIP_DIR, { recursive: true });
  }
  // 安全限制：防止超过 25MB 的异常大图撑爆本地磁盘
  if (!buffer || buffer.length > 25 * 1024 * 1024) {
    throw new Error("图片体积超过上限 (最大 25MB) 或数据为空");
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
const STARTUP_TIMEOUT_MS = 240_000; // 首次启动放宽至 4 分钟（弹性心跳检测，绝不误杀下载中的进程）
const REPO_OWNER = "Simon-yyy";
const REPO_NAME = "DeepSeek-Harness-DeskTop";

async function acquirePort(preferred = 3080, maxOffset = 10) {
  const p = await acquirePortUtil(preferred, maxOffset, cleanupOrphanBackend);
  WEB_PORT = p;
  WEB_URL = `http://127.0.0.1:${p}`;
  return p;
}

async function ensureKernelCookieInSession(port) {
  try {
    if (!session || !session.defaultSession) return false;
    const cookie = mintKernelAuthCookie(port);
    if (!cookie) return false;

    await session.defaultSession.cookies.set({
      url: `http://127.0.0.1:${port}`,
      name: cookie.name,
      value: cookie.value,
      path: "/",
      httpOnly: true,
      expirationDate: Math.floor(cookie.expiresAt / 1000),
    });
    console.info(`[dsh-desktop] Injected dual-track auth cookie for port ${port} into session.`);
    return true;
  } catch (err) {
    console.warn("[dsh-desktop] ensureKernelCookieInSession warning:", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------

let isNavigatingToWorkbench = false;
let workbenchLoaded = false;
let pendingNavigateUrl = null;

async function safeNavigateToWorkbench(targetUrl, options = {}) {
  const url = targetUrl || currentAuthUrl || WEB_URL;
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const curUrl = mainWindow.webContents.getURL();
  if (workbenchLoaded && !options.force && curUrl && !curUrl.startsWith("data:") && curUrl !== "about:blank") {
    console.info("[dsh-desktop] safeNavigateToWorkbench: workbench already loaded, skipping redundant navigation.");
    return true;
  }

  if (isNavigatingToWorkbench && !options.force) {
    console.info(`[dsh-desktop] safeNavigateToWorkbench: navigation in flight, queuing target URL: ${url}`);
    pendingNavigateUrl = url;
    return false;
  }

  isNavigatingToWorkbench = true;
  try {
    await ensureKernelCookieInSession(WEB_PORT);
    if (!mainWindow || mainWindow.isDestroyed()) return false;

    console.info(`[dsh-desktop] Executing safeNavigateToWorkbench -> ${url}`);
    if (typeof updateSplashStatus === "function") {
      updateSplashStatus("本地服务已就绪，正在载入工作台...");
    }
    await mainWindow.loadURL(url);
    workbenchLoaded = true;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
    console.info("[dsh-desktop] Workbench navigation completed successfully.");
    return true;
  } catch (err) {
    const isAborted = err.code === "ERR_ABORTED" || String(err.message).includes("ERR_ABORTED");
    if (isAborted) {
      console.warn("[dsh-desktop] safeNavigateToWorkbench loadURL was aborted:", err.message);
      const afterUrl = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : "";
      if (afterUrl && !afterUrl.startsWith("data:") && afterUrl !== "about:blank") {
        workbenchLoaded = true;
        return true;
      }
    } else {
      console.error("[dsh-desktop] safeNavigateToWorkbench loadURL error:", err.message);
    }
    return false;
  } finally {
    isNavigatingToWorkbench = false;
    if (pendingNavigateUrl && !workbenchLoaded && mainWindow && !mainWindow.isDestroyed()) {
      const nextUrl = pendingNavigateUrl;
      pendingNavigateUrl = null;
      setImmediate(() => {
        safeNavigateToWorkbench(nextUrl);
      });
    }
  }
}
// Auto-Updater: In-App Download, Auto-Install & GitHub Release Sync
// ---------------------------------------------------------------------------
let isDownloadingUpdate = false;

function downloadFile(url, destPath, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error("下载重定向次数超过上限 (5 次)，已安全阻断"));
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error("下载地址非法: " + e.message));
    }

    if (parsedUrl.protocol !== "https:") {
      return reject(new Error("仅允许通过 HTTPS 安全协议下载更新"));
    }

    // 严格限制受信任的 GitHub 官方发布域名与专属 CDN 白名单 (R1-4 & 5.7 P1)
    const hostname = parsedUrl.hostname.toLowerCase();
    const isTrustedHost =
      hostname === "github.com" ||
      hostname.endsWith(".github.com") ||
      hostname.endsWith(".githubusercontent.com") ||
      (/^github(?:-production-release-asset[^.]*)?\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(hostname));

    if (!isTrustedHost) {
      return reject(new Error(`拒绝从非受信域名下载安装包: ${hostname}`));
    }

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "User-Agent": "DSH-Desktop-App",
      },
    };

    const req = https.get(options, (res) => {
      // 处理 HTTP 301 / 302 / 307 / 308 重定向 (GitHub Releases -> AWS S3 / CDN)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(downloadFile(res.headers.location, destPath, onProgress, redirectCount + 1));
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
      });

      // 确保文件流物理完成写入并关闭句柄后再 resolve (R1-4)
      fileStream.on("finish", () => {
        fileStream.close(() => {
          resolve(destPath);
        });
      });

      const handleError = (err) => {
        fileStream.destroy();
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_e) {}
        reject(err);
      };

      res.on("error", handleError);
      fileStream.on("error", handleError);
    });

    req.on("error", (err) => {
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_e) {}
      reject(err);
    });
  });
}

function startInAppUpdate(assetUrl, newVersion, options = {}) {
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
    let integrityResult;
    try {
      integrityResult = verifyInstallerIntegrity(installerPath, {
        minSizeBytes: 5 * 1024 * 1024,
        expectedSha256: options.expectedSha256,
      });
    } catch (statErr) {
      dialog.showErrorBox("更新包校验失败", statErr.message);
      return;
    }

    const execDecision = canExecuteInstaller(integrityResult);
    if (!execDecision.canExecute) {
      dialog.showMessageBox(mainWindow || null, {
        type: "warning",
        title: "⚠️ 安全阻断自动执行",
        message: `v${newVersion} 安装包已下载，但${execDecision.reason}。\n为确保系统安全，桌面端已阻断自动静默执行。\n\n建议您前往官方 GitHub Releases 页面核验发布清单与哈希后手动运行。`,
        buttons: ["前往官网 Releases 核验", "打开下载目录", "取消"],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          shell.openExternal(`https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`);
        } else if (response === 1) {
          shell.showItemInFolder(installerPath);
        }
      });
      return;
    }

    dialog.showMessageBox(mainWindow || null, {
      type: "info",
      title: "🎉 下载完成",
      message: `v${newVersion} 安装包已下载完成并通过 SHA-256 完整性哈希校验！\n点击确定后应用将自动退出并启动安装升级。`,
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
              let expectedSha256 = null;
              if (release.body) {
                const hashMatch = String(release.body).match(/(?:sha[-_]?256|hash)[:\s=]+([a-fA-F0-9]{64})/i);
                if (hashMatch) expectedSha256 = hashMatch[1].toLowerCase();
              }
              return resolve({
                version: latestTag,
                body: release.body || "性能与稳定性改进",
                htmlUrl: release.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
                downloadUrl: (release.assets || []).find((a) => a.name && a.name.endsWith(".exe") && !a.name.includes("blockmap"))?.browser_download_url,
                expectedSha256,
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
      const tagMatch = location.match(/\/releases\/tag\/([^/?#]+)/);
      const match = location.match(/\/releases\/tag\/v?([0-9a-zA-Z.-]+)/);
      if (match && match[1]) {
        const fullTag = tagMatch ? tagMatch[1] : (match[1].startsWith("v") ? match[1] : `v${match[1]}`);
        const versionNum = match[1].replace(/^v/, "");
        const installerFileName = getExpectedInstallerFileName(versionNum);
        resolve({
          version: versionNum,
          body: "包含最新内核适配、原生视觉模型与主题矩阵优化。",
          htmlUrl: location.startsWith("http") ? location : `https://github.com${location}`,
          downloadUrl: buildReleaseDownloadUrl(REPO_OWNER, REPO_NAME, fullTag, installerFileName),
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
            startInAppUpdate(release.downloadUrl, latestTag, { expectedSha256: release.expectedSha256 });
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

function fetchKernelDistTags() {
  return new Promise((resolve, reject) => {
    const fetchFromUrl = (targetUrl) => {
      return new Promise((res, rej) => {
        const parsed = new URL(targetUrl);
        const req = https.get(
          {
            hostname: parsed.hostname,
            path: parsed.pathname,
            headers: { "User-Agent": "DSH-Desktop-App" },
            timeout: 8000,
          },
          (response) => {
            if (response.statusCode !== 200) {
              return rej(new Error(`HTTP ${response.statusCode}`));
            }
            let data = "";
            response.on("data", (chunk) => {
              data += chunk;
            });
            response.on("end", () => {
              try {
                const json = JSON.parse(data);
                if (json && json["dist-tags"]) {
                  res(json["dist-tags"]);
                } else if (json && json.version) {
                  res({ latest: json.version });
                } else {
                  rej(new Error("Invalid package metadata: missing dist-tags"));
                }
              } catch (e) {
                rej(e);
              }
            });
          }
        );
        req.on("error", rej);
        req.on("timeout", () => {
          req.destroy();
          rej(new Error("请求超时"));
        });
      });
    };

    // 优先使用国内 npmmirror 镜像源（延迟极低），失败时自动回退至 npm 官方源
    fetchFromUrl("https://registry.npmmirror.com/@deepseek-ai/dsh")
      .then(resolve)
      .catch(() => {
        fetchFromUrl("https://registry.npmjs.org/@deepseek-ai/dsh")
          .then(resolve)
          .catch(reject);
      });
  });
}

function fetchLatestKernelVersion(channel = "latest") {
  return fetchKernelDistTags().then((tags) => {
    const version = tags[channel] || tags.latest;
    if (!version) {
      throw new Error(`未在远程镜像源中找到 [${channel}] 通道的版本信息`);
    }
    return version;
  });
}

// KERNEL_COMPAT 与 checkKernelCompat 已迁移至 ./src/main/utils/compat.js (P1-1)

function checkForKernelUpdates(silent = true, channel = "latest") {
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

  fetchKernelDistTags()
    .then((distTags) => {
      const targetVersion = distTags[channel] || distTags.latest;
      const kernelInfo = resolveDshKernel();
      const localVersion = kernelInfo.version || "unknown";
      console.info(`[dsh-desktop] Kernel check (${channel}): local=v${localVersion} (${kernelInfo.source}), target=v${targetVersion}`);

      if (targetVersion && compareVersions(targetVersion, localVersion) > 0) {
        // 校验版本兼容性矩阵
        const compat = checkKernelCompat(targetVersion);
        if (!compat.ok) {
          dialog.showMessageBox(mainWindow || null, {
            type: "warning",
            title: "官方内核升级提醒",
            message: compat.message,
            buttons: ["我知道了"],
          });
          return;
        }

        let desc = `检测到 DeepSeek 官方发布了新版内核 v${targetVersion}（当前通道: ${channel}，本地运行版本: v${localVersion}）！`;
        if (compat.warning) {
          desc += `\n\n⚠️ 注意：该版本尚未进入外壳完整回归验证白名单，属于尝鲜/测试版本。`;
        }
        desc += `\n\n是否立即一键自动升级内核并热重启服务？`;

        dialog.showMessageBox(mainWindow || null, {
          type: "info",
          title: `⚡ 发现 DeepSeek 官方新内核 (v${targetVersion} [${channel}])`,
          message: desc,
          buttons: ["🚀 立即一键升级内核", "稍后再说"],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) {
            upgradeKernel(targetVersion, channel);
          }
        });
      } else if (!silent) {
        dialog.showMessageBox(mainWindow || null, {
          type: "info",
          title: "检查官方内核更新",
          message: `当前已是最新内核版本 (v${localVersion}，通道: ${channel})！\n实际内核来源: ${kernelInfo.source || "未知"}\n运行路径: ${kernelInfo.path || "未定位"}\n无需更新。`,
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

async function resolveConcreteKernelVersion(targetVersion = "latest", channel = "latest") {
  const validation = validateKernelTargetVersion(targetVersion);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  if (validation.type === "semver") {
    return validation.clean;
  }

  const activeChannel = validation.clean === "next" || channel === "next" ? "next" : "latest";
  let resolvedVer = "";
  try {
    resolvedVer = await fetchLatestKernelVersion(activeChannel);
  } catch (_e) {
    const tags = await fetchKernelDistTags();
    resolvedVer = tags[activeChannel] || tags.next || tags.latest;
  }

  const cleanResolved = (resolvedVer || "").replace(/^v/, "").trim();
  const resolvedValidation = validateKernelTargetVersion(cleanResolved);
  if (resolvedValidation.valid && resolvedValidation.type === "semver") {
    return resolvedValidation.clean;
  }
  throw new Error(`无法从镜像源获取 [${activeChannel}] 通道的合法语义化版本信息 (接收到: ${resolvedVer || "空"})`);
}

async function upgradeKernel(targetVersion = "latest", channel = "latest") {
  if (isUpdatingKernel) {
    dialog.showMessageBox(mainWindow || null, {
      type: "info",
      title: "正在升级",
      message: "官方内核正在后台升级中，请稍候...",
    });
    return { success: false, error: "ALREADY_UPDATING" };
  }

  // 1. 预检：将 dist-tag (latest/next) 解析为精确语义化版本 (5.1.2)
  let cleanTarget = "";
  try {
    cleanTarget = await resolveConcreteKernelVersion(targetVersion, channel);
  } catch (resolveErr) {
    dialog.showMessageBox(mainWindow || null, {
      type: "error",
      title: "内核版本解析失败",
      message: `无法解析 [${channel}] 通道的官方最新版本号: ${resolveErr.message}`,
    });
    return { success: false, error: resolveErr.message };
  }

  const compat = checkKernelCompat(cleanTarget);
  if (!compat.ok) {
    dialog.showMessageBox(mainWindow || null, {
      type: "error",
      title: "内核升级阻断",
      message: compat.message || "该版本与当前客户端存在不兼容架构，禁止升级。",
    });
    return { success: false, error: compat.message };
  }

  isUpdatingKernel = true;
  const npmBin = resolveNpm();
  ensureNodeInPath();

  dialog.showMessageBox(mainWindow || null, {
    type: "info",
    title: "⚡ 开始升级内核",
    message: `已开始在后台下载并安装官方最新内核 (@deepseek-ai/dsh@${cleanTarget}) [${channel} 通道]。\n安装完成后将执行包校验、热重启服务并刷新界面，请稍候！`,
    buttons: ["好的"],
  });

  // 2. 安装：锁定精确版本，并附加 --ignore-scripts (P0-3)
  const installProcess = spawn(npmBin, ["install", "-g", `@deepseek-ai/dsh@${cleanTarget}`, "--ignore-scripts"], {
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
      // 3. 校验包和 CLI 与路径
      const updatedKernel = resolveDshKernel();
      console.info(`[dsh-desktop] Post-upgrade kernel resolution:`, updatedKernel);

      if (!updatedKernel.path || !fs.existsSync(updatedKernel.path)) {
        dialog.showMessageBox(mainWindow || null, {
          type: "error",
          title: "内核校验失败",
          message: `npm 安装成功，但在系统中未能正确定位到内核可执行文件！\n请检查全局 node_modules 权限。`,
        });
        return;
      }

      if (updatedKernel.version && compareVersions(updatedKernel.version, cleanTarget) < 0) {
        console.warn(`[dsh-desktop] Version arbitration mismatch: resolved v${updatedKernel.version} < target v${cleanTarget}`);
        dialog.showMessageBox(mainWindow || null, {
          type: "warning",
          title: "内核版本冲突提示",
          message: `已安装 v${cleanTarget}，但当前系统解析到的优先版本仍为 v${updatedKernel.version}（路径: ${updatedKernel.path}）。\n若本地存在旧版离线包或缓存，可能需清理或手动指定 DSH_BIN。`,
        });
      }

      // 4. 停旧进程，启新进程并做就绪检查
      console.info(`[dsh-desktop] Restarting backend after upgrade to v${updatedKernel.version}...`);
      const restartResult = await restartBackendService();

      if (restartResult && restartResult.success === false) {
        dialog.showMessageBox(mainWindow || null, {
          type: "error",
          title: "内核升级后重启失败",
          message: `官方内核已升级至 v${updatedKernel.version}，但重启后台服务时发生异常: ${restartResult.error || "服务未能就绪"}\n旧版数据与会话已妥善保留，请检查日志。`,
        });
      } else {
        dialog.showMessageBox(mainWindow || null, {
          type: "info",
          title: "🎉 内核升级成功",
          message: `DeepSeek 官方内核已成功升级至 v${updatedKernel.version}！\n运行路径: ${updatedKernel.path}\n后端服务已自动热重启完成。`,
        });
      }
    } else {
      console.error("[dsh-desktop] Kernel upgrade failed with code:", code, errorLogs);
      dialog.showMessageBox(mainWindow || null, {
        type: "error",
        title: "内核升级失败",
        message: `升级内核过程遇到错误 (Exit Code: ${code})。\n您可以尝试在终端手动执行: npm i -g @deepseek-ai/dsh@${cleanTarget}\n\n错误日志:\n${errorLogs.slice(0, 300)}`,
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
// 注意：resolveNode, resolveNpm, resolveNpx, hasNodeInstalled, resolveDshBin,
// resolveDshKernel, getLocalKernelVersion 已统一抽取收敛至 ./src/main/utils/kernel.js


// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
let backendProc = null;
let backendSpawnedByUs = false;
let backendStartupError = null;

function isPidListeningOnPort(pid, port) {
  try {
    const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
    if (netstat.stdout) {
      return checkPortOwnerFromNetstat(netstat.stdout, pid, port);
    }
  } catch (_err) {}
  return false;
}

function cleanupOrphanBackend(port) {
  if (process.platform !== "win32") return false;
  try {
    const pidFile = path.join(app.getPath("userData"), "backend.pid");
    if (!fs.existsSync(pidFile)) {
      // 无本应用先前持久化的 PID 记录，严禁猜测性扫描并杀死端口上的未知外部进程 (5.1.1)
      return false;
    }

    let record = null;
    try {
      const raw = fs.readFileSync(pidFile, "utf8").trim();
      if (raw.startsWith("{")) {
        record = JSON.parse(raw);
      } else if (/^\d+$/.test(raw)) {
        record = { pid: parseInt(raw, 10), port };
      }
    } catch (_e) {
      return false;
    }

    if (!record || !record.pid) {
      try { fs.unlinkSync(pidFile); } catch (_e) {}
      return false;
    }

    // 端口校验：若记录指明的端口不是当前端口，不予处理
    if (record.port && record.port !== port) {
      return false;
    }

    const pid = record.pid;
    // 校验该 PID 是否依然真实存在且属于 Node/DSH 进程 (R1-2 防 PID 重用误杀)
    try {
      const ps = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -Property ProcessName, CommandLine, CreationDate | ConvertTo-Json -Compress`],
        { encoding: "utf8", windowsHide: true }
      );
      if (ps.stdout && ps.stdout.trim()) {
        const procInfo = JSON.parse(ps.stdout.trim());
        const isPortOwner = isPidListeningOnPort(pid, port);
        const identity = verifyProcessIdentity(record, procInfo, isPortOwner);

        if (identity.verified) {
          console.info(`[dsh-desktop] Cleanly terminating verified orphan backend process (PID: ${pid}, Name: ${procInfo.ProcessName}) on port ${port}...`);
          spawnSync("taskkill", ["/pid", String(pid), "/F", "/T"], { windowsHide: true });
          try { fs.unlinkSync(pidFile); } catch (_e) {}
          return true;
        } else {
          console.warn(`[dsh-desktop] Process on port ${port} (PID: ${pid}) rejected: ${identity.reason}. Refusing to kill external process; backing off to next port!`);
          try { fs.unlinkSync(pidFile); } catch (_e) {}
          return false;
        }
      }
    } catch (_e) {}

    try { fs.unlinkSync(pidFile); } catch (_e) {}
    return false;
  } catch (e) {
    console.warn("[dsh-desktop] cleanupOrphanBackend warning:", e.message);
    return false;
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
  const startTime = Date.now();
  console.info(`[dsh-desktop] Waiting for backend ready on port ${WEB_PORT} (base timeout: ${timeoutMs / 1000}s)...`);
  while (true) {
    if (backendStartupError) {
      console.warn("[dsh-desktop] Aborting waitForWeb due to early backend error:", backendStartupError);
      return false;
    }
    const hasActivation = isKernelActivationUrl(currentAuthUrl, WEB_PORT);
    const kernelAuthenticated = hasActivation || (await verifyKernelHttpReady(WEB_PORT, { requireAuthenticated: true }));
    if (kernelAuthenticated && (await httpReady(WEB_PORT))) {
      console.info(`[dsh-desktop] Backend HTTP ready on port ${WEB_PORT}!`);
      if (!currentAuthUrl) {
        currentAuthUrl = `http://127.0.0.1:${WEB_PORT}/`;
      }
      isBackendReady = true;
      backendAttempt.state = "ready";
      safeNavigateToWorkbench(currentAuthUrl).catch((err) => {
        console.warn("[dsh-desktop] safeNavigateToWorkbench from waitForWeb notice:", err.message);
      });
      return true;
    }

    const now = Date.now();
    const totalElapsed = now - startTime;
    const lastActivity = (backendProc && backendProc._lastActivity) ? backendProc._lastActivity : startTime;
    const idleElapsed = now - lastActivity;

    // 智能弹性超时规则：
    // 1. 如果总耗时已经超过了传入的基础门限（如 240s），且连续 30 秒没有任何新日志产生，断定超时；
    // 2. 如果连续 90 秒完全没有哪怕一行输出（且总耗时已过 60s），断定假死超时；
    // 3. 但只要 npm 正在持续下载（idleElapsed < 30 秒），就自动宽限并继续等待，最长允许至 360 秒（6分钟）！
    if (totalElapsed > 360_000 || (totalElapsed > timeoutMs && idleElapsed > 30_000) || (idleElapsed > 90_000 && totalElapsed > 60_000)) {
      console.warn(`[dsh-desktop] waitForWeb timed out. Total: ${Math.round(totalElapsed / 1000)}s, idle: ${Math.round(idleElapsed / 1000)}s`);
      return false;
    }

    await new Promise((r) => setTimeout(r, 500));
  }
}


function sanitizeCredentials() {
  try {
    // 1. 自动执行旧明文 .credentials.yaml 到 DPAPI 加密存储的安全迁移与安全擦除 (5.1.3)
    migratePlaintextCredentials({ userDataDir: app.getPath("userData") });
    // 2. 将解密后的所有凭据预热注入 process.env，作为最高优先级进程环境变量直达内核
    injectCredentialsIntoEnv(process.env, { userDataDir: app.getPath("userData") });
  } catch (e) {
    console.warn("[dsh-desktop] Note on sanitizeCredentials:", e.message);
  }
}

function ensureKernelCompatibilityShim() {
  try {
    const kernelInfo = resolveDshKernel();
    const kernelVer = kernelInfo.version;

    // 现代官方内核（>= 0.1.5）历史缺陷已在官方代码中修复，跳过侵入式 node_modules 字符篡改，保护鉴权与运行时原生完整性
    if (kernelVer && compareVersions(kernelVer, "0.1.5-rc.1") >= 0) {
      console.info(`[dsh-desktop] Modern official kernel v${kernelVer} detected (>= 0.1.5); skipping invasive node_modules shims.`);
      return;
    }

    console.info(`[dsh-desktop] Legacy kernel v${kernelVer || "unknown"} detected (< 0.1.5); checking defensive compatibility shims...`);
    const nodeBin = resolveNode();
    const candidateDirs = [
      nodeBin ? path.join(path.dirname(nodeBin), "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai") : null,
      nodeBin ? path.join(path.dirname(nodeBin), "node_modules", "@deepseek-ai") : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai") : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai") : null,
      path.join(getWebProfileDir("web"), "node_modules", "@deepseek-ai")
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
  } catch (err) {
    console.warn("[dsh-desktop] Note on kernel shim check:", err.message);
  }
}

let isFallbackLaunch = false;

// ---------------------------------------------------------------------------
// Backend Lifecycle State Machine: Attempt Model (IMPLEMENT.md 5.2.1)
// ---------------------------------------------------------------------------
const backendAttempt = {
  id: 0,
  state: "idle", // 'idle' | 'spawning' | 'ready' | 'failed' | 'fallback'
  isFallback: false,
};

function handleBackendFailure(attemptId, exitCode, errorMsg, recentStderr, options, dshBin) {
  if (attemptId !== backendAttempt.id) {
    console.info(`[dsh-desktop] Ignoring exit/error from obsolete attempt #${attemptId}`);
    return;
  }
  backendProc = null;
  if (isQuitting) return;

  let cleanStderr = (recentStderr || "").trim();
  if (cleanStderr.length > 900) {
    const head = cleanStderr.slice(0, 450);
    const tail = cleanStderr.slice(-450);
    cleanStderr = `${head}\n\n...[省略中间日志]...\n\n${tail}`;
  }

  const failureDetail = errorMsg
    ? `后台子进程启动失败: ${errorMsg}`
    : `后台内核进程异常退出 (Exit Code: ${exitCode})${cleanStderr ? `\n\n终端输出详情:\n${cleanStderr}` : ""}`;

  backendStartupError = failureDetail;
  backendAttempt.state = "failed";

  // 核心容灾降级：若使用外部已安装新内核启动失败（如插件冲突/依赖损坏），且尚未尝试过内置稳定内核，自动无感回退拉起内置内核
  if (!options.forceBundled && !backendAttempt.isFallback && !isBackendReady && !isQuitting) {
    const bundled = resolveBundledKernel();
    if (bundled.path && bundled.path !== dshBin) {
      console.warn(`[dsh-desktop] Active kernel failed (${errorMsg || `code ${exitCode}`}). Initiating graceful fallback to bundled kernel v${bundled.version || "0.1.2"}...`);
      backendAttempt.isFallback = true;
      isFallbackLaunch = true;
      backendStartupError = null; // 重置错误状态以允许 waitForWeb 继续轮询
      updateSplashStatus("检测到外部环境插件异常，正在自动回退至内置稳定内核...");
      setTimeout(() => {
        if (!isQuitting) {
          spawnBackend({ forceBundled: true });
        }
      }, 600);
      return;
    }
  }

  try {
    const pidFile = getPidFilePath(app.getPath("userData"));
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch (_e) {}
}

function getInstalledPluginVersion(profileDir, pluginName) {
  try {
    const pkgPath = path.join(profileDir, "node_modules", ...pluginName.split("/"), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return pkg.version || null;
    }
  } catch {}
  return null;
}

function sanitizeWebProfile(targetKernelVer) {
  const webProfileDir = getWebProfileDir("web");
  const sidebarVer = getInstalledPluginVersion(webProfileDir, "dsh-better-sidebar");
  // 仅当安装的是 < 0.21.0 的旧版（且在 0.1.7-rc.2+ 内核）才执行防崩隔离；
  // 现代适配版（>= 0.21.0）已原生兼容新内核，必须安全放行并执行可逆恢复！(R1-5)
  const isOldSidebar = sidebarVer ? compareVersions(sidebarVer, "0.21.0") < 0 : false;
  const isExcluded = targetKernelVer && compareVersions(targetKernelVer, "0.1.7-rc.2") >= 0 && isOldSidebar;
  const excludeBundles = isExcluded ? ["dsh-better-sidebar"] : [];
  const restoreBundles = (!isOldSidebar && sidebarVer) ? ["dsh-better-sidebar"] : [];
  sanitizeWebProfileUtil(webProfileDir, { kernelVersion: targetKernelVer, excludeBundles, restoreBundles });
}

function spawnBackend(options = {}) {
  const kernelInfo = options.forceBundled
    ? resolveBundledKernel()
    : resolveDshKernel();

  if (!options.forceBundled) {
    backendAttempt.id++;
    backendAttempt.state = "spawning";
    backendAttempt.isFallback = false;
    isFallbackLaunch = false;
  } else {
    backendAttempt.state = "fallback";
    backendAttempt.isFallback = true;
    isFallbackLaunch = true;
  }

  const thisAttemptId = backendAttempt.id;
  isBackendReady = false;
  currentAuthUrl = null;
  backendStartupError = null;

  sanitizeCredentials();
  ensureKernelCompatibilityShim();
  sanitizeWebProfile(kernelInfo.version);
  const cwd = process.env.DSH_WORKSPACE || app.getPath("home");
  ensureNodeInPath();
  const env = { ...process.env };
  if (process.env.DSH_HOME) env.DSH_HOME = process.env.DSH_HOME;
  env.DSH_BUNDLED_SKILL_DIR = getSkillsDir();

  // 全局网络兼容垫片：同步写入到 DSH_HOME/network-shim.js (5.2.5 统一数据根目录)
  let activeShimPath = null;
  try {
    const dshDir = resolveDshHome();
    if (!fs.existsSync(dshDir)) fs.mkdirSync(dshDir, { recursive: true });
    const targetShim = getNetworkShimPath();

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
    console.warn("[dsh-desktop] Failed to sync network-shim to DSH_HOME:", err.message);
  }

  const nodeBin = resolveNode();
  const dshBin = kernelInfo.path;
  let child;

  console.info(`[dsh-desktop] Starting DSH Web Kernel v${kernelInfo.version || "unknown"} (source: ${kernelInfo.source}) on port ${WEB_PORT} from: ${dshBin}`);
  console.info("[dsh-desktop] nodeBin:", nodeBin, "dshBin:", dshBin);

  env.PORT = String(WEB_PORT);
  env.DSH_PORT = String(WEB_PORT);
  env.HOST = "127.0.0.1";
  env.DSH_HOST = "127.0.0.1";
  env.DSH_DESKTOP_MANAGED = "1"; // 激活 network-shim 孤儿进程看门狗自毁机制
  env.DSH_DESKTOP_MAIN_PID = String(process.pid); // 绑定主进程 PID，用于精准孤儿探测与脱壳防误杀
  // 强制显式绑定回环地址 127.0.0.1 (P0-3)，消除局域网暴露与 Windows 防火墙授权弹窗
  const hostAndPortArgs = ["--host", "127.0.0.1", "--port", String(WEB_PORT)];

  if (dshBin && /\.cmd$/i.test(dshBin)) {
    child = spawn(dshBin, ["web", "--no-open", ...hostAndPortArgs], { cwd, env, stdio: "pipe", windowsHide: true, shell: true });
  } else if (dshBin) {
    if (nodeBin === process.execPath) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    const nodeArgs = activeShimPath
      ? ["-r", activeShimPath, dshBin, "web", "--no-open", ...hostAndPortArgs]
      : [dshBin, "web", "--no-open", ...hostAndPortArgs];
    child = spawn(nodeBin, nodeArgs, {
      cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
    });
  } else {
    const npxBin = resolveNpx();
    env.npm_config_registry = "https://registry.npmmirror.com";
    console.info(`[dsh-desktop] Invoking npx fallback via: ${npxBin} with npmmirror registry...`);
    child = spawn(
      npxBin,
      ["--registry=https://registry.npmmirror.com", "-y", "@deepseek-ai/dsh@latest", "web", "--no-open", ...hostAndPortArgs],
      { cwd, env, stdio: "pipe", windowsHide: true, shell: true }
    );
  }

  let recentStderr = "";
  child._lastActivity = Date.now();

  if (child.stdout) {
    child.stdout.on("data", (data) => {
      child._lastActivity = Date.now();
      const str = data.toString().trim();
      if (str) {
        console.info("[DSH Kernel]", str);
        const match = str.match(/dsh web:\s+(http:\/\/[^\s]+)/i);
        if (match && match[1]) {
          if (thisAttemptId === backendAttempt.id) {
            currentAuthUrl = match[1].trim();
            isBackendReady = true;
            backendAttempt.state = "ready";
            console.info("[dsh-desktop] Captured Kernel Auth URL:", currentAuthUrl);
            safeNavigateToWorkbench(currentAuthUrl).catch((err) => {
              console.warn("[dsh-desktop] safeNavigateToWorkbench from stdout notice:", err.message);
            });
          }
        } else if (str.includes("added ") || str.includes("packages in")) {
          updateSplashStatus("微内核组件安装完成，正在拉起服务...");
        } else if (str.includes("Cordis") || str.includes("profile") || str.includes("Starting")) {
          updateSplashStatus("正在装配本地微服务与插件运行环境...");
        }
      }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (data) => {
      child._lastActivity = Date.now();
      const str = data.toString();
      recentStderr += str;
      if (recentStderr.length > 3000) recentStderr = recentStderr.slice(-3000);
      const trimmed = str.trim();
      if (trimmed) {
        console.warn("[DSH Kernel Log]", trimmed);
        if (trimmed.includes("npm") || trimmed.includes("FETCH") || trimmed.includes("registry.npmmirror.com")) {
          updateSplashStatus("正在通过官方镜像源加速下载核心组件...");
        } else if (trimmed.includes("extract")) {
          updateSplashStatus("正在解压微内核组件运行库...");
        }
      }
    });
  }

  child.on("error", (err) => {
    console.error("[dsh-desktop] Failed to spawn DSH Backend child process:", err);
    handleBackendFailure(thisAttemptId, null, err.message, recentStderr, options, dshBin);
  });

  backendSpawnedByUs = true;
  backendProc = child;

  // 持久化记录子进程 PID 结构化身份签名 (5.1.1)
  try {
    const pidFile = getPidFilePath(app.getPath("userData"));
    if (child.pid) {
      const record = {
        pid: child.pid,
        port: WEB_PORT,
        startTime: Date.now(),
        managed: "dsh-desktop",
        commandLineSnippet: String(dshBin || "dsh"),
      };
      fs.writeFileSync(pidFile, JSON.stringify(record, null, 2), "utf8");
    }
  } catch (_e) {}

  child.on("exit", (code) => {
    console.info("[dsh-desktop] DSH Backend exited with code:", code);
    if (recentStderr) {
      console.error("[dsh-desktop] DSH Backend stderr:\n" + recentStderr);
    }
    if (code !== 0 && code !== null) {
      handleBackendFailure(thisAttemptId, code, null, recentStderr, options, dshBin);
    } else {
      backendProc = null;
      try {
        const pidFile = getPidFilePath(app.getPath("userData"));
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      } catch (_e) {}
    }
  });
  return child;
}

function stopBackendIfOurs() {
  try {
    const pidFile = getPidFilePath(app.getPath("userData"));
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
    workbenchLoaded = false;
    stopBackendIfOurs();
    backendStartupError = null;
    isBackendReady = false;
    isFallbackLaunch = false;
    currentAuthUrl = null;
    backendAttempt.state = "idle";
    backendAttempt.isFallback = false;

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
      await safeNavigateToWorkbench(currentAuthUrl || WEB_URL, { force: true });
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
ipcMain.handle("restart-backend-service", async (_event) => {
  if (!isTrustedSender(_event)) {
    return { success: false, error: "拒绝非受信任的渲染源调用安全 IPC (5.2.7)" };
  }
  console.info("[dsh-desktop] Triggering native restart of DSH Backend...");
  return await restartBackendService();
});

// 渲染帧来源安全核验 (5.2.7 & 5.2.4)：仅允许应用当前回环端口工作台或本地内部打包 file: 资源调用敏感 IPC (CODE_REVIEW 边界加固)
function isTrustedSender(event) {
  if (!event || !event.senderFrame) return false;
  const origin = event.senderFrame.url;
  if (!origin) return false;
  try {
    const u = new URL(origin);
    // 1. 本地回环工作台端口受信任
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && Number(u.port) === WEB_PORT) {
      return true;
    }
    // 2. 本地文件协议：严格限制只能来源于应用安装根目录或打包资源目录内部，拒绝外部任意本地 HTML 与同名前缀目录绕过 (CODE_REVIEW 深度加固)
    if (u.protocol === "file:") {
      const pathname = decodeURIComponent(u.pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
      const normalizedFile = path.resolve(path.normalize(pathname)).toLowerCase();
      const appRoot = path.resolve(path.normalize(app.getAppPath())).toLowerCase();
      const resPath = path.resolve(path.normalize(process.resourcesPath || appRoot)).toLowerCase();

      const isSubPath = (child, parent) => {
        const rel = path.relative(parent, child);
        return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
      };

      return isSubPath(normalizedFile, appRoot) || isSubPath(normalizedFile, resPath);
    }
  } catch (_e) {}
  return false;
}

ipcMain.handle("uninstall-plugin", async (_event, pluginName) => {
  if (!isTrustedSender(_event)) {
    return { success: false, error: "拒绝非受信任的渲染源调用安全 IPC (5.2.7)" };
  }
  if (!pluginName || typeof pluginName !== "string") {
    return { success: false, error: "插件名称无效" };
  }
  console.info(`[dsh-desktop] Triggering native clean uninstall of plugin: ${pluginName}`);
  try {
    const profileDir = getWebProfileDir("web");
    stopBackendIfOurs();
    const uninstallRes = uninstallPluginFromWebProfile(profileDir, pluginName);
    await restartBackendService();
    return uninstallRes;
  } catch (err) {
    console.error(`[dsh-desktop] Clean uninstall failed for ${pluginName}:`, err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("get-app-info", () => {
  const kernelInfo = resolveDshKernel();
  const kernelVer = kernelInfo.version || "unknown";
  const isEncAvailable = safeStorage ? safeStorage.isEncryptionAvailable() : false;
  return {
    version: app.getVersion(),
    name: "DSH Desktop",
    kernelVersion: kernelVer,
    kernelPath: kernelInfo.path,
    kernelSource: kernelInfo.source,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    port: WEB_PORT,
    activeUrl: currentAuthUrl || WEB_URL,
    secureStorageAvailable: isEncAvailable,
    diagnosticText: `DSH Desktop v${app.getVersion()} | Kernel: v${kernelVer} (${kernelInfo.source || "unknown"}) | Path: ${kernelInfo.path || "none"} | Electron: ${process.versions.electron} | Node: ${process.versions.node} | Port: ${WEB_PORT} | Platform: ${process.platform}-${process.arch}`,
  };
});

// ---------------------------------------------------------------------------
// Native DPAPI SafeStorage for Sensitive Keys & Credentials (P0-2, 5.1.3)
// ---------------------------------------------------------------------------
ipcMain.handle("secure-encrypt", async (_event, plainText) => {
  if (!isTrustedSender(_event)) {
    throw new Error("拒绝非受信任的渲染源调用安全 IPC (5.2.7)");
  }
  if (!plainText) return "";
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    const buffer = safeStorage.encryptString(plainText);
    return buffer.toString("base64");
  }
  throw new Error("safeStorage encryption unavailable; plaintext fallback refused (5.1.3)");
});

ipcMain.handle("secure-decrypt", async (_event, cipherBase64) => {
  if (!isTrustedSender(_event)) {
    throw new Error("拒绝非受信任的渲染源调用安全 IPC (5.2.7)");
  }
  if (!cipherBase64) return "";
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    const buffer = Buffer.from(cipherBase64, "base64");
    return safeStorage.decryptString(buffer);
  }
  throw new Error("safeStorage decryption unavailable");
});

ipcMain.handle("save-credentials", async (_event, credentialsMap) => {
  if (!isTrustedSender(_event)) {
    return { success: false, error: "拒绝非受信任的渲染源调用安全 IPC (5.2.7)" };
  }
  try {
    const res = saveCredentials(credentialsMap, { userDataDir: app.getPath("userData") });
    for (const [k, v] of Object.entries(credentialsMap || {})) {
      if (v) process.env[k] = v;
      else delete process.env[k];
    }
    return { success: true, count: res.count };
  } catch (err) {
    console.error("[dsh-desktop] Failed to save credentials:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("get-credentials", async (_event, envKey) => {
  if (!isTrustedSender(_event)) {
    return "";
  }
  // 最小权限与脱敏原则 (R0-1)：仅允许按单个环境变量键名精确查询，严禁无参数返回包含所有敏感明文凭据的字典
  if (!envKey || typeof envKey !== "string") {
    return "";
  }
  try {
    const all = loadCredentials({ userDataDir: app.getPath("userData") });
    return all[envKey] || "";
  } catch (_err) {
    return "";
  }
});


ipcMain.handle("is-secure-storage-available", () => {
  return safeStorage ? safeStorage.isEncryptionAvailable() : false;
});

ipcMain.handle("check-for-updates-manual", () => {
  checkForUpdates(false);
  return { success: true };
});

ipcMain.handle("check-for-kernel-updates-manual", (_event, channel = "latest") => {
  checkForKernelUpdates(false, channel);
  return { success: true };
});

ipcMain.handle("upgrade-kernel-manual", async (_event, targetVersion = "latest", channel = "latest") => {
  if (!isTrustedSender(_event)) {
    return { success: false, error: "拒绝非受信任的渲染源调用安全 IPC (5.2.7)" };
  }
  return await upgradeKernel(targetVersion, channel);
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
      getSkillsDir(),
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
            safeNavigateToWorkbench(currentAuthUrl || WEB_URL, { force: true });
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

// ---------------------------------------------------------------------------
// High-Fidelity Splash Screen & Loading Flow (Zero extra disk footprint)
// ---------------------------------------------------------------------------
let isBackendReady = false;

function getSplashHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>DSH Desktop</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 25%, #ffffff 0%, #f8fafc 45%, #e2e8f0 100%);
      color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      user-select: none;
      overflow: hidden;
      position: relative;
    }
    .ambient-glow {
      position: absolute;
      width: 480px;
      height: 480px;
      background: radial-gradient(circle, rgba(56, 189, 248, 0.12) 0%, rgba(99, 102, 241, 0.05) 50%, transparent 70%);
      filter: blur(60px);
      pointer-events: none;
      z-index: 0;
    }
    .card {
      position: relative;
      z-index: 1;
      background: rgba(255, 255, 255, 0.94);
      border: 1px solid rgba(226, 232, 240, 0.9);
      backdrop-filter: blur(24px);
      padding: 44px 48px 36px;
      border-radius: 26px;
      box-shadow: 0 20px 45px -10px rgba(15, 23, 42, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.03), 0 2px 4px rgba(0, 0, 0, 0.02);
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      max-width: 480px;
      width: 90%;
    }
    .logo-container {
      position: relative;
      width: 86px;
      height: 86px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .spinner-track {
      position: absolute;
      inset: -5px;
      border-radius: 50%;
      border: 2.5px solid #e0f2fe;
    }
    .spinner-ring {
      position: absolute;
      inset: -5px;
      border-radius: 50%;
      border: 2.5px solid transparent;
      border-top-color: #0284c7;
      border-right-color: #38bdf8;
      animation: spin 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .logo-badge {
      width: 76px;
      height: 76px;
      background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 20px -4px rgba(2, 132, 199, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.06);
    }
    .whale-svg {
      width: 48px;
      height: 48px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    h1 {
      font-size: 23px;
      font-weight: 700;
      letter-spacing: -0.025em;
      color: #0f172a;
    }
    .version-tag {
      font-size: 11px;
      font-weight: 600;
      color: #0284c7;
      background: #e0f2fe;
      padding: 2px 7px;
      border-radius: 6px;
      letter-spacing: 0.02em;
    }
    .progress-track {
      width: 100%;
      height: 4px;
      background: #f1f5f9;
      border-radius: 9999px;
      overflow: hidden;
      margin: 14px 0 12px;
      position: relative;
    }
    .progress-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 40%;
      background: linear-gradient(90deg, transparent, #0284c7, #38bdf8, transparent);
      border-radius: 9999px;
      animation: streamProgress 1.6s ease-in-out infinite;
    }
    @keyframes streamProgress {
      0% { left: -40%; width: 35%; }
      50% { width: 50%; }
      100% { left: 100%; width: 35%; }
    }
    .status-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      margin-bottom: 10px;
      min-height: 22px;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #0284c7;
      box-shadow: 0 0 8px rgba(2, 132, 199, 0.6);
      animation: pulse 1.5s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.6; }
    }
    .status {
      font-size: 13.5px;
      color: #0284c7;
      font-weight: 600;
      letter-spacing: -0.01em;
      transition: all 0.25s ease;
    }
    .subtext {
      font-size: 12px;
      color: #64748b;
      line-height: 1.65;
    }
    .badge-list {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 20px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 500;
      color: #0369a1;
    }
  </style>
</head>
<body>
  <div class="ambient-glow"></div>
  <div class="card">
    <div class="logo-container">
      <div class="spinner-track"></div>
      <div class="spinner-ring"></div>
      <div class="logo-badge">
        <svg class="whale-svg" viewBox="0 0 50 50">
          <path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#111827"/>
        </svg>
      </div>
    </div>
    <div class="title-row">
      <h1>DSH Desktop</h1>
      <span class="version-tag">v${app.getVersion()}</span>
    </div>
    <div class="progress-track">
      <div class="progress-bar"></div>
    </div>
    <div class="status-wrap">
      <div class="pulse-dot"></div>
      <div class="status" id="statusText">正在启动核心引擎服务...</div>
    </div>
    <div class="subtext">
      正在准备微内核运行环境与本地工作空间<br>
      初始化服务即将就绪，请稍候...
    </div>
    <div class="badge-list">
      <div class="badge">⚡ 官方 npmmirror 淘宝镜像加速已开启</div>
      <div class="badge">🛡️ 127.0.0.1 本地回环安全隔离</div>
    </div>
  </div>
</body>
</html>`;
}

function getSplashDataUrl() {
  return "data:text/html;charset=utf-8," + encodeURIComponent(getSplashHtml());
}

function getErrorHtml(title, message, detail) {
  const safeTitle = (title || "启动异常").replace(/</g, "&lt;");
  const safeMsg = (message || "").replace(/</g, "&lt;");
  const safeDetail = (detail || "").replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>DSH Desktop - 启动诊断控制台</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 25%, #ffffff 0%, #f8fafc 45%, #fee2e2 100%);
      color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      user-select: none;
    }
    .card {
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(254, 202, 202, 0.9);
      padding: 36px 40px;
      border-radius: 22px;
      box-shadow: 0 25px 50px -12px rgba(239, 68, 68, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.04);
      max-width: 680px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    h2 { font-size: 18px; color: #dc2626; display: flex; align-items: center; gap: 8px; }
    .desc { font-size: 13px; color: #475569; line-height: 1.6; user-select: text; }
    .log-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 12px 14px;
      font-family: Consolas, monospace;
      font-size: 11px;
      color: #334155;
      max-height: 160px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      user-select: text;
    }
    .btn-group { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
    button {
      padding: 9px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .btn-primary { background: #0284c7; color: #fff; }
    .btn-primary:hover { background: #0369a1; }
    .btn-secondary { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    .btn-secondary:hover { background: #e2e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>⚠️ ${safeTitle}</h2>
    <div class="desc">${safeMsg}</div>
    ${safeDetail ? `<div class="log-box">${safeDetail}</div>` : ""}
    <div class="btn-group">
      <button class="btn-primary" onclick="location.reload()">🔄 重新尝试启动</button>
      <button class="btn-secondary" onclick="navigator.clipboard.writeText(document.querySelector('.log-box')?.innerText || ''); alert('诊断日志已复制到剪贴板！')">📋 复制诊断日志</button>
    </div>
  </div>
</body>
</html>`;
}

function getErrorDataUrl(title, message, detail) {
  return "data:text/html;charset=utf-8," + encodeURIComponent(getErrorHtml(title, message, detail));
}


function updateSplashStatus(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      try {
        const el = document.getElementById("statusText");
        if (el) el.innerText = ${JSON.stringify(text)};
      } catch (_e) {}
    `).catch(() => {});
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
    show: false, // 初始静默隐藏，消除突兀居中 Splash 等待大卡片
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
    },
  });

  // 延时兜底定时器：若 2.5 秒后尚未完成载入（例如初次联网下载），才展示窗口与进度
  let splashFallbackTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !workbenchLoaded) {
      mainWindow.show();
    }
  }, 2500);

  mainWindow.once("ready-to-show", () => {
    if (workbenchLoaded) {
      if (splashFallbackTimer) clearTimeout(splashFallbackTimer);
      mainWindow.show();
    }
  });

  mainWindow.on("close", (event) => {
    // 托盘常驻产品语义：若非显式退出指令，点击窗口右上角 X 时隐藏到托盘保活 (5.3.3)
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on("closed", () => {
    if (splashFallbackTimer) clearTimeout(splashFallbackTimer);
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

  if (isBackendReady) {
    safeNavigateToWorkbench(currentAuthUrl || WEB_URL);
  } else {
    mainWindow.loadURL(getSplashDataUrl());
  }

  // 错峰静默检查更新：仅在工作台正式载入后触发
  mainWindow.webContents.on("did-finish-load", () => {
    const loadedUrl = mainWindow.webContents.getURL();
    // 严格特征校验：仅当真正载入当前回环端口的工作台时才标记就绪 (R1-3)
    const isTargetWorkbench = loadedUrl && (
      loadedUrl.startsWith(`http://127.0.0.1:${WEB_PORT}`) ||
      loadedUrl.startsWith(`http://localhost:${WEB_PORT}`)
    );
    if (isTargetWorkbench) {
      workbenchLoaded = true;
      if (splashFallbackTimer) clearTimeout(splashFallbackTimer);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
      }
      setTimeout(() => { checkForUpdates(true); }, 5000);
      setTimeout(() => { if (!isDownloadingUpdate) checkForKernelUpdates(true); }, 10000);
    }
  });

  // Test hook: DSH_DESKTOP_TEST=1
  if (process.env.DSH_DESKTOP_TEST === "1") {
    const logPath = process.env.DSH_DESKTOP_TEST_LOG || path.join(app.getPath("temp"), "dsh-desktop-test.log");
    const log = (msg) => { try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`); } catch (_e) { /* ignore */ } };
    log(`createWindow: loading ${WEB_URL}`);
    mainWindow.webContents.on("did-finish-load", () => {
      const loadedUrl = mainWindow.webContents.getURL();
      if (!loadedUrl || loadedUrl.startsWith("data:")) return;
      workbenchLoaded = true;
      log(`did-finish-load: ${loadedUrl}`);
      const marker = process.env.DSH_DESKTOP_TEST_MARKER || path.join(app.getPath("temp"), "dsh-desktop-test-ok.txt");
      try { fs.writeFileSync(marker, `loaded ${mainWindow.webContents.getURL()} at ${new Date().toISOString()}`); } catch (e) { log(`marker write error: ${e.message}`); }
      setTimeout(() => { app.quit(); }, 500);
    });
    mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
      if (code === -3) {
        log(`did-fail-load (aborted): code=${code} desc=${desc}`);
        return;
      }
      log(`did-fail-load: code=${code} desc=${desc}`);
      const marker = process.env.DSH_DESKTOP_TEST_MARKER || path.join(app.getPath("temp"), "dsh-desktop-test-ok.txt");
      try { fs.writeFileSync(marker, `FAIL ${code}: ${desc}`); } catch (e) { log(`marker write error: ${e.message}`); }
      setTimeout(() => { app.quit(); }, 500);
    });
  } else {
    // 生产环境：后端连接失败自动有限次重连自愈 (全部走 safeNavigateToWorkbench 互斥队列 - R1-3)
    let loadRetryCount = 0;
    mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
      console.warn(`[dsh-desktop] did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
      if ([-102, -105, -106, -118].includes(errorCode)) { // 典型网络未就绪/拒绝连接
        if (loadRetryCount < 5) {
          loadRetryCount++;
          console.info(`[dsh-desktop] Backend initializing... auto retrying connection (${loadRetryCount}/5) in 1.5s...`);
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              safeNavigateToWorkbench(currentAuthUrl || WEB_URL);
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

    // 注入纵深防御 CSP 响应头策略 (P3-3 & 5.2.7 彻底移除 unsafe-eval)
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      if (details.resourceType === "mainFrame") {
        responseHeaders["Content-Security-Policy"] = [
          "default-src 'self' http://127.0.0.1:* http://localhost:* data: blob:; " +
          "script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*; " +
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

  // 1. 前置依赖断言：若宿主机完全未安装 Node.js 且无可用 DSH 内核，首秒友好弹窗拦截引导 (Fail-Fast)
  if (!hasNodeInstalled() && !resolveDshBin()) {
    console.warn("[dsh-desktop] Missing Node.js environment on host machine. Prompting user to install.");
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "缺少 Node.js 运行环境",
      message: "检测到当前电脑尚未安装 Node.js 环境。\n\nDSH Desktop 需要依赖 Node.js 运行官方微内核。请前往 Node.js 官网下载并完成安装（推荐选择 LTS 版本）后，重新打开本应用。",
      buttons: ["前往官网下载 Node.js", "退出应用"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      shell.openExternal("https://nodejs.org/");
    }
    app.quit();
    return;
  }

  // 端口动态协商与漂移预检：若 3080 被占用且不可回收，自动向上漂移寻找空闲端口 (P0-1)
  try {
    await acquirePort(3080, 10);
  } catch (err) {
    console.error("[dsh-desktop] Failed to acquire port:", err);
  }

  // 立即创建并展示窗口（展示内置质感 Loading 屏），彻底告别新机器启动时的黑盒等待
  createWindow();

  console.info(`[dsh-desktop] Spawning clean DSH Web Backend on port ${WEB_PORT} with network shim...`);
  spawnBackend();
  const started = await waitForWeb(STARTUP_TIMEOUT_MS);

  if (!started) {
    const errorDetail = backendStartupError
      ? `\n\n【诊断错误详情】\n${backendStartupError}`
      : `\n\n排查建议：\n1. 请确认电脑已安装 Node.js（推荐 v20 或 v22 LTS）\n2. 检查网络是否能正常访问 npm 镜像源（已默认开启 npmmirror 淘宝镜像加速）\n3. 检查是否有本地防火墙或安全杀毒软件拦截了 127.0.0.1 端口通信`;

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.loadURL(getErrorDataUrl("微内核引擎服务未能启动", "无法在预定时间内完成后端初始化，系统已自动收集底层诊断日志：", errorDetail)).catch(() => {});
    }

    dialog.showErrorBox(
      "DSH Desktop 启动失败",
      `无法在预定时间内完成后端初始化（${WEB_URL}）。${errorDetail}`
    );
    return;
  }

  // 后端就绪：统一通过原子幂等控制器平滑载入正式工作台
  safeNavigateToWorkbench(currentAuthUrl || WEB_URL);

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
  // 托盘常驻产品语义：仅当用户通过托盘菜单或快捷键显式退出时才终止进程 (5.3.3)
  if (isQuitting) {
    cleanupClipboardTemp();
    stopBackendIfOurs();
    app.quit();
  }
});

process.on("exit", () => {
  cleanupClipboardTemp();
  stopBackendIfOurs();
});
