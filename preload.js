
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
// Native Desktop Hook: Universal Smooth Wheel Scrolling Fix for Modals & Lists
// ---------------------------------------------------------------------------
function enableSmoothWheelScrollFix() {
  window.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.deltaY === 0) return;

      let el = e.target;
      let scrollableContainer = null;

      while (el && el !== document.body && el !== document.documentElement) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        const isScrollable = (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && el.scrollHeight > el.clientHeight;

        if (isScrollable) {
          const atTop = e.deltaY < 0 && el.scrollTop <= 0;
          const atBottom = e.deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

          if (!atTop && !atBottom) {
            scrollableContainer = el;
            break;
          }
        }
        el = el.parentElement;
      }

      if (scrollableContainer) {
        scrollableContainer.scrollTop += e.deltaY;
      }
    },
    { passive: true, capture: true }
  );
}

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

        // 立即清理前端 sessionStorage 脏标记，防止重启刷新后读取旧缓存
        try {
          sessionStorage.removeItem("dshm-restart");
          sessionStorage.removeItem("dshm-pending");
          sessionStorage.removeItem("dshm-restart-dismissed");
        } catch (err) {}

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
// Native Desktop Theme: 🌸 彬哥の VS Code 4 款经典主题原生引擎
// 1. escook Dark (经典暗黑)
// 2. escook Dark Soft (柔和暗黑)
// 3. escook Light (经典紫韵浅色)
// 4. escook Light Soft (柔和浅色)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Native Desktop Theme: 🌸 彬哥の VS Code 4 款经典主题原生引擎 (DeepSeek Harness 原生 --dsw-* 适配)
// 1. escook Dark (经典暗黑)
// 2. escook Dark Soft (柔和暗黑)
// 3. escook Light (经典紫韵浅色)
// 4. escook Light Soft (柔和浅色)
// ---------------------------------------------------------------------------
const ESCOOK_THEMES = {
  "dark": {
    name: "escook Dark (经典暗黑)",
    desc: "标志性暖橙高亮与深暗极客底色",
    type: "dark",
    colorPreview: "#EF820C",
    bgPreview: "#252526",
    css: `
      :root, html, body, body[data-ds-dark-theme] {
        --dsw-alias-bg-base: #252526 !important;
        --dsw-alias-bg-layer-1: #202020 !important;
        --dsw-alias-bg-layer-2: #29292c !important;
        --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.6) !important;
        --dsw-specific-sidebar-fill: #202020 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 255, 255, 0.08) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(239, 130, 12, 0.18) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #EF820C !important;
        --dsw-specific-input-major: #29292c !important;
        --dsw-specific-bubble: #29292c !important;
        --dsw-specific-menu: #29292c !important;
        --dsw-hovercard-bg: #29292c !important;
        --dsw-alias-tooltip-bg: #202020 !important;
        --dsw-alias-button-elevated-fill: #29292c !important;
        --dsw-alias-button-floating-hover: #333336 !important;
        --dsw-alias-brand-primary: #EF820C !important;
        --dsw-alias-button-primary-fill: #EF820C !important;
        --dsw-alias-button-primary-hover: #ff9940 !important;
        --dsw-alias-label-primary-foreground: #ffffff !important;
        --dsw-alias-label-primary: #fafafa !important;
        --dsw-alias-label-secondary: #cccccc !important;
        --dsw-alias-label-tertiary: #999999 !important;
        --dsw-alias-label-dimmed: #777777 !important;
        --dsw-alias-label-caption: #888888 !important;
        --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08) !important;
        --dsw-alias-interactive-bg-active: rgba(255, 255, 255, 0.14) !important;
        --dsw-alias-border-l1: #383838 !important;
        --dsw-alias-border-l2: #2e2e2e !important;
        --dsw-alias-border-l3: #444444 !important;
        --dsw-alias-border-l4: #555555 !important;
        --dsw-alias-markdown-code-block: #1e1e1e !important;
        --dsw-alias-markdown-code-block-banner: #252526 !important;
        --dsw-alias-scrollbar-bg-l2: #383838 !important;
        --dsw-alias-scrollbar-hover-l2: #EF820C !important;
      }
      body, body[data-ds-dark-theme] { background-color: #252526 !important; color: #fafafa !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #1e1e1e !important;
        color: #d4d4d4 !important;
        border-color: #383838 !important;
      }
    `
  },
  "dark-soft": {
    name: "escook Dark Soft (柔和暗黑)",
    desc: "优雅暗夜紫调、琥珀金按钮与高对比度语法高亮",
    type: "dark",
    colorPreview: "#ffcc66",
    bgPreview: "#1f2430",
    css: `
      :root, html, body, body[data-ds-dark-theme] {
        --dsw-alias-bg-base: #1f2430 !important;
        --dsw-alias-bg-layer-1: #191e2a !important;
        --dsw-alias-bg-layer-2: #232834 !important;
        --dsw-alias-bg-mask-1: rgba(15, 18, 26, 0.65) !important;
        --dsw-specific-sidebar-fill: #191e2a !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 204, 102, 0.08) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 204, 102, 0.16) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #ffcc66 !important;
        --dsw-specific-input-major: #232834 !important;
        --dsw-specific-bubble: #232834 !important;
        --dsw-specific-menu: #232834 !important;
        --dsw-hovercard-bg: #232834 !important;
        --dsw-alias-tooltip-bg: #191e2a !important;
        --dsw-alias-button-elevated-fill: #232834 !important;
        --dsw-alias-button-floating-hover: #2b3240 !important;
        --dsw-alias-brand-primary: #ffcc66 !important;
        --dsw-alias-button-primary-fill: #ffcc66 !important;
        --dsw-alias-button-primary-hover: #fac761 !important;
        --dsw-alias-label-primary-foreground: #1f2430 !important;
        --dsw-alias-label-primary: #cbccc6 !important;
        --dsw-alias-label-secondary: #969aa4 !important;
        --dsw-alias-label-tertiary: #707a8c !important;
        --dsw-alias-label-dimmed: #5c6773 !important;
        --dsw-alias-label-caption: #707a8c !important;
        --dsw-alias-interactive-bg-hover: rgba(255, 204, 102, 0.1) !important;
        --dsw-alias-interactive-bg-active: rgba(255, 204, 102, 0.18) !important;
        --dsw-alias-border-l1: #373e4c !important;
        --dsw-alias-border-l2: #2d3443 !important;
        --dsw-alias-border-l3: #4f5869 !important;
        --dsw-alias-border-l4: #636e84 !important;
        --dsw-alias-markdown-code-block: #1a1f29 !important;
        --dsw-alias-markdown-code-block-banner: #232834 !important;
        --dsw-alias-scrollbar-bg-l2: #373e4c !important;
        --dsw-alias-scrollbar-hover-l2: #ffcc66 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #1f2430 !important; color: #cbccc6 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #1a1f29 !important;
        color: #cbccc6 !important;
        border-color: #2d3443 !important;
      }
      .hljs-keyword, .token.keyword { color: #f28779 !important; font-weight: 600; }
      .hljs-string, .token.string { color: #bae67e !important; }
      .hljs-function, .token.function { color: #73d0ff !important; }
      .hljs-number, .token.number { color: #ff9940 !important; }
      .hljs-comment, .token.comment { color: #5c6773 !important; font-style: italic; }
    `
  },
  "light": {
    name: "escook Light (经典紫韵浅色)",
    desc: "暖白羊皮纸背景配罗兰紫强调色与高对比度文字",
    type: "light",
    colorPreview: "#705697",
    bgPreview: "#FDF6E3",
    css: `
      :root, html, body, body[data-ds-dark-theme] {
        --dsw-alias-bg-base: #FDF6E3 !important;
        --dsw-alias-bg-layer-1: #F5EEDB !important;
        --dsw-alias-bg-layer-2: #EDE5D0 !important;
        --dsw-alias-bg-mask-1: rgba(88, 70, 50, 0.35) !important;
        --dsw-specific-sidebar-fill: #F5EEDB !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(112, 86, 151, 0.08) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(112, 86, 151, 0.16) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #705697 !important;
        --dsw-specific-input-major: #EDE5D0 !important;
        --dsw-specific-bubble: #EDE5D0 !important;
        --dsw-specific-menu: #FFFFFF !important;
        --dsw-hovercard-bg: #FFFFFF !important;
        --dsw-alias-tooltip-bg: #2B2B2B !important;
        --dsw-alias-button-elevated-fill: #EDE5D0 !important;
        --dsw-alias-button-floating-hover: #e4dcc4 !important;
        --dsw-alias-brand-primary: #705697 !important;
        --dsw-alias-button-primary-fill: #705697 !important;
        --dsw-alias-button-primary-hover: #8a6ab8 !important;
        --dsw-alias-label-primary-foreground: #ffffff !important;
        --dsw-alias-label-primary: #2b2b2b !important;
        --dsw-alias-label-secondary: #4a5c63 !important;
        --dsw-alias-label-tertiary: #657b83 !important;
        --dsw-alias-label-dimmed: #839496 !important;
        --dsw-alias-label-caption: #657b83 !important;
        --dsw-alias-interactive-bg-hover: rgba(112, 86, 151, 0.08) !important;
        --dsw-alias-interactive-bg-active: rgba(112, 86, 151, 0.15) !important;
        --dsw-alias-border-l1: #d3cbb7 !important;
        --dsw-alias-border-l2: #e2dbca !important;
        --dsw-alias-border-l3: #ccc4af !important;
        --dsw-alias-border-l4: #b8af98 !important;
        --dsw-alias-markdown-code-block: #f7f0dc !important;
        --dsw-alias-markdown-code-block-banner: #ede5d0 !important;
        --dsw-alias-scrollbar-bg-l2: #d3cbb7 !important;
        --dsw-alias-scrollbar-hover-l2: #705697 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #FDF6E3 !important; color: #2b2b2b !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #f7f0dc !important;
        color: #2b2b2b !important;
        border-color: #d3cbb7 !important;
      }
    `
  },
  "light-soft": {
    name: "escook Light Soft (柔和浅色)",
    desc: "轻盈素雅纯净白调与柔和暖橙强调色",
    type: "light",
    colorPreview: "#ff9940",
    bgPreview: "#FAFAFA",
    css: `
      :root, html, body, body[data-ds-dark-theme] {
        --dsw-alias-bg-base: #FAFAFA !important;
        --dsw-alias-bg-layer-1: #F0F0F0 !important;
        --dsw-alias-bg-layer-2: #FFFFFF !important;
        --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.3) !important;
        --dsw-specific-sidebar-fill: #F0F0F0 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 153, 64, 0.08) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 153, 64, 0.16) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #ff9940 !important;
        --dsw-specific-input-major: #FFFFFF !important;
        --dsw-specific-bubble: #FFFFFF !important;
        --dsw-specific-menu: #FFFFFF !important;
        --dsw-hovercard-bg: #FFFFFF !important;
        --dsw-alias-tooltip-bg: #1F2937 !important;
        --dsw-alias-button-elevated-fill: #FFFFFF !important;
        --dsw-alias-button-floating-hover: #f5f5f5 !important;
        --dsw-alias-brand-primary: #ff9940 !important;
        --dsw-alias-button-primary-fill: #ff9940 !important;
        --dsw-alias-button-primary-hover: #ffaa5e !important;
        --dsw-alias-label-primary-foreground: #ffffff !important;
        --dsw-alias-label-primary: #1F2937 !important;
        --dsw-alias-label-secondary: #4B5563 !important;
        --dsw-alias-label-tertiary: #6B7280 !important;
        --dsw-alias-label-dimmed: #9CA3AF !important;
        --dsw-alias-label-caption: #6B7280 !important;
        --dsw-alias-interactive-bg-hover: rgba(255, 153, 64, 0.08) !important;
        --dsw-alias-interactive-bg-active: rgba(255, 153, 64, 0.15) !important;
        --dsw-alias-border-l1: #E5E7EB !important;
        --dsw-alias-border-l2: #F3F4F6 !important;
        --dsw-alias-border-l3: #D1D5DB !important;
        --dsw-alias-border-l4: #9CA3AF !important;
        --dsw-alias-markdown-code-block: #f4f4f5 !important;
        --dsw-alias-markdown-code-block-banner: #e5e7eb !important;
        --dsw-alias-scrollbar-bg-l2: #E5E7EB !important;
        --dsw-alias-scrollbar-hover-l2: #ff9940 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #FAFAFA !important; color: #1F2937 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #f4f4f5 !important;
        color: #1F2937 !important;
        border-color: #E5E7EB !important;
      }
    `
  }
};

function applyAppTheme(themeKey) {
  let styleEl = document.getElementById("dsh-builtin-theme-styles");
  if (!themeKey || themeKey === "default") {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    document.documentElement.removeAttribute("data-dsh-theme");
    localStorage.setItem("dsh_selected_theme", "default");
    console.log("🎨 [dsh-desktop] 已恢复系统默认主题");
    return;
  }

  const themeObj = ESCOOK_THEMES[themeKey];
  if (!themeObj) return;

  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "dsh-builtin-theme-styles";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = themeObj.css;
  document.documentElement.setAttribute("data-dsh-theme", `escook-${themeKey}`);
  localStorage.setItem("dsh_selected_theme", themeKey);
  console.log(`🌸 [dsh-desktop] 已激活主题: ${themeObj.name}`);
}

// ---------------------------------------------------------------------------
// Native Desktop Modal: 🎨 主题与外观切换弹窗 (Theme Selection Modal)
// ---------------------------------------------------------------------------
function showThemeModal() {
  const existingModal = document.getElementById("dsh-desktop-theme-modal-overlay");
  if (existingModal && existingModal.parentNode) {
    existingModal.parentNode.removeChild(existingModal);
  }

  const currentTheme = localStorage.getItem("dsh_selected_theme") || "default";
  const isDark = document.documentElement.classList.contains("dark") || 
                 document.body.classList.contains("dark") || 
                 window.matchMedia("(prefers-color-scheme: dark)").matches;

  const overlay = document.createElement("div");
  overlay.id = "dsh-desktop-theme-modal-overlay";
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
    <div style="
      width: 540px;
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
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    ">
      <!-- 头部 -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid ${borderColor};">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 42px; height: 42px; border-radius: 10px; background: #0f172a; display: flex; align-items: center; justify-content: center; font-size: 20px;">
            🎨
          </div>
          <div>
            <h3 style="margin: 0; font-size: 17px; font-weight: 700;">主题外观设置</h3>
            <p style="margin: 3px 0 0 0; font-size: 12px; opacity: 0.7;">选择您喜爱的界面配色方案（即时生效并持久保存）</p>
          </div>
        </div>
        <button id="dsh-theme-modal-close-btn" style="background: none; border: none; font-size: 18px; cursor: pointer; color: inherit; opacity: 0.6; padding: 4px 8px; border-radius: 6px;" title="关闭">✕</button>
      </div>

      <!-- 主题列表 -->
      <div style="display: grid; gap: 10px; margin-bottom: 20px;">
        <!-- 系统默认主题 -->
        <div class="dsh-theme-option-card" data-theme-key="default" style="
          padding: 14px 16px;
          background: ${currentTheme === 'default' ? 'rgba(37,99,235,0.1)' : itemBg};
          border: 2px solid ${currentTheme === 'default' ? '#2563eb' : borderColor};
          border-radius: 12px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: all 0.2s;
        ">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 24px; height: 24px; border-radius: 6px; background: #3b82f6; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px;">⚙️</div>
            <div>
              <div style="font-weight: 600; font-size: 13px;">系统默认主题 (Default)</div>
              <div style="font-size: 11px; opacity: 0.65; margin-top: 2px;">跟随 DeepSeek Harness 官方标准暗黑/明亮模式</div>
            </div>
          </div>
          <span style="font-size: 14px; font-weight: 700; color: #2563eb;">${currentTheme === 'default' ? '✓' : ''}</span>
        </div>

        <!-- 4 款彬哥主题 -->
        ${Object.entries(ESCOOK_THEMES).map(([key, t]) => {
          const isSelected = currentTheme === key;
          return `
            <div class="dsh-theme-option-card" data-theme-key="${key}" style="
              padding: 14px 16px;
              background: ${isSelected ? 'rgba(255,204,102,0.12)' : itemBg};
              border: 2px solid ${isSelected ? t.colorPreview : borderColor};
              border-radius: 12px;
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: space-between;
              transition: all 0.2s;
            ">
              <div style="display: flex; align-items: center; gap: 12px;">
                <div style="width: 24px; height: 24px; border-radius: 6px; background: ${t.bgPreview}; border: 2px solid ${t.colorPreview}; display: flex; align-items: center; justify-content: center; font-size: 11px;">🌸</div>
                <div>
                  <div style="font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                    <span>${t.name}</span>
                    <span style="font-size: 9px; padding: 1px 5px; border-radius: 4px; background: ${t.colorPreview}; color: ${t.type === 'dark' && key !== 'dark' ? '#1f2430' : '#fff'}; font-weight: 700;">${t.type.toUpperCase()}</span>
                  </div>
                  <div style="font-size: 11px; opacity: 0.65; margin-top: 2px;">${t.desc}</div>
                </div>
              </div>
              <span style="font-size: 14px; font-weight: 700; color: ${t.colorPreview};">${isSelected ? '✓' : ''}</span>
            </div>
          `;
        }).join('')}
      </div>

      <!-- 底部跳转插件市场按钮 -->
      <div style="padding-top: 14px; border-top: 1px solid ${borderColor}; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <div style="font-size: 11px; opacity: 0.55;">🌸 致敬 liulongbin1314 / escook-theme</div>
        <button id="dsh-open-market-themes-btn" style="
          padding: 6px 12px;
          background: none;
          border: 1px solid ${borderColor};
          border-radius: 6px;
          color: inherit;
          font-size: 12px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          opacity: 0.85;
          transition: all 0.2s;
        ">
          <span>🛒 探索插件市场更多主题...</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeModal = () => { overlay.style.display = "none"; };
  overlay.querySelector("#dsh-theme-modal-close-btn").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // 绑定选项点击
  overlay.querySelectorAll(".dsh-theme-option-card").forEach((card) => {
    card.addEventListener("click", () => {
      const key = card.dataset.themeKey;
      applyAppTheme(key);
      // 重新触发 showThemeModal 重新渲染选中状态
      showThemeModal();
    });
  });

  // 绑定跳转插件市场主题
  const openMarketBtn = overlay.querySelector("#dsh-open-market-themes-btn");
  if (openMarketBtn) {
    openMarketBtn.addEventListener("click", () => {
      closeModal();
      const allButtons = Array.from(document.querySelectorAll("button, [role='tab'], div[role='button']"));
      const marketTab = allButtons.find((btn) => {
        const text = (btn.textContent || "").trim();
        return text.includes("插件市场") || text === "插件市场";
      });
      if (marketTab) marketTab.click();
    });
  }
}

// ---------------------------------------------------------------------------
// Native Desktop Hook: ℹ️ 关于 DSH Desktop 弹窗 (About Modal) - 纯净版
// ---------------------------------------------------------------------------
let cachedAppInfo = { version: "1.1.5", kernelVersion: "0.1.1-rc.2" };
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
          <div style="font-weight: 600; font-size: 13px;">软件版本与更新</div>
          <div style="font-size: 12px; opacity: 0.7; margin-top: 2px;">支持在应用内一键下载更新包并覆盖安装</div>
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
        <div>官方内核：<strong>@deepseek-ai/dsh@${cachedAppInfo.kernelVersion || '0.1.1-rc.2'}</strong></div>
        <div>桌面框架：Electron ${cachedAppInfo.electronVersion || '33'}</div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeModal = () => { overlay.style.display = "none"; };
  overlay.querySelector("#dsh-modal-close-btn").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

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

// ---------------------------------------------------------------------------
// Native Desktop Hook: 在设置弹窗中分别注入【主题外观】与【关于】Tab
// ---------------------------------------------------------------------------
function injectCustomTabsIntoSettings() {
  const allButtons = Array.from(document.querySelectorAll("button, [role='tab'], div[role='button']"));
  const marketTab = allButtons.find((btn) => {
    const text = (btn.textContent || "").trim();
    return text.includes("插件市场") || text === "插件市场";
  });

  if (!marketTab || !marketTab.parentNode) return;
  const tabContainer = marketTab.parentNode;

  // 1. 注入【主题外观】Tab
  if (!tabContainer.querySelector(".dsh-theme-custom-tab")) {
    const themeTab = marketTab.cloneNode(true);
    themeTab.className = marketTab.className + " dsh-theme-custom-tab";
    themeTab.innerHTML = `
      <span style="display: inline-flex; align-items: center; gap: 8px; width: 100%;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 2a10 10 0 0 1 10 10c0 5.523-4.477 10-10 10S2 17.523 2 12a10 10 0 0 1 10-10z"></path>
          <path d="m4.93 4.93 4.24 4.24"></path>
          <path d="m14.83 9.17 4.24-4.24"></path>
          <path d="m14.83 14.83 4.24 4.24"></path>
          <path d="m4.93 19.07 4.24-4.24"></path>
        </svg>
        <span>主题外观</span>
      </span>
    `;
    themeTab.setAttribute("aria-selected", "false");
    themeTab.style.cursor = "pointer";
    themeTab.dataset.dshCustomTab = "theme";
    marketTab.after(themeTab);

    themeTab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showThemeModal();
    });
  }

  // 2. 注入【关于】Tab
  if (!tabContainer.querySelector(".dsh-about-custom-tab")) {
    const themeTab = tabContainer.querySelector(".dsh-theme-custom-tab") || marketTab;
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
    themeTab.after(aboutTab);

    aboutTab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAboutModal();
    });
  }
}

// 页面加载及 DOM 变动时持续监听
window.addEventListener("DOMContentLoaded", () => {
  const savedTheme = localStorage.getItem("dsh_selected_theme");
  if (savedTheme && savedTheme !== "default") {
    applyAppTheme(savedTheme);
  }
  enableSmoothWheelScrollFix();
  scanAndEnableRestartButtons();
  injectCustomTabsIntoSettings();
  const observer = new MutationObserver(() => {
    scanAndEnableRestartButtons();
    injectCustomTabsIntoSettings();
  });
  observer.observe(document.body, { childList: true, subtree: true });
});

setInterval(() => {
  scanAndEnableRestartButtons();
  injectCustomTabsIntoSettings();
}, 1000);




