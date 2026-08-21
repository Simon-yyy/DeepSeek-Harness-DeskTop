
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
let cachedAppInfo = { version: "1.1.3", kernelVersion: "0.1.0-rc.8" };
ipcRenderer.invoke("get-app-info").then((info) => {
  if (info) cachedAppInfo = info;
}).catch(() => {});

function createAboutPanelContent() {
  const panel = document.createElement("div");
  panel.id = "dsh-desktop-about-panel";
  panel.style.cssText = `
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: #ffffff;
    z-index: 999;
    display: none;
    flex-direction: column;
    overflow-y: auto;
    padding: 28px 36px;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  `;

  // 检测暗色模式以适配背景
  const isDark = document.documentElement.classList.contains("dark") || 
                 document.body.classList.contains("dark") || 
                 window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (isDark) {
    panel.style.background = "#18181b";
    panel.style.color = "#f4f4f5";
  } else {
    panel.style.background = "#ffffff";
    panel.style.color = "#18181b";
  }

  panel.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid rgba(128,128,128,0.2);">
      <div style="display: flex; align-items: center; gap: 16px;">
        <div style="width: 56px; height: 56px; border-radius: 14px; background: #0f172a; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.18);">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM13 17H11V15H13V17ZM13 13H11V7H13V13Z" fill="#38bdf8"/>
          </svg>
        </div>
        <div>
          <div style="display: flex; align-items: center; gap: 10px;">
            <h2 style="margin: 0; font-size: 20px; font-weight: 700; color: inherit;">DSH Desktop</h2>
            <span style="font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 9999px; background: #10b981; color: #ffffff;">v${cachedAppInfo.version}</span>
          </div>
          <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.75;">DeepSeek Harness 现代化桌面客户端工作台</p>
        </div>
      </div>
      <button id="dsh-about-close-btn" style="background: none; border: none; font-size: 18px; cursor: pointer; color: inherit; opacity: 0.6; padding: 6px 10px; border-radius: 6px; transition: all 0.2s;" title="关闭">✕</button>
    </div>

    <!-- 检查更新核心操作区 -->
    <div style="background: rgba(128,128,128,0.06); border: 1px solid rgba(128,128,128,0.18); border-radius: 12px; padding: 18px 20px; margin-bottom: 24px;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div>
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 2px;">软件更新状态</div>
          <div style="font-size: 12px; opacity: 0.7;">当前已是稳定版本，支持应用内一键下载覆盖安装升级</div>
        </div>
        <button id="dsh-check-update-btn" style="
          padding: 8px 18px;
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
          transition: all 0.2s ease;
          box-shadow: 0 2px 6px rgba(37,99,235,0.25);
        ">
          <span>🔍 检查更新...</span>
        </button>
      </div>
    </div>

    <!-- 核心亮点与更新内容 -->
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 15px; font-weight: 600; margin: 0 0 12px 0;">🌟 核心能力与最新特性</h3>
      <div style="display: grid; gap: 10px; font-size: 13px; line-height: 1.6;">
        <div style="padding: 10px 14px; background: rgba(128,128,128,0.06); border-radius: 8px; border-left: 3px solid #2563eb;">
          <strong>🚀 应用内一键自动升级 (In-App Auto Update)</strong>：发现新版本时一键在应用内静默流式下载安装包，下载完成自动启动升级并重启应用。
        </div>
        <div style="padding: 10px 14px; background: rgba(128,128,128,0.06); border-radius: 8px; border-left: 3px solid #10b981;">
          <strong>⚡ 插件市场【立即重启】原生解锁</strong>：安装插件后，插件市场的“立即重启”按钮可直接点击，自动重启后端并刷新页面生效。
        </div>
        <div style="padding: 10px 14px; background: rgba(128,128,128,0.06); border-radius: 8px; border-left: 3px solid #8b5cf6;">
          <strong>🖼️ ModLens 视觉直通</strong>：直接 Ctrl+V 粘贴剪贴板截图或拖入图片，底层自动拦截并转存为本地路径，消除模型不支持附件报错。
        </div>
        <div style="padding: 10px 14px; background: rgba(128,128,128,0.06); border-radius: 8px; border-left: 3px solid #f59e0b;">
          <strong>🤫 全静默后台执行</strong>：调用终端命令行时全面静默化，彻底消除频繁弹出的黑色终端窗口。
        </div>
        <div style="padding: 10px 14px; background: rgba(128,128,128,0.06); border-radius: 8px; border-left: 3px solid #06b6d4;">
          <strong>🧩 35 个工业级编程技能</strong>：内置 TDD 测试驱动、代码审查、架构设计等 35 个 Matt Pocock Skills，启动自动释放即用。
        </div>
      </div>
    </div>

    <!-- 内核与运行环境 -->
    <div style="padding-top: 16px; border-top: 1px solid rgba(128,128,128,0.18); font-size: 12px; opacity: 0.65; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
      <div>官方内核：<strong>@deepseek-ai/dsh@${cachedAppInfo.kernelVersion || '0.1.0-rc.8'}</strong></div>
      <div>桌面框架：Electron ${cachedAppInfo.electronVersion || '33'}</div>
    </div>
  `;

  // 绑定关闭按钮事件
  const closeBtn = panel.querySelector("#dsh-about-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      panel.style.display = "none";
    });
  }

  // 绑定检查更新按钮事件
  const checkBtn = panel.querySelector("#dsh-check-update-btn");
  if (checkBtn) {
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

  return panel;
}

function injectAboutTabIntoSettings() {
  // 查找侧边栏中的 Tab 按钮
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

  // 找到外层弹窗大卡片容器（通常是包含侧边栏与内容区的父级）
  let modalContainer = tabContainer.parentElement;
  while (modalContainer && modalContainer !== document.body) {
    // 如果找到了包含右侧内容区域的 flex 容器
    if (modalContainer.children && modalContainer.children.length >= 2) {
      break;
    }
    modalContainer = modalContainer.parentElement;
  }

  if (!modalContainer) return;

  // 获取右侧的内容卡片容器（即与侧边栏平级的第二个子元素）
  const rightContentArea = Array.from(modalContainer.children).find((c) => c !== tabContainer && !c.contains(tabContainer));
  if (!rightContentArea) return;

  // 确保右侧容器为 relative 以支持覆盖层
  rightContentArea.style.position = "relative";

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

  // 创建/获取关于面板
  let aboutContentPanel = rightContentArea.querySelector("#dsh-desktop-about-panel");
  if (!aboutContentPanel) {
    aboutContentPanel = createAboutPanelContent();
    rightContentArea.appendChild(aboutContentPanel);
  }

  // 监听原始 Tab 点击：点击其他 Tab 时隐藏关于面板
  const originalTabs = tabContainer.querySelectorAll("button:not(.dsh-about-custom-tab), [role='tab']:not(.dsh-about-custom-tab)");
  originalTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (aboutContentPanel) aboutContentPanel.style.display = "none";
      aboutTab.style.background = "";
      aboutTab.style.fontWeight = "";
      aboutTab.style.opacity = "";
    });
  });

  // 点击“关于”Tab 逻辑
  aboutTab.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    // 切换 Tab 高亮样式
    originalTabs.forEach((t) => {
      t.style.background = "";
      t.style.fontWeight = "";
    });

    const isDark = document.documentElement.classList.contains("dark") || 
                   document.body.classList.contains("dark") || 
                   window.matchMedia("(prefers-color-scheme: dark)").matches;
    aboutTab.style.background = isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)";
    aboutTab.style.fontWeight = "600";

    // 确保关于面板在右侧容器中
    if (!rightContentArea.contains(aboutContentPanel)) {
      rightContentArea.appendChild(aboutContentPanel);
    }

    if (aboutContentPanel) {
      if (isDark) {
        aboutContentPanel.style.background = "#18181b";
        aboutContentPanel.style.color = "#f4f4f5";
      } else {
        aboutContentPanel.style.background = "#ffffff";
        aboutContentPanel.style.color = "#18181b";
      }
      aboutContentPanel.style.display = "flex";
      aboutContentPanel.style.zIndex = "9999";
    }
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



