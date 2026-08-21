
// ---------------------------------------------------------------------------
// Shield window.__ModuleLoader__ against duplicate registration fatal crashes
// ---------------------------------------------------------------------------
try {
  let _moduleLoader = undefined;
  Object.defineProperty(window, "__ModuleLoader__", {
    get() {
      return _moduleLoader;
    },
    set(loader) {
      if (loader && typeof loader.load === "function") {
        const originalLoad = loader.load;
        loader.load = function(handoff) {
          try {
            originalLoad.call(this, handoff);
          } catch (err) {
            // 优雅容错：如果是重复注册错误，直接更新 factory，绝不抛出阻断异常
            if (this.factories && handoff && handoff.id) {
              this.factories.set(handoff.id, handoff.factory);
            }
          }
        };
      }
      _moduleLoader = loader;
    },
    configurable: true,
    enumerable: true
  });
} catch { /* ignore */ }

const { ipcRenderer } = require("electron");

function insertPathText(filePath) {
  if (!filePath) return;
  const activeEl = document.activeElement;
  const target = activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT")
    ? activeEl
    : document.querySelector("textarea, input[type='text']");

  if (target) {
    target.focus();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, filePath + " ");
    } catch {
      inserted = false;
    }
    if (!inserted) {
      const proto = target.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(target, (target.value ? target.value + " " : "") + filePath + " ");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
}

// 拦截剪贴板截图粘贴（配合 ModLens / 视觉插件）
window.addEventListener(
  "paste",
  async (event) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    let imageFile = null;
    if (clipboardData.files && clipboardData.files.length > 0) {
      for (let i = 0; i < clipboardData.files.length; i++) {
        const file = clipboardData.files[i];
        if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
          imageFile = file;
          break;
        }
      }
    }

    if (!imageFile && clipboardData.items) {
      for (let i = 0; i < clipboardData.items.length; i++) {
        const item = clipboardData.items[i];
        if (item.type.startsWith("image/")) {
          imageFile = item.getAsFile();
          if (imageFile) break;
        }
      }
    }

    if (imageFile) {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        const arrayBuffer = await imageFile.arrayBuffer();
        const ext = imageFile.type === "image/jpeg" ? ".jpg" : (imageFile.type === "image/webp" ? ".webp" : ".png");
        const filePath = await ipcRenderer.invoke("save-paste-image", {
          buffer: Array.from(new Uint8Array(arrayBuffer)),
          ext,
        });
        insertPathText(filePath);
      } catch (err) {
        console.error("[dsh-desktop] paste image failed:", err);
      }
    }
  },
  true
);

// ---------------------------------------------------------------------------
// Native Desktop Hook: Enable "立即重启" button in dshmarket & trigger IPC restart
// ---------------------------------------------------------------------------
function scanAndEnableRestartButtons() {
  const buttons = document.querySelectorAll("button, [role='button'], a");
  buttons.forEach((el) => {
    const text = (el.textContent || el.innerText || "").trim();
    if (text.includes("立即重启") || text === "重启" || text.includes("重启后生效")) {
      if (el.dataset.dshRestartHooked) return;
      el.dataset.dshRestartHooked = "true";

      // 解除禁用属性与禁用样式
      if (el.hasAttribute("disabled")) el.removeAttribute("disabled");
      el.disabled = false;
      el.style.pointerEvents = "auto";
      el.style.cursor = "pointer";
      el.style.opacity = "1";
      el.style.backgroundColor = "var(--primary-color, #1a73e8)";
      el.style.color = "#ffffff";
      el.style.transition = "all 0.2s ease";
      el.title = "⚡ 点击将在 DSH Desktop 桌面端立即重启后台服务并使变更生效";

      // 绑定桌面端原生重启事件
      el.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const originalText = el.innerText;
        el.innerText = "⚡ 正在重启 DSH 服务...";
        el.disabled = true;
        el.style.opacity = "0.7";
        el.style.cursor = "wait";

        try {
          const res = await ipcRenderer.invoke("restart-backend-service");
          if (!res || !res.success) {
            el.innerText = "❌ 重启失败，点击重试";
            el.disabled = false;
            el.style.opacity = "1";
            el.style.cursor = "pointer";
            if (res && res.error) alert("重启服务遇到异常: " + res.error);
          }
        } catch (err) {
          el.innerText = "❌ 重启失败，点击重试";
          el.disabled = false;
          el.style.opacity = "1";
          el.style.cursor = "pointer";
          alert("调用重启失败: " + err.message);
        }
      }, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Native Desktop Hook: Inject "关于 DSH Desktop" into Settings Modal
// ---------------------------------------------------------------------------
let cachedAppInfo = { version: "1.1.4", kernelVersion: "0.1.0-rc.8" };
ipcRenderer.invoke("get-app-info").then((info) => {
  if (info) cachedAppInfo = info;
}).catch(() => {});

function showAboutModal() {
  let existingModal = document.getElementById("dsh-desktop-about-modal-overlay");
  if (existingModal) {
    existingModal.style.display = "flex";
    return;
  }

  const isDark = document.documentElement.classList.contains("dark") || 
                 document.body.classList.contains("dark") || 
                 window.matchMedia("(prefers-color-scheme: dark)").matches;

  const overlay = document.createElement("div");
  overlay.id = "dsh-desktop-about-modal-overlay";
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    z-index: 999999;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: dshFadeIn 0.15s ease-out;
  `;

  const cardBg = isDark ? "#1e293b" : "#ffffff";
  const textColor = isDark ? "#f8fafc" : "#0f172a";
  const borderColor = isDark ? "#334155" : "#e2e8f0";
  const itemBg = isDark ? "#0f172a" : "#f8fafc";

  overlay.innerHTML = `
    <style>
      @keyframes dshFadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes dshScaleUp { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    </style>
    <div id="dsh-desktop-about-card" style="
      width: 520px;
      max-width: 90vw;
      max-height: 85vh;
      background: ${cardBg};
      color: ${textColor};
      border: 1px solid ${borderColor};
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      box-sizing: border-box;
      animation: dshScaleUp 0.15s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    ">
      <!-- 头部：图标、标题、版本号、关闭按钮 -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid ${borderColor};">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div style="width: 48px; height: 48px; border-radius: 12px; background: #0f172a; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.15);">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM13 17H11V15H13V17ZM13 13H11V7H13V13Z" fill="#38bdf8"/>
            </svg>
          </div>
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <h3 style="margin: 0; font-size: 18px; font-weight: 700; color: inherit;">DSH Desktop</h3>
              <span style="font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 9999px; background: #10b981; color: #ffffff;">v${cachedAppInfo.version}</span>
            </div>
            <p style="margin: 3px 0 0 0; font-size: 12px; opacity: 0.7;">DeepSeek Harness 桌面客户端工作台</p>
          </div>
        </div>
        <button id="dsh-modal-close-btn" style="background: none; border: none; font-size: 18px; cursor: pointer; color: inherit; opacity: 0.6; padding: 4px 8px; border-radius: 6px; transition: all 0.2s;" title="关闭">✕</button>
      </div>

      <!-- 核心操作区：检查更新 -->
      <div style="background: ${itemBg}; border: 1px solid ${borderColor}; border-radius: 12px; padding: 16px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
        <div>
          <div style="font-weight: 600; font-size: 13px;">软件更新状态</div>
          <div style="font-size: 12px; opacity: 0.7;">支持在应用内一键下载更新包并覆盖安装</div>
        </div>
        <button id="dsh-modal-check-update-btn" style="
          padding: 8px 16px;
          background: #2563eb;
          color: #ffffff;
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          box-shadow: 0 2px 6px rgba(37,99,235,0.25);
          transition: opacity 0.2s;
        ">
          <span>🔍 检查更新...</span>
        </button>
      </div>

      <!-- 核心特性与亮点 -->
      <div style="margin-bottom: 20px;">
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">🌟 核心特性</div>
        <div style="display: grid; gap: 8px; font-size: 12px; line-height: 1.5;">
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #2563eb;">
            <strong>🚀 应用内一键升级</strong>：发现新版自动在应用内下载并自动重启升级。
          </div>
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #10b981;">
            <strong>⚡ 插件市场【立即重启】解锁</strong>：安装插件后点击立即重启后端服务生效。
          </div>
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #8b5cf6;">
            <strong>🖼️ ModLens 视觉直通</strong>：截图 Ctrl+V 直通纯文本大模型。
          </div>
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #06b6d4;">
            <strong>🧩 35 个全流程技能</strong>：内置 TDD、代码审查等技能，开箱即用。
          </div>
        </div>
      </div>

      <!-- 底部内核版本 -->
      <div style="padding-top: 14px; border-top: 1px solid ${borderColor}; font-size: 11px; opacity: 0.65; display: flex; justify-content: space-between; gap: 8px;">
        <div>官方内核：<strong>@deepseek-ai/dsh@${cachedAppInfo.kernelVersion || '0.1.0-rc.8'}</strong></div>
        <div>桌面框架：Electron ${cachedAppInfo.electronVersion || '33'}</div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // 关闭事件
  const closeModal = () => {
    overlay.style.display = "none";
  };

  overlay.querySelector("#dsh-modal-close-btn").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  // 检查更新事件
  const checkBtn = overlay.querySelector("#dsh-modal-check-update-btn");
  checkBtn.addEventListener("click", async () => {
    checkBtn.innerText = "🔄 正在检查更新...";
    checkBtn.style.opacity = "0.75";
    checkBtn.disabled = true;
    try {
      await ipcRenderer.invoke("check-for-updates-manual");
    } catch (err) {
      alert("检查更新出错: " + err.message);
    } finally {
      setTimeout(() => {
        checkBtn.innerText = "🔍 检查更新...";
        checkBtn.style.opacity = "1";
        checkBtn.disabled = false;
      }, 2000);
    }
  });
}

function injectAboutTabIntoSettings() {
  const allButtons = Array.from(document.querySelectorAll("button, [role='tab'], div[role='button']"));
  const marketTab = allButtons.find((btn) => {
    const text = (btn.textContent || "").trim();
    return text.includes("插件市场") || text === "插件市场";
  });

  if (!marketTab) return;
  const tabContainer = marketTab.parentElement;
  if (!tabContainer) return;

  // 如果已经注入过，则跳过
  if (tabContainer.querySelector(".dsh-about-custom-tab")) return;

  // 克隆一个同款样式的 Tab 按钮
  const aboutTab = marketTab.cloneNode(true);
  aboutTab.className = marketTab.className + " dsh-about-custom-tab";
  aboutTab.innerHTML = `
    <span style="display: inline-flex; align-items: center; gap: 8px; width: 100%;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span>关于</span>
    </span>
  `;

  aboutTab.setAttribute("aria-selected", "false");
  aboutTab.style.cursor = "pointer";
  aboutTab.dataset.dshCustomTab = "about";

  // 插入到 Tab 容器中（排在插件市场之后）
  marketTab.after(aboutTab);

  // 点击“关于”Tab 时打开独立 Modal 弹窗
  aboutTab.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showAboutModal();
  });
}

// 页面加载及 DOM 变动时持续监听
window.addEventListener("DOMContentLoaded", () => {
  scanAndEnableRestartButtons();
  injectAboutTabIntoSettings();
  const observer = new MutationObserver(() => {
    scanAndEnableRestartButtons();
    injectAboutTabIntoSettings();
  });
  observer.observe(document.body, { childList: true, subtree: true });
});

setInterval(() => {
  scanAndEnableRestartButtons();
  injectAboutTabIntoSettings();
}, 1000);




