// ---------------------------------------------------------------------------
// 🛡️ 官方 ModuleLoader 启动保护与防崩溃盾
// ---------------------------------------------------------------------------
(() => {
  const pendingQueue = [];
  const defaultLoader = {
    mode: "queue",
    pendingQueue,
    load(registration) {
      pendingQueue.push(registration);
    },
    create(options) {
      if (this.mode !== "queue") throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot");
      const index = pendingQueue.findIndex(r => r.id === "@deepseek-ai/dsh-client-modules");
      const registration = pendingQueue[index];
      if (registration === undefined) {
        return { id: "dsh-client-fallback", exports: {}, apply() {} };
      }
      pendingQueue.splice(index, 1);
      const exports = registration.factory(specifier => {
        throw new Error('client-modules: @deepseek-ai/dsh-client-modules/client.js requested external "' + specifier + '" before the module system existed');
      });
      if (typeof exports !== "object" || exports === null || typeof exports.createClientModuleSystem !== "function" || typeof exports.apply !== "function") {
        return { id: registration.id, exports: exports || {}, apply() {} };
      }
      return exports.createClientModuleSystem(this, { id: registration.id, exports }, options);
    }
  };

  let _moduleLoader = window.__ModuleLoader__ || defaultLoader;

  try {
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
  } catch (e) {
    window.__ModuleLoader__ = defaultLoader;
  }
})();

const { ipcRenderer } = require("electron");
const { replaceYamlProvidersBlock } = require("./src/preload/utils/yaml-providers");

// ---------------------------------------------------------------------------
// 🛡️ 安全本地存储适配器 (防止 data: URL 启动页触发 SecurityError) (5.2.6)
// ---------------------------------------------------------------------------
const memoryFallbackStorage = new Map();

function isStorageAvailable() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const proto = window.location.protocol;
    if (proto === "data:" || proto === "about:") return false;
    return typeof window.localStorage !== "undefined" && window.localStorage !== null;
  } catch (_e) {
    return false;
  }
}

function safeGetItem(key) {
  try {
    if (isStorageAvailable()) {
      return window.localStorage.getItem(key);
    }
  } catch (_e) {}
  return memoryFallbackStorage.get(key) || null;
}

function safeSetItem(key, value) {
  try {
    if (isStorageAvailable()) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch (_e) {}
  memoryFallbackStorage.set(key, String(value));
}

function safeRemoveItem(key) {
  try {
    if (isStorageAvailable()) {
      window.localStorage.removeItem(key);
      return;
    }
  } catch (_e) {}
  memoryFallbackStorage.delete(key);
}

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
    } catch (_e) {
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

// ---------------------------------------------------------------------------
// 👁️ 原生视觉模型与多模态图片直通适配器 (Native Vision & Multi-Modal Passthrough)
// ---------------------------------------------------------------------------
// 最新官方 0.1.2 内核原生支持视觉模型图片上传与多模态附件；
// 优先完全透传原生 paste 事件，让官方 Web 前端自然接管 File 对象生成 DraftImages 附件卡片。
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

    if (!imageFile) return;

    // 1. 检查是否处于对话输入框或官方多模态附件区域
    const activeEl = document.activeElement;
    const isInsideInput = activeEl && (
      activeEl.tagName === "TEXTAREA" ||
      activeEl.tagName === "INPUT" ||
      activeEl.isContentEditable ||
      activeEl.closest("[class*='composer']") ||
      activeEl.closest("[class*='input']")
    );

    // 2. 如果当前在官方输入框内，优先完全透传给官方原生视觉多模态引擎！
    if (isInsideInput) {
      console.info("[dsh-desktop] Native vision modal detected, passing imageFile to official web frontend handler");
      // 不执行 event.preventDefault() 与 stopImmediatePropagation()，让官方 React 前端原生接收 File 生成附件缩略图
      return;
    }

    // 3. 仅当焦点不在输入区域时，提供安全降级（避免用户在空白处粘贴丢失图片）
    try {
      const arrayBuffer = await imageFile.arrayBuffer();
      const ext = imageFile.type === "image/jpeg" ? ".jpg" : (imageFile.type === "image/webp" ? ".webp" : ".png");
      const filePath = await ipcRenderer.invoke("save-paste-image", {
        buffer: Array.from(new Uint8Array(arrayBuffer)),
        ext,
      });
      // 如果页面上有主输入框，聚焦并告知路径
      const textarea = document.querySelector("textarea");
      if (textarea) {
        textarea.focus();
        insertPathText(filePath);
      }
    } catch (err) {
      console.error("[dsh-desktop] paste image fallback failed:", err);
    }
  },
  false // 使用冒泡或非侵入式监听，绝不阻断捕获流
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

      // 绑定桌面端原生重启事件（使用标准冒泡监听，不阻断正常组件事件）
      el.addEventListener("click", async (e) => {
        e.preventDefault();

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
      }, false);
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
// =========================================================================
// 4 款全新精心调配的高级设计感主题矩阵 (Aesthetic Theme Palettes)
// =========================================================================
const ESCOOK_THEMES = {
  "dark": {
    name: "escook Dark (经典暗黑 · 标志暖阳橙)",
    desc: "VS Code 彬哥经典暖调极客深灰搭配标志暖阳橙，正统耐看长效护眼",
    type: "dark",
    colorPreview: "#ef820c",
    bgPreview: "#252526",
    css: `
      :root, html, body, body[data-ds-dark-theme], [data-theme="escook-dark"] {
        --dsw-alias-bg-base: #252526 !important;
        --dsw-alias-bg-layer-1: #202021 !important;
        --dsw-alias-bg-layer-2: #29292c !important;
        --dsw-alias-bg-layer-3: #2d2d30 !important;
        --dsw-alias-bg-module-platform: #2d2d30 !important;
        --dsw-alias-bg-multi-select: #2d2d30 !important;
        --dsw-alias-bg-overlay: #333333 !important;
        --dsw-specific-selector: #2d2d30 !important;
        --dsw-alias-bg-mask-1: rgba(18, 18, 20, 0.75) !important;
        --dsw-specific-sidebar-fill: #202021 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(239, 130, 12, 0.1) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(239, 130, 12, 0.2) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #ef820c !important;
        --dsw-specific-input-major: #29292c !important;
        --dsw-specific-bubble: #29292c !important;
        --dsw-specific-menu: #202021 !important;
        --dsw-hovercard-bg: #29292c !important;
        --dsw-alias-tooltip-bg: #1c1c1d !important;
        --dsw-alias-button-elevated-fill: #2f2f33 !important;
        --dsw-alias-button-floating-hover: #38383c !important;
        --dsw-alias-brand-primary: #ef820c !important;
        --dsw-alias-button-primary-fill: #ef820c !important;
        --dsw-alias-button-primary-hover: #ff9940 !important;
        --dsw-alias-label-primary-foreground: #ffffff !important;
        --dsw-alias-label-primary: #fafafa !important;
        --dsw-alias-label-secondary: #cccccc !important;
        --dsw-alias-label-tertiary: #888888 !important;
        --dsw-alias-label-dimmed: #555555 !important;
        --dsw-alias-label-caption: #888888 !important;
        --dsw-alias-interactive-bg-hover: rgba(239, 130, 12, 0.1) !important;
        --dsw-alias-interactive-bg-active: rgba(239, 130, 12, 0.2) !important;
        --dsw-alias-border-l1: #333333 !important;
        --dsw-alias-border-l2: #2a2a2a !important;
        --dsw-alias-border-l3: #3e3e3e !important;
        --dsw-alias-border-l4: #555555 !important;
        --dsw-alias-markdown-code-block: #1c1c1d !important;
        --dsw-alias-markdown-code-block-banner: #252526 !important;
        --dsw-alias-scrollbar-bg-l2: #333333 !important;
        --dsw-alias-scrollbar-hover-l2: #ef820c !important;
      }
      body, body[data-ds-dark-theme] { background-color: #252526 !important; color: #fafafa !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #1c1c1d !important;
        color: #fafafa !important;
        border-color: #333333 !important;
      }
      [class*="selector"], [class*="themeCube"] {
        color: #fafafa !important;
        background-color: #2d2d30 !important;
      }
      [class*="selected"], [class*="themeCube"]:hover {
        border-color: #ef820c !important;
      }
    `
  },
  "dark-soft": {
    name: "escook Dark Soft (柔和暗黑 · 柔光奶杏黄)",
    desc: "Ayu 经典深海蓝灰底色搭配温润奶杏黄，细腻柔和长效防疲劳",
    type: "dark",
    colorPreview: "#ffcc66",
    bgPreview: "#1f2430",
    css: `
      :root, html, body, body[data-ds-dark-theme], [data-theme="escook-dark-soft"] {
        --dsw-alias-bg-base: #1f2430 !important;
        --dsw-alias-bg-layer-1: #191e28 !important;
        --dsw-alias-bg-layer-2: #232834 !important;
        --dsw-alias-bg-layer-3: #262c3b !important;
        --dsw-alias-bg-module-platform: #262c3b !important;
        --dsw-alias-bg-multi-select: #262c3b !important;
        --dsw-alias-bg-overlay: #333a4c !important;
        --dsw-specific-selector: #262c3b !important;
        --dsw-alias-bg-mask-1: rgba(16, 20, 28, 0.7) !important;
        --dsw-specific-sidebar-fill: #191e28 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 204, 102, 0.1) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 204, 102, 0.18) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #ffcc66 !important;
        --dsw-specific-input-major: #232834 !important;
        --dsw-specific-bubble: #232834 !important;
        --dsw-specific-menu: #191e28 !important;
        --dsw-hovercard-bg: #191e28 !important;
        --dsw-alias-tooltip-bg: #171b24 !important;
        --dsw-alias-button-elevated-fill: #2b3140 !important;
        --dsw-alias-button-floating-hover: #333a4c !important;
        --dsw-alias-brand-primary: #ffcc66 !important;
        --dsw-alias-button-primary-fill: #ffcc66 !important;
        --dsw-alias-button-primary-hover: #ffd580 !important;
        --dsw-alias-label-primary-foreground: #1f2430 !important;
        --dsw-alias-label-primary: #cbccc6 !important;
        --dsw-alias-label-secondary: #969aa4 !important;
        --dsw-alias-label-tertiary: #707a8c !important;
        --dsw-alias-label-dimmed: #515764 !important;
        --dsw-alias-label-caption: #707a8c !important;
        --dsw-alias-interactive-bg-hover: rgba(255, 204, 102, 0.1) !important;
        --dsw-alias-interactive-bg-active: rgba(255, 204, 102, 0.18) !important;
        --dsw-alias-border-l1: #373e4c !important;
        --dsw-alias-border-l2: #2d3340 !important;
        --dsw-alias-border-l3: #444c5e !important;
        --dsw-alias-border-l4: #515764 !important;
        --dsw-alias-markdown-code-block: #171b24 !important;
        --dsw-alias-markdown-code-block-banner: #1f2430 !important;
        --dsw-alias-scrollbar-bg-l2: #373e4c !important;
        --dsw-alias-scrollbar-hover-l2: #ffcc66 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #1f2430 !important; color: #cbccc6 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #171b24 !important;
        color: #cbccc6 !important;
        border-color: #373e4c !important;
      }
      [class*="selector"], [class*="themeCube"] {
        color: #cbccc6 !important;
        background-color: #262c3b !important;
      }
      [class*="selected"], [class*="themeCube"]:hover {
        border-color: #ffcc66 !important;
      }
    `
  },
  "light": {
    name: "escook Light (经典浅色 · 典雅紫罗兰)",
    desc: "Solarized 经典护眼暖米白搭配典雅紫罗兰与青墨文本，温润纸质书卷感",
    type: "light",
    colorPreview: "#705697",
    bgPreview: "#fdf6e3",
    css: `
      :root, html, body, body[data-ds-dark-theme], [data-theme="escook-light"] {
        --dsw-alias-bg-base: #fdf6e3 !important;
        --dsw-alias-bg-layer-1: #f8f0d8 !important;
        --dsw-alias-bg-layer-2: #ffffff !important;
        --dsw-alias-bg-layer-3: #eee8d5 !important;
        --dsw-alias-bg-module-platform: #eee8d5 !important;
        --dsw-alias-bg-multi-select: #eee8d5 !important;
        --dsw-alias-bg-overlay: #e3dac6 !important;
        --dsw-specific-selector: #eee8d5 !important;
        --dsw-alias-bg-mask-1: rgba(50, 40, 60, 0.25) !important;
        --dsw-specific-sidebar-fill: #f8f0d8 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(112, 86, 151, 0.08) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(112, 86, 151, 0.16) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #705697 !important;
        --dsw-specific-input-major: #ffffff !important;
        --dsw-specific-bubble: #ffffff !important;
        --dsw-specific-menu: #ffffff !important;
        --dsw-hovercard-bg: #ffffff !important;
        --dsw-alias-tooltip-bg: #2b2638 !important;
        --dsw-alias-button-elevated-fill: #f4ecce !important;
        --dsw-alias-button-floating-hover: #ece2c4 !important;
        --dsw-alias-brand-primary: #705697 !important;
        --dsw-alias-button-primary-fill: #705697 !important;
        --dsw-alias-button-primary-hover: #876cad !important;
        --dsw-alias-label-primary-foreground: #ffffff !important;
        --dsw-alias-label-primary: #586e75 !important;
        --dsw-alias-label-secondary: #657b83 !important;
        --dsw-alias-label-tertiary: #93a1a1 !important;
        --dsw-alias-label-dimmed: #b58900 !important;
        --dsw-alias-label-caption: #93a1a1 !important;
        --dsw-alias-interactive-bg-hover: rgba(112, 86, 151, 0.08) !important;
        --dsw-alias-interactive-bg-active: rgba(112, 86, 151, 0.15) !important;
        --dsw-alias-border-l1: #e3dac6 !important;
        --dsw-alias-border-l2: #ece3cf !important;
        --dsw-alias-border-l3: #d8ceb8 !important;
        --dsw-alias-border-l4: #b58900 !important;
        --dsw-alias-markdown-code-block: #f5eed8 !important;
        --dsw-alias-markdown-code-block-banner: #ebe4cc !important;
        --dsw-alias-scrollbar-bg-l2: #e3dac6 !important;
        --dsw-alias-scrollbar-hover-l2: #705697 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #fdf6e3 !important; color: #586e75 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #f5eed8 !important;
        color: #586e75 !important;
        border-color: #e3dac6 !important;
      }
      [class*="selector"], [class*="themeCube"] {
        color: #586e75 !important;
        background-color: #eee8d5 !important;
      }
      [class*="selected"], [class*="themeCube"]:hover {
        border-color: #705697 !important;
      }
    `
  },
  "light-soft": {
    name: "escook Light Soft (柔和浅色 · 活力柔和橙)",
    desc: "现代极简清透浅灰搭配柔和活力橙，明亮清爽不刺眼",
    type: "light",
    colorPreview: "#ff9940",
    bgPreview: "#fafafa",
    css: `
      :root, html, body, body[data-ds-dark-theme], [data-theme="escook-light-soft"] {
        --dsw-alias-bg-base: #fafafa !important;
        --dsw-alias-bg-layer-1: #f2f2f2 !important;
        --dsw-alias-bg-layer-2: #ffffff !important;
        --dsw-alias-bg-layer-3: #e8e8e8 !important;
        --dsw-alias-bg-module-platform: #e8e8e8 !important;
        --dsw-alias-bg-multi-select: #e8e8e8 !important;
        --dsw-alias-bg-overlay: #dcdcdc !important;
        --dsw-specific-selector: #e8e8e8 !important;
        --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.2) !important;
        --dsw-specific-sidebar-fill: #f2f2f2 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 153, 64, 0.08) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 153, 64, 0.16) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #ff9940 !important;
        --dsw-specific-input-major: #ffffff !important;
        --dsw-specific-bubble: #ffffff !important;
        --dsw-specific-menu: #ffffff !important;
        --dsw-hovercard-bg: #ffffff !important;
        --dsw-alias-tooltip-bg: #2d3748 !important;
        --dsw-alias-button-elevated-fill: #eaeaea !important;
        --dsw-alias-button-floating-hover: #e0e0e0 !important;
        --dsw-alias-brand-primary: #ff9940 !important;
        --dsw-alias-button-primary-fill: #ff9940 !important;
        --dsw-alias-button-primary-hover: #f58220 !important;
        --dsw-alias-label-primary-foreground: #ffffff !important;
        --dsw-alias-label-primary: #2d3748 !important;
        --dsw-alias-label-secondary: #4a5568 !important;
        --dsw-alias-label-tertiary: #718096 !important;
        --dsw-alias-label-dimmed: #a0aec0 !important;
        --dsw-alias-label-caption: #718096 !important;
        --dsw-alias-interactive-bg-hover: rgba(255, 153, 64, 0.08) !important;
        --dsw-alias-interactive-bg-active: rgba(255, 153, 64, 0.15) !important;
        --dsw-alias-border-l1: #dcdcdc !important;
        --dsw-alias-border-l2: #e8e8e8 !important;
        --dsw-alias-border-l3: #d0d0d0 !important;
        --dsw-alias-border-l4: #a0aec0 !important;
        --dsw-alias-markdown-code-block: #f0f2f5 !important;
        --dsw-alias-markdown-code-block-banner: #e6e9ee !important;
        --dsw-alias-scrollbar-bg-l2: #dcdcdc !important;
        --dsw-alias-scrollbar-hover-l2: #ff9940 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #fafafa !important; color: #2d3748 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #f0f2f5 !important;
        color: #2d3748 !important;
        border-color: #dcdcdc !important;
      }
[class*="selector"], [class*="themeCube"] {
        color: #2d3748 !important;
        background-color: #e8e8e8 !important;
      }
      [class*="selected"], [class*="themeCube"]:hover {
        border-color: #ff9940 !important;
      }
    `
  }
};

function applyAppTheme(themeKey) {
  let styleEl = document.getElementById("dsh-builtin-theme-styles");
  // 协同互斥：若页面存在来自插件市场的同类主题标签，主动清理避免双重覆盖冲突
  const pluginStyleEl = document.getElementById("dsh-theme-escook-styles");
  if (pluginStyleEl && pluginStyleEl.parentNode) {
    pluginStyleEl.parentNode.removeChild(pluginStyleEl);
  }

  if (!themeKey || themeKey === "default" || !ESCOOK_THEMES[themeKey]) {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    document.documentElement.removeAttribute("data-dsh-theme");
    safeSetItem("dsh_selected_theme", "default");
    console.info("🎨 [dsh-desktop] 已恢复系统默认主题");
    return;
  }

  const themeObj = ESCOOK_THEMES[themeKey];
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "dsh-builtin-theme-styles";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = themeObj.css;
  document.documentElement.setAttribute("data-dsh-theme", `escook-${themeKey}`);
  safeSetItem("dsh_selected_theme", themeKey);
  console.info(`🌸 [dsh-desktop] 已激活主题: ${themeObj.name}`);
}

window.__DSH_BUILTIN_THEMES__ = {
  themes: ESCOOK_THEMES,
  apply: applyAppTheme,
  getCurrent: () => safeGetItem("dsh_selected_theme") || "default",
  registerThemes(newThemes) {
    if (!newThemes || typeof newThemes !== "object") return;
    let hasUpdate = false;
    for (const [key, val] of Object.entries(newThemes)) {
      if (val && typeof val === "object" && val.css) {
        ESCOOK_THEMES[key] = val;
        hasUpdate = true;
      }
    }
    if (hasUpdate) {
      console.info("✨ [dsh-desktop] 已通过插件市场热挂载/更新主题矩阵:", Object.keys(ESCOOK_THEMES));
      const current = safeGetItem("dsh_selected_theme");
      if (current && ESCOOK_THEMES[current]) {
        applyAppTheme(current);
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Built-in Font Schemes: 常用高可读性编程与界面字体 (Code & UI Fonts)
// ---------------------------------------------------------------------------
const BUILTIN_FONTS = {
  "default": {
    name: "系统默认等宽 (System Default)",
    desc: "使用系统原生默认等宽字体（Consolas / Segoe UI Mono），平稳通用",
    mono: "Consolas, 'Segoe UI Mono', 'Courier New', monospace"
  },
  "cascadia": {
    name: "Cascadia Code (微软现代 · 免联网)",
    desc: "Windows 11/10 官方内置，原生支持强大代码连字（->, !=, ===, =>）",
    mono: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
    cdn: "https://cdn.jsdelivr.net/npm/@fontsource/cascadia-code@5.0.14/index.css"
  },
  "jetbrains": {
    name: "JetBrains Mono (极客推荐)",
    desc: "为代码阅读专设的优质等宽字体，专业连字，优先命中本地已装字体",
    mono: "'JetBrains Mono', 'JetBrains Mono NL', 'JetBrainsMono Nerd Font', 'Fira Code', 'Cascadia Code', Consolas, monospace",
    cdn: "https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.0.18/index.css"
  },
  "fira": {
    name: "Fira Code (经典连字)",
    desc: "全球知名的编程连字字体（->, !=, ===, >=），视觉辨识度极高",
    mono: "'Fira Code', 'FiraCode Nerd Font', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    cdn: "https://cdn.jsdelivr.net/npm/@fontsource/fira-code@5.0.12/index.css"
  },
  "consolas": {
    name: "Consolas (经典 Windows)",
    desc: "Windows 经典内置等宽字体，开箱即用，轻快整洁零延迟",
    mono: "Consolas, 'Courier New', monospace"
  }
};

const BUILTIN_UI_FONTS = {
  "default": {
    name: "系统默认界面 (System UI)",
    desc: "跟随系统默认字体体系 (-apple-system, Segoe UI, sans-serif)",
    family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei UI', sans-serif"
  },
  "modern": {
    name: "现代无衬线 (Inter / 微软雅黑)",
    desc: "清爽现代的高可读性排版，提升对话与侧栏阅读质感",
    family: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei UI', sans-serif",
    cdn: "https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.18/index.css"
  },
  "chinese": {
    name: "优质中文黑体 (苹方 / 微软雅黑 / 思源)",
    desc: "深度针对中文文本优化视觉字重，字形圆润饱满更护眼",
    family: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans SC', sans-serif"
  }
};

function applyAppFont(fontKey) {
  let styleEl = document.getElementById("dsh-custom-font-styles");
  let linkEl = document.getElementById("dsh-custom-font-link");

  if (!fontKey || fontKey === "default" || !BUILTIN_FONTS[fontKey]) {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    if (linkEl && linkEl.parentNode) linkEl.parentNode.removeChild(linkEl);
    safeSetItem("dsh_selected_font", "default");
    console.info("🔤 [dsh-desktop] 已恢复系统默认代码字体");
    return;
  }

  const fontObj = BUILTIN_FONTS[fontKey];

  if (fontObj.cdn) {
    if (!linkEl) {
      linkEl = document.createElement("link");
      linkEl.id = "dsh-custom-font-link";
      linkEl.rel = "stylesheet";
      document.head.appendChild(linkEl);
    }
    if (linkEl.href !== fontObj.cdn) {
      linkEl.href = fontObj.cdn;
    }
  } else if (linkEl && linkEl.parentNode) {
    linkEl.parentNode.removeChild(linkEl);
  }

  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "dsh-custom-font-styles";
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    :root, html, body {
      --ds-font-family-code: ${fontObj.mono} !important;
      --dsw-font-family-code: ${fontObj.mono} !important;
      --dsw-font-markdown-code-font-family: ${fontObj.mono} !important;
      --font-mono: ${fontObj.mono} !important;
      --font-family-mono: ${fontObj.mono} !important;
      --font-code: ${fontObj.mono} !important;
      --vscode-editor-font-family: ${fontObj.mono} !important;
    }
    pre, code, kbd, samp,
    pre *, code *,
    [class*="codeBlock"], [class*="codeBlock"] *,
    [class*="code-block"], [class*="code-block"] *,
    [class*="mono"], [class*="mono"] *,
    .font-mono, .font-mono *,
    textarea.code,
    .xterm, .xterm *, .monaco-editor, .monaco-editor *,
    .cm-editor, .cm-editor * {
      font-family: ${fontObj.mono} !important;
      font-feature-settings: "calt" 1, "liga" 1 !important;
      text-rendering: optimizeLegibility !important;
    }
  `;
  safeSetItem("dsh_selected_font", fontKey);
  console.info(`🔤 [dsh-desktop] 已激活编程字体: ${fontObj.name}`);
}

function applyAppUiFont(fontKey) {
  let styleEl = document.getElementById("dsh-custom-ui-font-styles");
  let linkEl = document.getElementById("dsh-custom-ui-font-link");

  if (!fontKey || fontKey === "default" || !BUILTIN_UI_FONTS[fontKey]) {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    if (linkEl && linkEl.parentNode) linkEl.parentNode.removeChild(linkEl);
    safeSetItem("dsh_selected_ui_font", "default");
    console.info("🔤 [dsh-desktop] 已恢复系统默认界面字体");
    return;
  }

  const fontObj = BUILTIN_UI_FONTS[fontKey];

  if (fontObj.cdn) {
    if (!linkEl) {
      linkEl = document.createElement("link");
      linkEl.id = "dsh-custom-ui-font-link";
      linkEl.rel = "stylesheet";
      document.head.appendChild(linkEl);
    }
    if (linkEl.href !== fontObj.cdn) {
      linkEl.href = fontObj.cdn;
    }
  } else if (linkEl && linkEl.parentNode) {
    linkEl.parentNode.removeChild(linkEl);
  }

  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "dsh-custom-ui-font-styles";
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    :root, html, body {
      --dsw-font-family: ${fontObj.family} !important;
      --ds-font-family: ${fontObj.family} !important;
      --dsw-font-markdown-base-font-family: ${fontObj.family} !important;
      --dsw-font-markdown-h1-font-family: ${fontObj.family} !important;
      --dsw-font-markdown-h2-font-family: ${fontObj.family} !important;
      --dsw-font-markdown-h3-font-family: ${fontObj.family} !important;
      --dsw-font-markdown-h4-font-family: ${fontObj.family} !important;
      --dsw-font-markdown-table-font-family: ${fontObj.family} !important;
      --dsw-font-markdown-small-font-family: ${fontObj.family} !important;
      --font-sans: ${fontObj.family} !important;
      --font-family-sans: ${fontObj.family} !important;
    }
    body, html, #root, #app, main, header, nav, aside, section,
    button, input, select, textarea:not(.code),
    p, span:not([class*="token"]):not([class*="code"]),
    div:not([class*="code"]):not([class*="mono"]):not([class*="xterm"]):not(.monaco-editor):not(.cm-editor),
    [class*="text"], [class*="title"], [class*="card"], [class*="message"], [class*="chat"] {
      font-family: ${fontObj.family} !important;
    }
  `;
  safeSetItem("dsh_selected_ui_font", fontKey);
  console.info(`🔤 [dsh-desktop] 已激活界面字体: ${fontObj.name}`);
}

// ---------------------------------------------------------------------------
// Native Desktop Modal: 🎨 主题与外观切换弹窗 (Theme Selection Modal)
// ---------------------------------------------------------------------------
function showThemeModal() {
  const existingModal = document.getElementById("dsh-desktop-theme-modal-overlay");
  if (existingModal && existingModal.parentNode) {
    existingModal.parentNode.removeChild(existingModal);
  }

  const currentTheme = safeGetItem("dsh_selected_theme") || "default";
  const currentFont = safeGetItem("dsh_selected_font") || "default";
  const currentUiFont = safeGetItem("dsh_selected_ui_font") || "default";
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
      width: 560px;
      max-width: 90vw;
      max-height: 85vh;
      background: ${cardBg};
      color: ${textColor};
      border: 1px solid ${borderColor};
      border-radius: 16px;
      padding: 24px 28px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      box-sizing: border-box;
      animation: dshScaleUp 0.15s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    ">
      <!-- 头部 -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid ${borderColor};">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 38px; height: 38px; border-radius: 10px; background: #0f172a; display: flex; align-items: center; justify-content: center; font-size: 18px;">
            🎨
          </div>
          <div>
            <h3 style="margin: 0; font-size: 16px; font-weight: 700;">外观与字体设置</h3>
            <p style="margin: 2px 0 0 0; font-size: 12px; opacity: 0.7;">即时切换界面配色方案与代码编程字体</p>
          </div>
        </div>
        <button id="dsh-theme-modal-close-btn" style="background: none; border: none; font-size: 18px; cursor: pointer; color: inherit; opacity: 0.6; padding: 4px 8px; border-radius: 6px;" title="关闭">✕</button>
      </div>

      <!-- 主题标题 -->
      <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
        <span>🎨</span>
        <span>界面配色主题 (5 款)</span>
      </div>

      <!-- 主题列表 -->
      <div style="display: grid; gap: 8px; margin-bottom: 16px;">
        <!-- 系统默认主题 -->
        <div class="dsh-theme-option-card" data-theme-key="default" style="
          padding: 12px 14px;
          background: ${currentTheme === 'default' ? 'rgba(37,99,235,0.1)' : itemBg};
          border: 1.5px solid ${currentTheme === 'default' ? '#2563eb' : borderColor};
          border-radius: 10px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: all 0.2s;
        ">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 22px; height: 22px; border-radius: 6px; background: #3b82f6; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 11px;">⚙️</div>
            <div>
              <div style="font-weight: 600; font-size: 12.5px;">系统默认主题 (Default)</div>
              <div style="font-size: 10.5px; opacity: 0.65; margin-top: 1px;">跟随 DeepSeek Harness 官方标准暗黑/明亮模式</div>
            </div>
          </div>
          <span style="font-size: 13px; font-weight: 700; color: #2563eb;">${currentTheme === 'default' ? '✓' : ''}</span>
        </div>

        <!-- 4 款彬哥主题 -->
        ${Object.entries(ESCOOK_THEMES).map(([key, t]) => {
          const isSelected = currentTheme === key;
          return `
            <div class="dsh-theme-option-card" data-theme-key="${key}" style="
              padding: 12px 14px;
              background: ${isSelected ? 'rgba(255,204,102,0.12)' : itemBg};
              border: 1.5px solid ${isSelected ? t.colorPreview : borderColor};
              border-radius: 10px;
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: space-between;
              transition: all 0.2s;
            ">
              <div style="display: flex; align-items: center; gap: 10px;">
                <div style="width: 22px; height: 22px; border-radius: 6px; background: ${t.bgPreview}; border: 2px solid ${t.colorPreview}; display: flex; align-items: center; justify-content: center; font-size: 11px;">🌸</div>
                <div>
                  <div style="font-weight: 600; font-size: 12.5px; display: flex; align-items: center; gap: 6px;">
                    <span>${t.name}</span>
                    <span style="font-size: 9px; padding: 1px 4px; border-radius: 4px; background: ${t.colorPreview}; color: ${t.type === 'dark' && key !== 'dark' ? '#1f2430' : '#fff'}; font-weight: 700;">${t.type.toUpperCase()}</span>
                  </div>
                  <div style="font-size: 10.5px; opacity: 0.65; margin-top: 1px;">${t.desc}</div>
                </div>
              </div>
              <span style="font-size: 13px; font-weight: 700; color: ${t.colorPreview};">${isSelected ? '✓' : ''}</span>
            </div>
          `;
        }).join('')}
      </div>

      <!-- 代码字体设置分割线与标题 -->
      <div style="margin: 14px 0 10px 0; padding-top: 14px; border-top: 1px solid ${borderColor}; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 14px;">🔤</span>
          <span style="font-weight: 700; font-size: 13px;">代码与编程字体 (Code Fonts)</span>
        </div>
        <span style="font-size: 11px; opacity: 0.6;">支持专业连字 (Ligatures)</span>
      </div>

      <!-- 代码字体列表 -->
      <div style="display: grid; gap: 8px; margin-bottom: 14px;">
        ${Object.entries(BUILTIN_FONTS).map(([fKey, fObj]) => {
          const isSelected = currentFont === fKey;
          return `
            <div class="dsh-font-option-card" data-font-key="${fKey}" style="
              padding: 10px 14px;
              background: ${isSelected ? 'rgba(37,99,235,0.1)' : itemBg};
              border: 1.5px solid ${isSelected ? '#2563eb' : borderColor};
              border-radius: 10px;
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: space-between;
              transition: all 0.2s;
            ">
              <div style="display: flex; align-items: center; gap: 10px;">
                <div style="font-family: ${fObj.mono}; font-size: 12px; font-weight: 700; opacity: 0.85; width: 44px; color: #2563eb;">
                  =&gt; ==
                </div>
                <div>
                  <div style="font-weight: 600; font-size: 12px; font-family: ${fObj.mono};">${fObj.name}</div>
                  <div style="font-size: 10.5px; opacity: 0.6; margin-top: 1px;">${fObj.desc}</div>
                </div>
              </div>
              <span style="font-size: 13px; font-weight: 700; color: #2563eb;">${isSelected ? '✓' : ''}</span>
            </div>
          `;
        }).join('')}
      </div>

      <!-- 界面全局字体设置分割线与标题 -->
      <div style="margin: 14px 0 10px 0; padding-top: 14px; border-top: 1px solid ${borderColor}; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 14px;">💬</span>
          <span style="font-weight: 700; font-size: 13px;">界面全局字体 (UI Fonts)</span>
        </div>
        <span style="font-size: 11px; opacity: 0.6;">优化对话与整体排版</span>
      </div>

      <!-- 界面全局字体列表 -->
      <div style="display: grid; gap: 8px; margin-bottom: 16px;">
        ${Object.entries(BUILTIN_UI_FONTS).map(([uKey, uObj]) => {
          const isSelected = currentUiFont === uKey;
          return `
            <div class="dsh-ui-font-option-card" data-ui-font-key="${uKey}" style="
              padding: 10px 14px;
              background: ${isSelected ? 'rgba(37,99,235,0.1)' : itemBg};
              border: 1.5px solid ${isSelected ? '#2563eb' : borderColor};
              border-radius: 10px;
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: space-between;
              transition: all 0.2s;
            ">
              <div style="display: flex; align-items: center; gap: 10px;">
                <div style="font-family: ${uObj.family}; font-size: 14px; font-weight: 700; opacity: 0.85; width: 44px; color: #2563eb;">
                  Aa 文
                </div>
                <div>
                  <div style="font-weight: 600; font-size: 12px; font-family: ${uObj.family};">${uObj.name}</div>
                  <div style="font-size: 10.5px; opacity: 0.6; margin-top: 1px;">${uObj.desc}</div>
                </div>
              </div>
              <span style="font-size: 13px; font-weight: 700; color: #2563eb;">${isSelected ? '✓' : ''}</span>
            </div>
          `;
        }).join('')}
      </div>

      <!-- 底部跳转插件市场按钮 -->
      <div style="padding-top: 12px; border-top: 1px solid ${borderColor}; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <div style="font-size: 11px; opacity: 0.55;">🌸 致敬 liulongbin1314 / escook-theme</div>
        <button id="dsh-open-market-themes-btn" style="
          padding: 5px 10px;
          background: none;
          border: 1px solid ${borderColor};
          border-radius: 6px;
          color: inherit;
          font-size: 11.5px;
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

  // 绑定主题选项点击
  overlay.querySelectorAll(".dsh-theme-option-card").forEach((card) => {
    card.addEventListener("click", () => {
      const key = card.dataset.themeKey;
      applyAppTheme(key);
      showThemeModal();
    });
  });

  // 绑定代码字体选项点击
  overlay.querySelectorAll(".dsh-font-option-card").forEach((card) => {
    card.addEventListener("click", () => {
      const fKey = card.dataset.fontKey;
      applyAppFont(fKey);
      showThemeModal();
    });
  });

  // 绑定界面全局字体选项点击
  overlay.querySelectorAll(".dsh-ui-font-option-card").forEach((card) => {
    card.addEventListener("click", () => {
      const uKey = card.dataset.uiFontKey;
      applyAppUiFont(uKey);
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

      <!-- 核心操作区：客户端与官方内核双更新卡片 -->
      <div style="display: grid; gap: 12px; margin-bottom: 20px;">
        <!-- 客户端外壳更新卡片 -->
        <div style="background: ${itemBg}; border: 1px solid ${borderColor}; border-radius: 12px; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
          <div>
            <div style="font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px;">
              <span>🖥️ 桌面客户端</span>
              <span style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: rgba(37,99,235,0.1); color: #2563eb; font-weight: 600;">v${cachedAppInfo.version}</span>
            </div>
            <div style="font-size: 12px; opacity: 0.7; margin-top: 2px;">支持在应用内一键下载更新包并覆盖安装</div>
          </div>
          <button id="dsh-modal-check-app-update-btn" style="
            padding: 7px 14px;
            background: #2563eb;
            color: #ffffff;
            border: none;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            box-shadow: 0 2px 6px rgba(37,99,235,0.2);
            transition: opacity 0.2s;
          ">
            <span>🔍 检查外壳更新</span>
          </button>
        </div>

        <!-- 官方内核更新卡片 -->
        <div style="background: ${itemBg}; border: 1px solid ${borderColor}; border-radius: 12px; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
          <div>
            <div style="font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px;">
              <span>⚡ DeepSeek 官方内核</span>
              <span style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: rgba(16,185,129,0.1); color: #10b981; font-weight: 600;">v${cachedAppInfo.kernelVersion || '0.1.1-rc.2'}</span>
            </div>
            <div style="font-size: 12px; opacity: 0.7; margin-top: 2px;">支持后台全自动升级并无感热重启服务</div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button id="dsh-modal-check-kernel-update-btn" style="
              padding: 7px 12px;
              background: transparent;
              color: inherit;
              border: 1px solid ${borderColor};
              border-radius: 8px;
              font-size: 12px;
              font-weight: 600;
              cursor: pointer;
              display: inline-flex;
              align-items: center;
              gap: 4px;
              transition: all 0.2s;
            ">
              <span>⚡ 检查内核</span>
            </button>
            <button id="dsh-modal-upgrade-kernel-btn" style="
              padding: 7px 12px;
              background: #10b981;
              color: #ffffff;
              border: none;
              border-radius: 8px;
              font-size: 12px;
              font-weight: 600;
              cursor: pointer;
              display: inline-flex;
              align-items: center;
              gap: 4px;
              box-shadow: 0 2px 6px rgba(16,185,129,0.2);
              transition: opacity 0.2s;
            ">
              <span>🚀 一键升级</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 核心特性与亮点 (v1.2.0) -->
      <div style="margin-bottom: 20px;">
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">🌟 核心特性 (v1.2.0)</div>
        <div style="display: grid; gap: 8px; font-size: 12px; line-height: 1.5;">
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #3b82f6;">
            <strong>👁️ 官方原生视觉多模态支持</strong>：深度适配 0.1.2 官方内核，支持图片拖拽/粘贴直传与原生视觉理解。
          </div>
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #f59e0b;">
            <strong>🎨 4 款专属精雕美学主题</strong>：重构日落金橙、琥珀流金、皇家罗兰、蜜柑亮橙等 8 款高质感配色矩阵，即时无缝换肤。
          </div>
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #8b5cf6;">
            <strong>🧩 5 大社区生态插件深度兼容</strong>：插件市场（DSH Market）、侧边栏增强工作台、自动执行模式等开箱即用。
          </div>
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #10b981;">
            <strong>⚡ 客户端与官方内核双热升级</strong>：外壳与官方内核均支持一键在线版本检测、静默下载与秒级热重载。
          </div>
          <div style="padding: 8px 12px; background: ${itemBg}; border-radius: 8px; border-left: 3px solid #06b6d4;">
            <strong>🛠️ 35 个工业级研发技能库</strong>：内置 TDD 测试驱动、代码审查、架构设计等 35 个 Matt Pocock 专家技能。
          </div>
        </div>
      </div>

      <!-- 底部内核版本与诊断导出 (P1-5 & P3-1) -->
      <div style="padding-top: 14px; border-top: 1px solid ${borderColor}; font-size: 11px; opacity: 0.75; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
        <div>
          <div>官方内核：<strong>@deepseek-ai/dsh@${cachedAppInfo.kernelVersion || '0.1.1-rc.2'}</strong></div>
          <div style="margin-top: 2px; opacity: 0.8;">环境：Node ${cachedAppInfo.nodeVersion || '20'} · Electron ${cachedAppInfo.electronVersion || '33'} · 端口 ${cachedAppInfo.port || '3080'}</div>
        </div>
        <button id="dsh-modal-copy-diag-btn" style="
          padding: 5px 10px;
          background: ${itemBg};
          color: inherit;
          border: 1px solid ${borderColor};
          border-radius: 6px;
          font-size: 11px;
          cursor: pointer;
          transition: all 0.2s;
        " title="复制全量诊断日志供问题排查">📋 复制诊断信息</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeModal = () => { overlay.style.display = "none"; };
  overlay.querySelector("#dsh-modal-close-btn").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // 复制诊断日志
  const copyDiagBtn = overlay.querySelector("#dsh-modal-copy-diag-btn");
  if (copyDiagBtn) {
    copyDiagBtn.addEventListener("click", () => {
      const diag = cachedAppInfo.diagnosticText || `DSH Desktop v${cachedAppInfo.version || '1.2.3'} | Kernel: ${cachedAppInfo.kernelVersion} | Node: ${cachedAppInfo.nodeVersion} | Port: ${cachedAppInfo.port || 3080}`;
      navigator.clipboard.writeText(diag).then(() => {
        copyDiagBtn.innerText = "✅ 已复制";
        setTimeout(() => { copyDiagBtn.innerText = "📋 复制诊断信息"; }, 1500);
      }).catch(() => {
        alert("系统诊断信息:\n" + diag);
      });
    });
  }

  // 客户端检查更新
  const checkAppBtn = overlay.querySelector("#dsh-modal-check-app-update-btn");
  if (checkAppBtn) {
    checkAppBtn.addEventListener("click", async () => {
      checkAppBtn.innerText = "🔄 检查中...";
      checkAppBtn.style.opacity = "0.75";
      checkAppBtn.disabled = true;
      try {
        await ipcRenderer.invoke("check-for-updates-manual");
      } catch (err) {
        alert("检查外壳更新出错: " + err.message);
      } finally {
        setTimeout(() => {
          checkAppBtn.innerText = "🔍 检查外壳更新";
          checkAppBtn.style.opacity = "1";
          checkAppBtn.disabled = false;
        }, 2000);
      }
    });
  }

  // 内核检查更新
  const checkKernelBtn = overlay.querySelector("#dsh-modal-check-kernel-update-btn");
  if (checkKernelBtn) {
    checkKernelBtn.addEventListener("click", async () => {
      checkKernelBtn.innerText = "🔄 检查中...";
      checkKernelBtn.style.opacity = "0.75";
      checkKernelBtn.disabled = true;
      try {
        await ipcRenderer.invoke("check-for-kernel-updates-manual");
      } catch (err) {
        alert("检查内核更新出错: " + err.message);
      } finally {
        setTimeout(() => {
          checkKernelBtn.innerText = "⚡ 检查内核";
          checkKernelBtn.style.opacity = "1";
          checkKernelBtn.disabled = false;
        }, 2000);
      }
    });
  }

  // 内核一键升级
  const upgradeKernelBtn = overlay.querySelector("#dsh-modal-upgrade-kernel-btn");
  if (upgradeKernelBtn) {
    upgradeKernelBtn.addEventListener("click", async () => {
      upgradeKernelBtn.innerText = "⏳ 正在发起...";
      upgradeKernelBtn.style.opacity = "0.75";
      upgradeKernelBtn.disabled = true;
      try {
        await ipcRenderer.invoke("upgrade-kernel-manual");
      } catch (err) {
        alert("发起内核升级出错: " + err.message);
      } finally {
        setTimeout(() => {
          upgradeKernelBtn.innerText = "🚀 一键升级";
          upgradeKernelBtn.style.opacity = "1";
          upgradeKernelBtn.disabled = false;
        }, 2000);
      }
    });
  }
}


// =========================================================================
// showFeedbackModal: 问题反馈独立弹窗
// =========================================================================
function showFeedbackModal() {
  let overlay = document.getElementById("dsh-desktop-feedback-modal-overlay");
  if (overlay) {
    overlay.style.display = "flex";
    return;
  }

  overlay = document.createElement("div");
  overlay.id = "dsh-desktop-feedback-modal-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    z-index: 999999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
  `;

  // 获取当前生效模型
  let currentModel = "glm-5.3";
  try {
    const homeDir = process.env.USERPROFILE || process.env.HOME || "";
    const sPath = path.join(homeDir, ".dsh", "settings.yaml");
    if (fs.existsSync(sPath)) {
      const s = fs.readFileSync(sPath, "utf8");
      const m = s.match(/agent-default-model:[\s\S]*?model:\s*([^\n\r]+)/);
      if (m && m[1]) currentModel = m[1].trim();
    }
  } catch (e) {}

  let selectedType = "bug"; // "bug" | "feature" | "experience"

  overlay.innerHTML = `
    <style>
      #dsh-desktop-feedback-modal-overlay * { box-sizing: border-box; }
      .dsh-fb-container {
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        color: var(--dsw-alias-label-primary, #0f172a);
        border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.08));
        border-radius: 16px;
        width: 620px;
        max-width: 95vw;
        box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.35);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        animation: dshFbFadeIn 0.2s ease-out;
      }
      @keyframes dshFbFadeIn {
        from { opacity: 0; transform: scale(0.97); }
        to { opacity: 1; transform: scale(1); }
      }
      .dsh-fb-header {
        padding: 18px 24px;
        border-bottom: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.06));
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
      }
      .dsh-fb-title-wrap {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .dsh-fb-icon-box {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: rgba(239, 130, 12, 0.12);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        color: var(--dsw-alias-brand-primary, #ef820c);
        flex-shrink: 0;
      }
      .dsh-fb-title {
        font-size: 15px;
        font-weight: 700;
        color: var(--dsw-alias-label-primary, #0f172a);
      }
      .dsh-fb-desc {
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, #64748b);
        margin-top: 2px;
      }
      .dsh-fb-close {
        font-size: 16px;
        color: var(--dsw-alias-label-tertiary, #94a3b8);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 6px;
        transition: all 0.2s;
      }
      .dsh-fb-close:hover {
        color: var(--dsw-alias-label-primary, #0f172a);
        background: rgba(0, 0, 0, 0.05);
      }
      .dsh-fb-body {
        padding: 22px 24px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        max-height: 75vh;
        overflow-y: auto;
      }
      .dsh-fb-type-group {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 10px;
      }
      .dsh-fb-type-btn {
        padding: 9px 12px;
        border-radius: 10px;
        font-size: 12.5px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all 0.18s;
        user-select: none;
        background: var(--dsw-alias-bg-layer-2, #ffffff);
        border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.1));
        color: var(--dsw-alias-label-secondary, #475569);
      }
      .dsh-fb-type-btn:hover {
        border-color: var(--dsw-alias-brand-primary, #ea580c);
        color: var(--dsw-alias-brand-primary, #ea580c);
      }
      .dsh-fb-type-btn.active-bug {
        background: rgba(239, 68, 68, 0.08);
        border: 1.5px solid #ef4444;
        color: #ef4444;
        font-weight: 600;
      }
      .dsh-fb-type-btn.active-feature {
        background: rgba(239, 130, 12, 0.08);
        border: 1.5px solid var(--dsw-alias-brand-primary, #ea580c);
        color: var(--dsw-alias-brand-primary, #ea580c);
        font-weight: 600;
      }
      .dsh-fb-type-btn.active-experience {
        background: rgba(59, 130, 246, 0.08);
        border: 1.5px solid #3b82f6;
        color: #3b82f6;
        font-weight: 600;
      }
      .dsh-fb-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .dsh-fb-label {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #0f172a);
      }
      .dsh-fb-input {
        width: 100%;
        padding: 9px 14px;
        border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.12));
        background: var(--dsw-alias-bg-layer-2, #ffffff);
        color: var(--dsw-alias-label-primary, #0f172a);
        font-size: 13px;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .dsh-fb-input:focus {
        border-color: var(--dsw-alias-brand-primary, #ea580c);
        box-shadow: 0 0 0 3px rgba(239, 130, 12, 0.12);
      }
      .dsh-fb-textarea {
        width: 100%;
        padding: 10px 14px;
        border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.12));
        background: var(--dsw-alias-bg-layer-2, #ffffff);
        color: var(--dsw-alias-label-primary, #0f172a);
        font-size: 13px;
        outline: none;
        resize: vertical;
        min-height: 100px;
        font-family: inherit;
        line-height: 1.5;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .dsh-fb-textarea:focus {
        border-color: var(--dsw-alias-brand-primary, #ea580c);
        box-shadow: 0 0 0 3px rgba(239, 130, 12, 0.12);
      }
      .dsh-fb-diag-card {
        background: var(--dsw-alias-bg-layer-3, #f8fafc);
        border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.08));
        border-radius: 10px;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .dsh-fb-diag-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .dsh-fb-diag-title {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--dsw-alias-label-secondary, #475569);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .dsh-fb-diag-badge {
        font-size: 11px;
        color: #10b981;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .dsh-fb-diag-grid {
        font-size: 11.5px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        color: var(--dsw-alias-label-secondary, #64748b);
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px 20px;
        line-height: 1.5;
      }
      .dsh-fb-footer {
        padding: 14px 24px;
        border-top: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.06));
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: var(--dsw-alias-bg-base, #ffffff);
      }
      .dsh-fb-copy-btn {
        padding: 7px 14px;
        background: var(--dsw-alias-bg-layer-2, #ffffff);
        border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.12));
        border-radius: 8px;
        color: var(--dsw-alias-label-primary, #0f172a);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s;
      }
      .dsh-fb-copy-btn:hover {
        background: var(--dsw-alias-bg-layer-3, #f1f5f9);
      }
      .dsh-fb-submit-btn {
        background: var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill, #ea580c));
        color: #ffffff;
        border: none;
        border-radius: 8px;
        padding: 7px 18px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s;
      }
      .dsh-fb-submit-btn:hover {
        filter: brightness(1.08);
        box-shadow: 0 2px 10px rgba(239, 130, 12, 0.3);
      }
      .dsh-fb-cancel-btn {
        background: transparent;
        border: none;
        color: var(--dsw-alias-label-secondary, #64748b);
        font-size: 12px;
        cursor: pointer;
        padding: 6px 12px;
      }
      .dsh-fb-cancel-btn:hover {
        color: var(--dsw-alias-label-primary, #0f172a);
      }
    </style>

    <div class="dsh-fb-container">
      <!-- 头部 -->
      <div class="dsh-fb-header">
        <div class="dsh-fb-title-wrap">
          <div class="dsh-fb-icon-box">🌟</div>
          <div>
            <div class="dsh-fb-title">问题反馈与建议</div>
            <div class="dsh-fb-desc">快速向维护者上报 Bug、功能建议与排错诊断信息</div>
          </div>
        </div>
        <div class="dsh-fb-close" id="dsh-fb-close-btn" title="关闭">✕</div>
      </div>

      <!-- 主体内容 -->
      <div class="dsh-fb-body">
        <!-- 反馈类型 -->
        <div class="dsh-fb-field">
          <div class="dsh-fb-label">反馈类型</div>
          <div class="dsh-fb-type-group">
            <div class="dsh-fb-type-btn active-bug" data-type="bug" id="dsh-fb-type-bug">
              <span>💥</span><span>Bug 缺陷</span>
            </div>
            <div class="dsh-fb-type-btn" data-type="feature" id="dsh-fb-type-feature">
              <span>💡</span><span>功能建议</span>
            </div>
            <div class="dsh-fb-type-btn" data-type="experience" id="dsh-fb-type-experience">
              <span>💬</span><span>使用体验</span>
            </div>
          </div>
        </div>

        <!-- 简要标题 -->
        <div class="dsh-fb-field">
          <div class="dsh-fb-label">简要标题（如：流式生成中途中断）</div>
          <input type="text" class="dsh-fb-input" id="dsh-fb-title-input" placeholder="一句话概括碰到的问题..." />
        </div>

        <!-- 详细描述 -->
        <div class="dsh-fb-field">
          <div class="dsh-fb-label">详细描述与复现步骤</div>
          <textarea class="dsh-fb-textarea" id="dsh-fb-desc-input" placeholder="请描述触发问题的操作、预期效果和实际表现..."></textarea>
        </div>

        <!-- 自动附带的诊断信息包 -->
        <div class="dsh-fb-diag-card">
          <div class="dsh-fb-diag-head">
            <div class="dsh-fb-diag-title">
              <span style="color:var(--dsw-alias-brand-primary, #ea580c); font-weight:bold; font-family:monospace;">&gt;_</span>
              <span>自动附带的诊断信息包</span>
            </div>
            <div class="dsh-fb-diag-badge">
              <span>🛡️</span><span>敏感 Key 已脱敏</span>
            </div>
          </div>
          <div class="dsh-fb-diag-grid">
            <div>客户端: <span style="color:var(--dsw-alias-label-primary, #0f172a); font-weight:600;">v1.2.3 (win32)</span></div>
            <div>当前模型: <span style="color:var(--dsw-alias-label-primary, #0f172a); font-weight:600;">${currentModel}</span></div>
            <div>沙箱权限: <span style="color:var(--dsw-alias-label-primary, #0f172a); font-weight:600;">workspace-readwrite</span></div>
            <div>内核版本: <span style="color:var(--dsw-alias-label-primary, #0f172a); font-weight:600;">0.1.2</span></div>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="dsh-fb-footer">
        <button class="dsh-fb-copy-btn" id="dsh-fb-copy-btn">
          <span>📋</span>
          <span id="dsh-fb-copy-label">复制诊断报告</span>
        </button>
        <div style="display:flex; align-items:center; gap:10px;">
          <button class="dsh-fb-cancel-btn" id="dsh-fb-cancel-btn">取消</button>
          <button class="dsh-fb-submit-btn" id="dsh-fb-submit-btn">
            <span>↗</span>
            <span>在 GitHub 提交 Issue</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => { overlay.style.display = "none"; };
  overlay.querySelector("#dsh-fb-close-btn").onclick = close;
  overlay.querySelector("#dsh-fb-cancel-btn").onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  // 反馈类型切换
  const typeBtns = overlay.querySelectorAll(".dsh-fb-type-btn");
  typeBtns.forEach(btn => {
    btn.onclick = () => {
      typeBtns.forEach(b => {
        b.className = "dsh-fb-type-btn";
      });
      selectedType = btn.dataset.type;
      if (selectedType === "bug") btn.className = "dsh-fb-type-btn active-bug";
      else if (selectedType === "feature") btn.className = "dsh-fb-type-btn active-feature";
      else if (selectedType === "experience") btn.className = "dsh-fb-type-btn active-experience";
    };
  });

  const generateReport = () => {
    const titleVal = (overlay.querySelector("#dsh-fb-title-input").value || "").trim();
    const descVal = (overlay.querySelector("#dsh-fb-desc-input").value || "").trim();
    const typeLabelMap = { bug: "[Bug 缺陷]", feature: "[功能建议]", experience: "[使用体验]" };
    const prefix = typeLabelMap[selectedType] || "[用户反馈]";
    const issueTitle = titleVal ? `${prefix} ${titleVal}` : `${prefix} 来自 DSH Desktop 客户端反馈`;

    const body = `### 反馈类型
${prefix}

### 问题描述与复现步骤
${descVal || "（未填写具体描述）"}

### 运行环境诊断包 (已脱敏)
- **客户端版本**: DSH Desktop v1.2.3 (win32)
- **当前生效模型**: ${currentModel}
- **沙箱运行权限**: workspace-readwrite
- **内核版本**: 0.1.2
- **操作系统**: ${navigator.platform}
- **上报时间戳**: ${new Date().toLocaleString()}
`;
    return { title: issueTitle, body };
  };

  // 复制诊断报告
  const copyBtn = overlay.querySelector("#dsh-fb-copy-btn");
  const copyLabel = overlay.querySelector("#dsh-fb-copy-label");
  if (copyBtn) {
    copyBtn.onclick = () => {
      const { title, body } = generateReport();
      const fullText = `# ${title}\n\n${body}`;
      navigator.clipboard.writeText(fullText).then(() => {
        copyLabel.textContent = "✅ 已复制报告！";
        setTimeout(() => { copyLabel.textContent = "复制诊断报告"; }, 2000);
      });
    };
  }

  // 在 GitHub 提交 Issue
  const submitBtn = overlay.querySelector("#dsh-fb-submit-btn");
  if (submitBtn) {
    submitBtn.onclick = () => {
      const { title, body } = generateReport();
      const issueUrl = `https://github.com/Simon-yyy/DeepSeek-Harness-DeskTop/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      try {
        const { shell } = require("electron");
        shell.openExternal(issueUrl);
      } catch (e) {
        window.open(issueUrl, "_blank");
      }
      close();
    };
  }
}

async function showModelConfigModal() {
  const fs = require("fs");
  const path = require("path");
  const https = require("https");
  const http = require("http");

  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  const dshDir = process.env.DSH_HOME || path.join(homeDir, ".dsh");
  const settingsFile = path.join(dshDir, "settings.yaml");
  const credsFile = path.join(dshDir, ".credentials.yaml");

  // 读取 ~/.dsh/settings.yaml 与主进程 DPAPI 凭据 (R0-1 核心红线)
  let settingsText = "";
  let credsMap = {};
  try {
    credsMap = (await ipcRenderer.invoke("get-credentials")) || {};
  } catch (_e) {}
  try {
    if (fs.existsSync(settingsFile)) settingsText = fs.readFileSync(settingsFile, "utf8");
  } catch (e) {
    console.error("Failed to read settings.yaml", e);
  }

  function getApiKeyFromCreds(envKey) {
    if (!envKey) return "";
    // 彻底收敛：严禁任何明文文件回退解析 (P0-1)
    let val = credsMap[envKey] || "";
    // 物理自愈销毁历史遗留的 LocalStorage 明文 API Key 镜像 (P0 安全红线)
    try {
      if (localStorage.getItem("dsh_key_" + envKey)) {
        localStorage.removeItem("dsh_key_" + envKey);
      }
    } catch (_e) {}
    return val;
  }

  function setApiKeyToCreds(envKey, val) {
    if (!envKey) return;
    credsMap[envKey] = val;
  }


  // 默认五大官方服务商预设
  const DEFAULT_PROVIDERS = [
    {
      id: "agent-router",
      name: "agent router",
      protocol: "openai",
      apiKeyEnv: "AGENT_ROUTER_API_KEY",
      baseURL: "https://ps.air-outer.com/v1",
      models: ["glm-5.3"],
      timeout: "300",
      modelConfigs: {}
    },
    {
      id: "bigmodel",
      name: "GLM (智谱清言)",
      protocol: "openai",
      apiKeyEnv: "BIGMODEL_API_KEY",
      baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
      models: [
        "glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5",
        "glm-5-turbo", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash"
      ],
      timeout: "180",
      modelConfigs: {}
    },
    {
      id: "deepseek",
      name: "DeepSeek 官方",
      protocol: "openai",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseURL: "https://api.deepseek.com/v1",
      models: ["deepseek-chat", "deepseek-reasoner"],
      timeout: "300",
      modelConfigs: {}
    },
    {
      id: "openai",
      name: "OpenAI 官方",
      protocol: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      baseURL: "https://api.openai.com/v1",
      models: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
      timeout: "120",
      modelConfigs: {}
    },
    {
      id: "anthropic",
      name: "Anthropic 官方",
      protocol: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseURL: "https://api.anthropic.com/v1",
      models: ["claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
      timeout: "180",
      modelConfigs: {}
    }
  ];

  // 1. 优先从 providers-config.json 与 LocalStorage 读取完整持久化配置（杜绝覆盖自定义提供方与胶囊专属配置）
  const providersJsonFile = path.join(dshDir, "providers-config.json");
  let savedProvidersSnapshot = null;

  // 严格 HTML 转义工具函数，防范 DOM XSS 注入 (5.7 P1)
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 严格脱敏自愈辅助函数 (R0-1 核心红线)
  function purgeSensitiveKeysFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.providers)) return false;
    let hadSensitive = false;
    for (const p of snapshot.providers) {
      if ("apiKey" in p) { delete p.apiKey; hadSensitive = true; }
      if (p.modelConfigs && typeof p.modelConfigs === "object") {
        for (const m of Object.keys(p.modelConfigs)) {
          if (p.modelConfigs[m] && "apiKey" in p.modelConfigs[m]) {
            delete p.modelConfigs[m].apiKey;
            hadSensitive = true;
          }
        }
      }
    }
    return hadSensitive;
  }

  try {
    if (fs.existsSync(providersJsonFile)) {
      const parsed = JSON.parse(fs.readFileSync(providersJsonFile, "utf8"));
      if (parsed && Array.isArray(parsed.providers) && parsed.providers.length > 0) {
        if (purgeSensitiveKeysFromSnapshot(parsed)) {
          try {
            fs.writeFileSync(providersJsonFile, JSON.stringify(parsed, null, 2), "utf8");
          } catch (_e) {}
        }
        savedProvidersSnapshot = parsed;
      }
    }
  } catch (e) {
    console.warn("[dsh-desktop] Failed to read providers-config.json:", e);
  }

  // 必须无条件独立扫描并物理清洗 LocalStorage 中潜伏的历史敏感快照 (5.7 P0)
  try {
    const localSaved = localStorage.getItem("dsh_providers_snapshot_v2");
    if (localSaved) {
      const parsed = JSON.parse(localSaved);
      if (parsed && typeof parsed === "object") {
        if (purgeSensitiveKeysFromSnapshot(parsed)) {
          try {
            localStorage.setItem("dsh_providers_snapshot_v2", JSON.stringify(parsed));
          } catch (_e) {}
        }
        if (!savedProvidersSnapshot && Array.isArray(parsed.providers) && parsed.providers.length > 0) {
          savedProvidersSnapshot = parsed;
        }
      }
    }
  } catch (_e) {}

  let providersData;
  if (savedProvidersSnapshot && Array.isArray(savedProvidersSnapshot.providers) && savedProvidersSnapshot.providers.length > 0) {
    providersData = savedProvidersSnapshot.providers;
    // 补齐 DEFAULT_PROVIDERS 中未被包含的官方默认预设字段属性（如用户自定义或增量模型配置）
    for (const defP of DEFAULT_PROVIDERS) {
      const existing = providersData.find(p => p.id === defP.id);
      if (existing) {
        if (!existing.apiKeyEnv) existing.apiKeyEnv = defP.apiKeyEnv;
        if (!existing.protocol) existing.protocol = defP.protocol;
        if (!existing.modelConfigs) existing.modelConfigs = {};
        if (!Array.isArray(existing.models) || existing.models.length === 0) existing.models = [...defP.models];
      }
    }
  } else {
    // 首次运行或无快照时，使用官方默认预设初始化
    providersData = JSON.parse(JSON.stringify(DEFAULT_PROVIDERS));
  }

  // 按单个 envKey 精确加载主进程安全凭据 (5.11 项四：消除批量明文越权并修复界面空白)
  await Promise.all(
    providersData.map(async (p) => {
      if (p.apiKeyEnv) {
        try {
          const val = await ipcRenderer.invoke("get-credentials", p.apiKeyEnv);
          if (val) credsMap[p.apiKeyEnv] = val;
        } catch (_e) {}
      }
    })
  );

  // 2. 从 settings.yaml 提取当前激活的默认服务商与默认模型
  let defaultProvFromSettings = "";
  let defaultModelFromSettings = "";
  if (settingsText) {
    const dm = settingsText.match(/agent-default-model:[\s\S]*?provider:\s*([^\n\r]+)[\s\S]*?model:\s*([^\n\r]+)/);
    if (dm && dm[1] && dm[2]) {
      defaultProvFromSettings = dm[1].trim();
      defaultModelFromSettings = dm[2].trim();
    }
  }

  // 3. 动态从 settings.yaml 与 LocalStorage 提取完整全量模型列表（增量合入）
  try {
    for (const p of providersData) {
      if (!p.modelConfigs) p.modelConfigs = {};
      // 优先从 settings.yaml 提取该服务商下的所有 models: [{ id: ... }]
      if (settingsText.includes(p.id + ":")) {
        const idIdx = settingsText.indexOf(p.id + ":");
        const block = settingsText.slice(idIdx, idIdx + 3000);
        
        // 提取 baseURL（若为空或未保存过快照时才由 settings 覆盖）
        const mBase = block.match(/baseURL:\s*([^,\n}\r]+)/);
        if (mBase && (!p.baseURL || !savedProvidersSnapshot)) p.baseURL = mBase[1].trim();

        // 提取 models 列表（全面兼容 Flow 格式与 YAML 列表格式）
        const modelsMatch = block.match(/models:\s*(\[[\s\S]*?\])/);
        if (modelsMatch) {
          const rawList = modelsMatch[1];
          const ids = [];
          const regId = /id:\s*([a-zA-Z0-9_.-]+)/g;
          let m;
          while ((m = regId.exec(rawList)) !== null) {
            ids.push(m[1].trim());
          }
          if (ids.length > 0) {
            p.models = Array.from(new Set([...(p.models || []), ...ids]));
          }
        }
      }

      // 双保险：与 LocalStorage 镜像比对，确保扫出来的全部模型绝不因重新安装丢失
      try {
        const localSaved = localStorage.getItem("dsh_models_" + p.id);
        if (localSaved) {
          const parsedLocal = JSON.parse(localSaved);
          if (Array.isArray(parsedLocal) && parsedLocal.length > 0) {
            p.models = Array.from(new Set([...(p.models || []), ...parsedLocal]));
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    console.warn("Parse settings.yaml models error", e);
  }

  // 4. 激活当前默认选中的服务商与模型胶囊
  const targetProviderId = defaultProvFromSettings || savedProvidersSnapshot?.activeProviderId || providersData[0]?.id || "";
  const targetModelName = defaultModelFromSettings || savedProvidersSnapshot?.activeModelName || "";

  let selectedProviderIdx = providersData.findIndex(p => p.id === targetProviderId);
  if (selectedProviderIdx < 0) selectedProviderIdx = 0;

  const curInitialProvider = providersData[selectedProviderIdx] || providersData[0];
  let selectedModelName = "";
  if (targetModelName && curInitialProvider && Array.isArray(curInitialProvider.models) && curInitialProvider.models.includes(targetModelName)) {
    selectedModelName = targetModelName;
  } else {
    selectedModelName = (curInitialProvider && curInitialProvider.models && curInitialProvider.models[0]) || "";
  }
  let showModelApiKey = false;
  let testResult = null; // { success: boolean, message: string }
  let isTesting = false;

  // 移除旧弹窗
  const oldModal = document.getElementById("dsh-desktop-model-modal-overlay");
  if (oldModal && oldModal.parentNode) oldModal.parentNode.removeChild(oldModal);

  const overlay = document.createElement("div");
  overlay.id = "dsh-desktop-model-modal-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.65));
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    z-index: 999999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
  `;

  // 动态注入针对当前主题的 CSS 变量驱动样式表
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    #dsh-desktop-model-modal-overlay * { box-sizing: border-box; }
    .dsh-adv-container {
      width: 980px;
      max-width: 96vw;
      height: 780px;
      max-height: 94vh;
      background: var(--dsw-alias-bg-layer-1, #ffffff);
      border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.08));
      border-radius: 14px;
      box-shadow: 0 20px 50px -10px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: var(--dsw-alias-label-primary, #0f172a);
    }
    .dsh-adv-header {
      padding: 15px 22px;
      border-bottom: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.06));
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--dsw-alias-bg-base, #ffffff);
    }
    .dsh-adv-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--dsw-alias-label-primary, #0f172a);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dsh-adv-desc {
      font-size: 12px;
      color: var(--dsw-alias-label-secondary, #64748b);
      opacity: 0.9;
      margin-top: 3px;
    }
    .dsh-adv-close {
      font-size: 16px;
      color: var(--dsw-alias-label-tertiary, #94a3b8);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      transition: all 0.2s;
    }
    .dsh-adv-close:hover {
      color: var(--dsw-alias-label-primary, #0f172a);
      background: rgba(0, 0, 0, 0.05);
    }
    .dsh-adv-body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .dsh-adv-nav {
      width: 230px;
      background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f8fafc));
      border-right: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.06));
      padding: 14px 10px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .dsh-adv-nav-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow-y: auto;
    }
    .dsh-adv-nav-label {
      font-size: 10.5px;
      font-weight: bold;
      color: var(--dsw-alias-label-tertiary, #94a3b8);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0 8px 6px 8px;
    }
    .dsh-adv-nav-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: 9px;
      font-size: 12.5px;
      color: var(--dsw-alias-label-secondary, #475569);
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s;
    }
    .dsh-adv-nav-item:hover {
      background: var(--dsw-specific-sidebar-nav-item-hover, rgba(239, 130, 12, 0.08));
      color: var(--dsw-alias-label-primary, #0f172a);
    }
    .dsh-adv-nav-item.active {
      background: var(--dsw-specific-sidebar-nav-item-active, rgba(239, 130, 12, 0.12));
      color: var(--dsw-specific-sidebar-nav-item-active-accent, var(--dsw-alias-brand-primary, #ea580c));
      font-weight: 600;
      border-color: var(--dsw-specific-sidebar-nav-item-active-accent, var(--dsw-alias-brand-primary, rgba(239, 130, 12, 0.3)));
    }
    .dsh-adv-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 6px rgba(16, 185, 129, 0.5);
      flex-shrink: 0;
    }
    .dsh-adv-status-dot.empty {
      background: #94a3b8;
      box-shadow: none;
    }
    .dsh-adv-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--dsw-alias-bg-layer-2, #ffffff);
      color: var(--dsw-alias-label-tertiary, #64748b);
      border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.08));
      font-family: ui-monospace, monospace;
    }
    .dsh-adv-nav-item.active .dsh-adv-badge {
      background: rgba(239, 130, 12, 0.15);
      color: var(--dsw-alias-brand-primary, #ea580c);
      border-color: var(--dsw-alias-brand-primary, #ea580c);
    }
    .dsh-adv-del-prov {
      opacity: 0;
      font-size: 12px;
      color: #ef4444;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      transition: all 0.2s;
    }
    .dsh-adv-nav-item:hover .dsh-adv-del-prov { opacity: 1; }
    .dsh-adv-del-prov:hover { background: rgba(239, 68, 68, 0.12); }
    .dsh-adv-nav-actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 10px;
      border-top: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.06));
    }
    .dsh-adv-add-prov-btn {
      width: 100%;
      padding: 7px;
      border: 1px dashed var(--dsw-alias-border-base, rgba(0, 0, 0, 0.15));
      border-radius: 8px;
      background: transparent;
      color: var(--dsw-alias-label-secondary, #475569);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .dsh-adv-add-prov-btn:hover {
      border-color: var(--dsw-alias-brand-primary, #ea580c);
      color: var(--dsw-alias-brand-primary, #ea580c);
    }
    .dsh-adv-reset-btn {
      background: none;
      border: none;
      color: var(--dsw-alias-label-tertiary, #94a3b8);
      font-size: 11px;
      cursor: pointer;
      text-align: center;
      padding: 4px;
      transition: color 0.2s;
    }
    .dsh-adv-reset-btn:hover {
      color: var(--dsw-alias-label-secondary, #475569);
      text-decoration: underline;
    }
    .dsh-adv-main {
      flex: 1;
      padding: 18px 22px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
      background: var(--dsw-alias-bg-layer-1, #ffffff);
    }
    .dsh-adv-card {
      background: var(--dsw-alias-bg-layer-2, #ffffff);
      border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.08));
      border-radius: 12px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
    }
    .dsh-adv-card-head {
      font-size: 11.5px;
      font-weight: 700;
      color: var(--dsw-alias-label-secondary, #64748b);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dsh-adv-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .dsh-adv-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .dsh-adv-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--dsw-alias-label-primary, #0f172a);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dsh-adv-input, .dsh-adv-select {
      background: var(--dsw-alias-bg-layer-3, #f8fafc);
      border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.1));
      border-radius: 8px;
      padding: 7px 12px;
      color: var(--dsw-alias-label-primary, #0f172a);
      font-size: 12.5px;
      outline: none;
      transition: all 0.2s;
    }
    .dsh-adv-input:focus, .dsh-adv-select:focus {
      background: #ffffff;
      border-color: var(--dsw-alias-brand-primary, #ea580c);
      box-shadow: 0 0 0 3px var(--dsw-specific-sidebar-nav-item-hover, rgba(239, 130, 12, 0.15));
    }
    .dsh-adv-capsules-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px;
      background: var(--dsw-alias-bg-layer-3, #f8fafc);
      border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.08));
      border-radius: 10px;
      min-height: 48px;
      align-items: center;
      max-height: 160px;
      overflow-y: auto;
    }
    .dsh-adv-capsule {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-family: ui-monospace, monospace;
      cursor: pointer;
      user-select: none;
      transition: all 0.15s;
    }
    .dsh-adv-capsule.active {
      background: var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill, #ea580c));
      color: #ffffff;
      font-weight: bold;
      box-shadow: 0 2px 8px var(--dsw-specific-sidebar-nav-item-active, rgba(239, 130, 12, 0.35));
    }
    .dsh-adv-capsule.normal {
      background: var(--dsw-alias-bg-layer-2, #ffffff);
      border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.08));
      color: var(--dsw-alias-label-secondary, #475569);
    }
    .dsh-adv-capsule.normal:hover {
      border-color: var(--dsw-alias-brand-primary, #ea580c);
      color: var(--dsw-alias-brand-primary, #ea580c);
    }
    .dsh-adv-capsule-del {
      opacity: 0.7;
      font-size: 13px;
      cursor: pointer;
      padding: 0 2px;
    }
    .dsh-adv-capsule-del:hover { opacity: 1; color: #ef4444; }
    .dsh-adv-dedicated-card {
      background: var(--dsw-alias-bg-layer-2, #ffffff);
      border: 1.5px solid var(--dsw-specific-sidebar-nav-item-active-accent, var(--dsw-alias-brand-primary, rgba(239, 130, 12, 0.4)));
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 4px 14px rgba(239, 130, 12, 0.06);
    }
    .dsh-adv-dedicated-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.06));
      padding-bottom: 10px;
    }
    .dsh-adv-test-strip {
      border-top: 1px dashed var(--dsw-alias-border-base, rgba(0, 0, 0, 0.1));
      padding-top: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .dsh-adv-footer {
      padding: 14px 22px;
      background: var(--dsw-alias-bg-base, #ffffff);
      border-top: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.06));
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .dsh-adv-primary-btn {
      background: var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill, #ea580c));
      color: #ffffff;
      border: none;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .dsh-adv-primary-btn:hover {
      filter: brightness(1.08);
      box-shadow: 0 2px 10px rgba(239, 130, 12, 0.3);
    }
  `
  overlay.appendChild(styleEl);

  const container = document.createElement("div");
  container.className = "dsh-adv-container";
  overlay.appendChild(container);

  // 渲染函数
  function render() {
    const curP = providersData[selectedProviderIdx] || providersData[0];
    if (!curP.models.includes(selectedModelName) && curP.models.length > 0) {
      selectedModelName = curP.models[0];
    }
    const curApiKey = getApiKeyFromCreds(curP.apiKeyEnv);

    // 获取当前选定模型的专属配置
    if (!curP.modelConfigs) curP.modelConfigs = {};
    const dedicatedCfg = curP.modelConfigs[selectedModelName] || {};
    const activeBaseURL = dedicatedCfg.baseURL ?? curP.baseURL;
    const activeApiKey = dedicatedCfg.apiKey ?? curApiKey;
    const activeTimeout = dedicatedCfg.timeout ?? (curP.timeout || "300");

    container.innerHTML = `
      <!-- 头部 -->
      <div class="dsh-adv-header">
        <div>
          <div class="dsh-adv-title">
            <span style="color:var(--dsw-alias-brand-primary, #ef820c);">🗄️</span>
            <span>模型服务商与模型胶囊独立配置中心</span>
          </div>
          <div class="dsh-adv-desc">每个模型均以小胶囊呈现；点击任意模型胶囊可展开其专属独立配置，彼此互不干扰，支持按模型单独测试连通性。</div>
        </div>
        <div class="dsh-adv-close" id="dsh-adv-close-btn" title="关闭">✕</div>
      </div>

      <!-- 主体 -->
      <div class="dsh-adv-body">
        <!-- 左侧提供方导航 -->
        <div class="dsh-adv-nav">
          <div class="dsh-adv-nav-list">
            <div class="dsh-adv-nav-label">服务商列表 (${providersData.length})</div>
            ${providersData.map((p, idx) => {
              const hasKey = Boolean(getApiKeyFromCreds(p.apiKeyEnv) || p.id === "ollama");
              return `
                <div class="dsh-adv-nav-item ${idx === selectedProviderIdx ? 'active' : ''}" data-idx="${idx}">
                  <div style="display:flex; align-items:center; gap:8px; overflow:hidden; flex:1;">
                    <span class="dsh-adv-status-dot ${hasKey ? '' : 'empty'}" title="${hasKey ? '已配置密钥凭证' : '未配置密钥凭证'}"></span>
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(p.name)}</span>
                  </div>
                  <div style="display:flex; align-items:center; gap:6px;">
                    <span class="dsh-adv-badge">${p.models.length} 胶囊</span>
                    ${providersData.length > 1 ? `<span class="dsh-adv-del-prov" data-del-idx="${idx}" title="删除此服务商">🗑</span>` : ''}
                  </div>
                </div>
              `;
            }).join("")}
          </div>

          <div class="dsh-adv-nav-actions">
            <button class="dsh-adv-add-prov-btn" id="dsh-adv-add-provider">
              <span>+ 添加自定义提供方</span>
            </button>
            <button class="dsh-adv-reset-btn" id="dsh-adv-reset-default">
              <span>↺ 恢复默认官方预设</span>
            </button>
          </div>
        </div>

        <!-- 右侧主配置区 -->
        <div class="dsh-adv-main">
          <!-- 1. 服务商通用统一配置 -->
          <div class="dsh-adv-card">
            <div class="dsh-adv-card-head">
              <span style="color:var(--dsw-alias-brand-primary, #ef820c);">⚙️</span>
              <span>服务商通用配置 (${escapeHtml(curP.name)})</span>
            </div>
            <div class="dsh-adv-grid">
              <div class="dsh-adv-field">
                <label class="dsh-adv-label">提供方名称</label>
                <input type="text" class="dsh-adv-input" id="dsh-adv-p-name" value="${escapeHtml(curP.name)}" />
              </div>
              <div class="dsh-adv-field">
                <label class="dsh-adv-label">通信协议类型 (Protocol)</label>
                <select class="dsh-adv-select" id="dsh-adv-p-protocol">
                  <option value="openai" ${curP.protocol === 'openai' ? 'selected' : ''}>OpenAI 兼容协议 (Chat Completions: /v1/chat/completions)</option>
                  <option value="anthropic" ${curP.protocol === 'anthropic' ? 'selected' : ''}>Anthropic Messages 协议 (/v1/messages)</option>
                  <option value="ollama" ${curP.protocol === 'ollama' ? 'selected' : ''}>Ollama 本地协议 (http://127.0.0.1:11434)</option>
                </select>
              </div>
            </div>
          </div>

          <!-- 2. 模型小胶囊列表区 -->
          <div style="display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:700; color:var(--dsw-alias-label-primary, #fafafa);">
              <span style="display:flex; align-items:center; gap:6px;">
                <span style="color:var(--dsw-alias-brand-primary, #ef820c);">✦</span>
                <span>收容管理的模型列表 (每个模型独立胶囊 · 点击切换配置)</span>
              </span>
              <div style="display:flex; align-items:center; gap:10px;">
                <button id="dsh-adv-scan-models-btn" style="
                  padding: 3px 10px;
                  background: var(--dsw-specific-sidebar-nav-item-hover, rgba(239, 130, 12, 0.12));
                  border: 1px solid var(--dsw-alias-brand-primary, #ef820c);
                  color: var(--dsw-alias-brand-primary, #ef820c);
                  border-radius: 6px;
                  font-size: 11px;
                  font-weight: 600;
                  cursor: pointer;
                  display: inline-flex;
                  align-items: center;
                  gap: 4px;
                  transition: all 0.2s;
                " title="向当前服务商发送端点探测，自动拉取官方开放的所有可用模型">
                  <span>🔍</span>
                  <span>扫描官方全部模型</span>
                </button>
                <span style="font-size:11px; opacity:0.8; font-family:monospace;">${curP.models.length} 款模型</span>
              </div>
            </div>

            <div class="dsh-adv-capsules-wrap">
              ${curP.models.length === 0 ? '<span style="font-size:12px; opacity:0.6; padding:4px;">暂无模型，请在下方键入并点击添加</span>' : curP.models.map(m => `
                <div class="dsh-adv-capsule ${m === selectedModelName ? 'active' : 'normal'}" data-model="${escapeHtml(m)}">
                  <span>✦ ${escapeHtml(m)}</span>
                  <span class="dsh-adv-capsule-del" data-del="${escapeHtml(m)}" title="移除 ${escapeHtml(m)}">×</span>
                </div>
              `).join("")}
            </div>

            <div style="display:flex; gap:8px;">
              <input type="text" class="dsh-adv-input" id="dsh-adv-add-input" style="flex:1;" placeholder="输入模型名（如 glm-5.3 / deepseek-v4）按 Enter 立即生成独立胶囊" />
              <button class="dsh-adv-primary-btn" id="dsh-adv-add-btn" style="padding:0 18px;">+ 添加胶囊</button>
            </div>
          </div>

          <!-- 3. 选定模型专属独立配置卡片 -->
          ${selectedModelName ? `
            <div class="dsh-adv-dedicated-card">
              <div class="dsh-adv-dedicated-head">
                <div style="font-size:13px; font-weight:700; color:var(--dsw-alias-label-primary, #fafafa); display:flex; align-items:center; gap:6px;">
                  <span style="color:var(--dsw-alias-brand-primary, #ef820c);">⚙️</span>
                  <span>【<span style="color:var(--dsw-alias-brand-primary, #ef820c);">${escapeHtml(selectedModelName)}</span>】模型专属配置</span>
                  <span style="font-size:11px; opacity:0.75; font-weight:normal;">(独立配置 · 互不干扰)</span>
                </div>
                <button id="dsh-adv-del-cur-btn" style="color:#f87171; font-size:12px; cursor:pointer; background:none; border:none;">🗑 移除此模型</button>
              </div>

              <div class="dsh-adv-field">
                <label class="dsh-adv-label">🌐 专属 API Base URL (接口基地址)</label>
                <input type="text" class="dsh-adv-input" id="dsh-adv-baseurl" value="${escapeHtml(activeBaseURL)}" placeholder="https://..." />
              </div>

              <div class="dsh-adv-field">
                <div style="display:flex; justify-content:space-between;">
                  <label class="dsh-adv-label">🔑 专属 API Key (密钥凭证: ${escapeHtml(curP.apiKeyEnv)})</label>
                  <span id="dsh-adv-toggle-key-view" style="font-size:11px; color:var(--dsw-alias-brand-primary, #ef820c); cursor:pointer;">${showModelApiKey ? '🔒 隐藏密文' : '👁 显示明文'}</span>
                </div>
                <input type="${showModelApiKey ? 'text' : 'password'}" class="dsh-adv-input" id="dsh-adv-apikey" value="${escapeHtml(activeApiKey)}" placeholder="sk-..." />
              </div>

              <div class="dsh-adv-field">
                <label class="dsh-adv-label">⏱️ 请求超时控制 (秒)</label>
                <input type="text" class="dsh-adv-input" id="dsh-adv-timeout" value="${escapeHtml(activeTimeout)}" placeholder="默认自适应滑动保活 (按输入长度 120s~300s 弹性伸缩，持续传输永不断开)" />
              </div>

              <!-- 连通性测试区 -->
              <div class="dsh-adv-test-strip">
                <div id="dsh-adv-test-result" style="
                  font-size: 11.5px;
                  color: var(--dsw-alias-label-secondary, #cccccc);
                  background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.05));
                  border: 1px solid var(--dsw-alias-border-base, rgba(255, 255, 255, 0.1));
                  padding: 6px 12px;
                  border-radius: 6px;
                  display: flex;
                  align-items: center;
                  gap: 6px;
                  flex: 1;
                ">
                  ${testResult ? `
                    <span>${testResult.success ? '✅' : '❌'}</span>
                    <span style="color:${testResult.success ? '#10b981' : '#f87171'};">${escapeHtml(testResult.message)}</span>
                  ` : `
                    <span>⚡</span>
                    <span>向当前模型【${escapeHtml(selectedModelName)}】接口发送轻量探测请求以验证连通性。</span>
                  `}
                </div>
                <button id="dsh-adv-test-btn" style="
                  padding: 6px 16px;
                  background: var(--dsw-specific-sidebar-nav-item-hover, rgba(239, 130, 12, 0.12));
                  border: 1px solid var(--dsw-alias-brand-primary, #ef820c);
                  color: var(--dsw-alias-brand-primary, #ef820c);
                  border-radius: 8px;
                  font-size: 12px;
                  font-weight: 600;
                  cursor: pointer;
                  display: flex;
                  align-items: center;
                  gap: 6px;
                  white-space: nowrap;
                  transition: all 0.2s;
                ">
                  ${isTesting ? '<span>⏳ 探测中...</span>' : '<span>⚡ 测试连通性</span>'}
                </button>
              </div>
            </div>
          ` : `
            <div style="
              padding: 40px 20px;
              background: var(--dsw-alias-bg-layer-2, #29292c);
              border: 1px dashed var(--dsw-alias-border-base, rgba(255, 255, 255, 0.15));
              border-radius: 12px;
              text-align: center;
              color: var(--dsw-alias-label-secondary, #cccccc);
            ">
              <div style="font-size: 24px; margin-bottom: 8px;">✦</div>
              <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px;">当前服务商尚未添加任何模型胶囊</div>
              <div style="font-size: 11.5px; opacity: 0.75;">请在上方输入框键入模型标识（如 glm-5.3、deepseek-chat 等）按 Enter，即可为其独立配置 Base URL 与密钥。</div>
            </div>
          `}
        </div>
      </div>

      <!-- 底部 -->
      <div class="dsh-adv-footer">
        <div style="display:flex; align-items:center; gap:12px;">
          <button id="dsh-adv-open-config-btn" style="
            padding: 6px 14px;
            background: var(--dsw-alias-bg-layer-2, #f8fafc);
            border: 1px solid var(--dsw-alias-border-base, rgba(0, 0, 0, 0.1));
            color: var(--dsw-alias-label-secondary, #475569);
            border-radius: 8px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s;
          " title="使用系统默认编辑器打开 ~/.dsh/settings.yaml 配置文件">
            <span>📄</span>
            <span>打开配置文件</span>
          </button>
          <span id="dsh-adv-save-tip" style="font-size:12px; color:#10b981; display:none; align-items:center; gap:4px;">
            <span>✅</span>
            <span>配置已成功保存并即时生效！</span>
          </span>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <button id="dsh-adv-cancel-btn" style="
            padding: 6px 16px;
            border: 1px solid var(--dsw-alias-border-base, rgba(255, 255, 255, 0.2));
            background: transparent;
            color: var(--dsw-alias-label-secondary, #cccccc);
            border-radius: 8px;
            font-size: 12px;
            cursor: pointer;
          ">取消</button>
          <button class="dsh-adv-primary-btn" id="dsh-adv-save-btn" style="padding: 6px 22px;">💾 保存配置</button>
        </div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    const close = () => { overlay.style.display = "none"; };
    
    // 打开配置文件按钮
    const openConfigBtn = container.querySelector("#dsh-adv-open-config-btn");
    if (openConfigBtn) {
      openConfigBtn.onclick = () => {
        try {
          const { shell } = require("electron");
          shell.openPath(settingsFile);
        } catch (e) {
          alert("打开配置文件失败: " + e.message);
        }
      };
    }

    container.querySelector("#dsh-adv-close-btn").onclick = close;
    container.querySelector("#dsh-adv-cancel-btn").onclick = close;

    // 切换服务商
    container.querySelectorAll(".dsh-adv-nav-item").forEach(el => {
      el.onclick = (e) => {
        if (e.target.classList.contains("dsh-adv-del-prov")) return;
        // 暂存当前正在编辑的模型专属配置
        if (selectedModelName && curP) {
          if (!curP.modelConfigs) curP.modelConfigs = {};
          if (!curP.modelConfigs[selectedModelName]) curP.modelConfigs[selectedModelName] = {};
          const bIn = container.querySelector("#dsh-adv-baseurl");
          if (bIn) curP.modelConfigs[selectedModelName].baseURL = bIn.value.trim();
          const tIn = container.querySelector("#dsh-adv-timeout");
          if (tIn) curP.modelConfigs[selectedModelName].timeout = tIn.value.trim();
        }
        selectedProviderIdx = parseInt(el.dataset.idx, 10);
        selectedModelName = (providersData[selectedProviderIdx]?.models && providersData[selectedProviderIdx].models[0]) || "";
        testResult = null;
        render();
      };
    });

    // 删除服务商
    container.querySelectorAll(".dsh-adv-del-prov").forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const delIdx = parseInt(el.dataset.delIdx, 10);
        if (providersData.length <= 1) return;
        if (confirm("确定要删除服务商【" + providersData[delIdx].name + "】吗？")) {
          providersData.splice(delIdx, 1);
          if (selectedProviderIdx >= providersData.length) {
            selectedProviderIdx = providersData.length - 1;
          }
          selectedModelName = (providersData[selectedProviderIdx]?.models && providersData[selectedProviderIdx].models[0]) || "";
          testResult = null;
          render();
        }
      };
    });

    // 恢复默认预设
    const resetBtn = container.querySelector("#dsh-adv-reset-default");
    if (resetBtn) {
      resetBtn.onclick = () => {
        if (confirm("确定要恢复官方默认五大服务商预设吗？")) {
          providersData = JSON.parse(JSON.stringify(DEFAULT_PROVIDERS));
          try {
            if (fs.existsSync(providersJsonFile)) fs.unlinkSync(providersJsonFile);
          } catch (_e) {}
          try {
            localStorage.removeItem("dsh_providers_snapshot_v2");
          } catch (_e) {}
          selectedProviderIdx = 0;
          selectedModelName = providersData[0].models[0] || "";
          testResult = null;
          render();
        }
      };
    }

    // 添加服务商
    const addPBtn = container.querySelector("#dsh-adv-add-provider");
    if (addPBtn) {
      addPBtn.onclick = () => {
        const name = prompt("请输入新服务商名称:", "自定义提供方");
        if (name && name.trim()) {
          const id = "custom_" + Date.now();
          providersData.push({
            id,
            name: name.trim(),
            protocol: "openai",
            apiKeyEnv: id.toUpperCase() + "_API_KEY",
            baseURL: "https://api.openai.com/v1",
            models: ["default-model"],
            timeout: "300",
            modelConfigs: {}
          });
          selectedProviderIdx = providersData.length - 1;
          selectedModelName = "default-model";
          testResult = null;
          render();
        }
      };
    }

    // 实时更新当前提供方通用属性
    const pNameInput = container.querySelector("#dsh-adv-p-name");
    if (pNameInput) {
      pNameInput.oninput = () => {
        providersData[selectedProviderIdx].name = pNameInput.value.trim();
      };
    }
    const pProto = container.querySelector("#dsh-adv-p-protocol");
    if (pProto) {
      pProto.onchange = () => {
        providersData[selectedProviderIdx].protocol = pProto.value;
      };
    }

    // 专属独立配置更新
    const curP = providersData[selectedProviderIdx];
    if (selectedModelName) {
      if (!curP.modelConfigs) curP.modelConfigs = {};
      if (!curP.modelConfigs[selectedModelName]) curP.modelConfigs[selectedModelName] = {};

      const baseURLInput = container.querySelector("#dsh-adv-baseurl");
      if (baseURLInput) {
        baseURLInput.oninput = () => {
          curP.modelConfigs[selectedModelName].baseURL = baseURLInput.value.trim();
          curP.baseURL = baseURLInput.value.trim();
        };
      }

      const apiKeyInput = container.querySelector("#dsh-adv-apikey");
      if (apiKeyInput) {
        apiKeyInput.oninput = () => {
          const val = apiKeyInput.value.trim();
          curP.modelConfigs[selectedModelName].apiKey = val;
          setApiKeyToCreds(curP.apiKeyEnv, val);
        };
      }

      const timeoutInput = container.querySelector("#dsh-adv-timeout");
      if (timeoutInput) {
        timeoutInput.oninput = () => {
          curP.modelConfigs[selectedModelName].timeout = timeoutInput.value.trim();
        };
      }

      const toggleKeyView = container.querySelector("#dsh-adv-toggle-key-view");
      if (toggleKeyView && apiKeyInput) {
        toggleKeyView.onclick = () => {
          showModelApiKey = !showModelApiKey;
          render();
        };
      }

      // 移除当前模型
      const delCurBtn = container.querySelector("#dsh-adv-del-cur-btn");
      if (delCurBtn) {
        delCurBtn.onclick = () => {
          curP.models = curP.models.filter(m => m !== selectedModelName);
          delete curP.modelConfigs[selectedModelName];
          selectedModelName = curP.models[0] || "";
          testResult = null;
          render();
        };
      }
    }

    
    // 扫描官方全部模型功能
    const scanBtn = container.querySelector("#dsh-adv-scan-models-btn");
    if (scanBtn) {
      scanBtn.onclick = async () => {
        const key = getApiKeyFromCreds(curP.apiKeyEnv);
        const rawUrl = (curP.baseURL || "").trim();

        if (!rawUrl) {
          alert("请先填写当前服务商的 API Base URL 后再执行扫描！");
          return;
        }

        scanBtn.disabled = true;
        scanBtn.innerHTML = "<span>⏳</span><span>正在扫描官方模型...</span>";
        scanBtn.style.opacity = "0.75";

        let endpoint = rawUrl;
        if (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
        if (endpoint.endsWith("/v1")) {
          endpoint = endpoint + "/models";
        } else if (endpoint.includes("/v1/")) {
          const idx = endpoint.indexOf("/v1");
          endpoint = endpoint.slice(0, idx + 3) + "/models";
        } else {
          endpoint = endpoint + "/models";
        }

        const startTime = Date.now();
        try {
          const parsed = new URL(endpoint);
          const client = parsed.protocol === "https:" ? https : http;

          const req = client.request(parsed, {
            method: "GET",
            headers: {
              "Authorization": "Bearer " + key,
              "User-Agent": "claude-cli/2.1.119 (external, cli)"
            },
            timeout: 12000
          }, (res) => {
            let body = "";
            res.on("data", chunk => body += chunk);
            res.on("end", () => {
              scanBtn.disabled = false;
              scanBtn.style.opacity = "1";
              scanBtn.innerHTML = "<span>🔍</span><span>扫描官方全部模型</span>";

              if (res.statusCode >= 200 && res.statusCode < 400) {
                try {
                  const json = JSON.parse(body);
                  let rawList = [];
                  if (Array.isArray(json.data)) {
                    rawList = json.data;
                  } else if (Array.isArray(json.models)) {
                    rawList = json.models;
                  }

                  const discovered = rawList
                    .map(item => typeof item === "string" ? item : (item.id || item.name || ""))
                    .filter(Boolean)
                    .map(id => String(id).trim())
                    // 严格校验与净化：限制单个模型名字符长度不超过 128，且过滤危险控制字符 (5.7 P1)
                    .filter(id => id.length > 0 && id.length <= 128 && !/[\x00-\x1F\x7F]/.test(id))
                    // 单次最大限制 200 个模型，防 DoS 注入
                    .slice(0, 200);

                  if (discovered.length === 0) {
                    alert("未在该端点解析出模型列表，请核对接口返回格式。");
                    return;
                  }

                  let addedCount = 0;
                  if (!curP.modelConfigs) curP.modelConfigs = {};
                  for (const mId of discovered) {
                    if (!curP.models.includes(mId)) {
                      curP.models.push(mId);
                      // 严禁将明文 apiKey 存入 modelConfigs (R0-1 核心红线)
                      curP.modelConfigs[mId] = { baseURL: curP.baseURL };
                      addedCount++;
                    }
                  }

                  // 仅在前端与 LocalStorage 镜像缓存，严禁在扫描阶段提前触碰 settings.yaml 以免触发官方内核整页刷新
                  try {
                    localStorage.setItem("dsh_models_" + curP.id, JSON.stringify(curP.models));
                  } catch (_e) {}

                  const elapsed = Date.now() - startTime;
                  scanBtn.disabled = false;
                  scanBtn.style.opacity = "1";
                  scanBtn.innerHTML = "<span>✅</span><span>已收录 " + addedCount + " 款新胶囊 (" + elapsed + "ms)</span>";
                  setTimeout(() => {
                    if (scanBtn) scanBtn.innerHTML = "<span>🔍</span><span>扫描官方全部模型</span>";
                  }, 3000);
                  render();
                } catch (err) {
                  alert("解析模型列表失败: " + err.message);
                }
              } else {
                alert("扫描失败: HTTP " + res.statusCode + "\n接口返回: " + body.slice(0, 180));
              }
            });
          });

          req.on("error", (err) => {
            scanBtn.disabled = false;
            scanBtn.style.opacity = "1";
            scanBtn.innerHTML = "<span>🔍</span><span>扫描官方全部模型</span>";
            alert("扫描请求网络失败: " + err.message);
          });

          req.on("timeout", () => {
            req.destroy();
            scanBtn.disabled = false;
            scanBtn.style.opacity = "1";
            scanBtn.innerHTML = "<span>🔍</span><span>扫描官方全部模型</span>";
            alert("扫描请求超时，请检查网络或 Base URL 是否可达。");
          });

          req.end();
        } catch (e) {
          scanBtn.disabled = false;
          scanBtn.style.opacity = "1";
          scanBtn.innerHTML = "<span>🔍</span><span>扫描官方全部模型</span>";
          alert("Base URL 格式解析错误: " + e.message);
        }
      };
    }

    // 胶囊点击与删除
    container.querySelectorAll(".dsh-adv-capsule").forEach(el => {
      el.onclick = (e) => {
        if (e.target.classList.contains("dsh-adv-capsule-del")) return;
        if (selectedModelName && curP) {
          if (!curP.modelConfigs) curP.modelConfigs = {};
          if (!curP.modelConfigs[selectedModelName]) curP.modelConfigs[selectedModelName] = {};
          const bIn = container.querySelector("#dsh-adv-baseurl");
          if (bIn) curP.modelConfigs[selectedModelName].baseURL = bIn.value.trim();
          const tIn = container.querySelector("#dsh-adv-timeout");
          if (tIn) curP.modelConfigs[selectedModelName].timeout = tIn.value.trim();
        }
        selectedModelName = el.dataset.model;
        testResult = null;
        render();
      };
    });

    container.querySelectorAll(".dsh-adv-capsule-del").forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const delModel = el.dataset.del;
        curP.models = curP.models.filter(m => m !== delModel);
        if (curP.modelConfigs) delete curP.modelConfigs[delModel];
        try { localStorage.setItem("dsh_models_" + curP.id, JSON.stringify(curP.models)); } catch(e) {}
        if (selectedModelName === delModel) {
          selectedModelName = curP.models[0] || "";
        }
        testResult = null;
        render();
      };
    });

    // 添加胶囊
    const addInput = container.querySelector("#dsh-adv-add-input");
    const addBtn = container.querySelector("#dsh-adv-add-btn");
    const doAddCapsule = () => {
      const val = (addInput.value || "").trim();
      if (!val) return;
      if (!curP.models.includes(val)) {
        curP.models.push(val);
        if (!curP.modelConfigs) curP.modelConfigs = {};
        curP.modelConfigs[val] = { baseURL: curP.baseURL, apiKey: getApiKeyFromCreds(curP.apiKeyEnv) };
        selectedModelName = val;
        try { localStorage.setItem("dsh_models_" + curP.id, JSON.stringify(curP.models)); } catch(e) {}
      }
      testResult = null;
      render();
    };
    if (addBtn) addBtn.onclick = doAddCapsule;
    if (addInput) {
      addInput.onkeydown = (e) => {
        if (e.key === "Enter") doAddCapsule();
      };
    }

    // 连通性测试 (真实模型推理可用性测试 + 错误详情解析)
    const testBtn = container.querySelector("#dsh-adv-test-btn");
    if (testBtn && selectedModelName) {
      testBtn.onclick = async () => {
        if (isTesting) return;
        isTesting = true;
        render();

        const cfg = curP.modelConfigs[selectedModelName] || {};
        const rawUrl = (cfg.baseURL || curP.baseURL || "").trim();
        const key = cfg.apiKey || getApiKeyFromCreds(curP.apiKeyEnv);
        const startTime = Date.now();

        if (!rawUrl) {
          isTesting = false;
          testResult = { success: false, message: "探测失败: Base URL 未配置" };
          render();
          return;
        }

        const isAnthropic = curP.protocol === "anthropic";
        const cleanBaseUrl = rawUrl.replace(/\/+$/, "");

        const doHttpReq = (endpoint, method, headers, payload) => {
          return new Promise((resolve, reject) => {
            try {
              const parsed = new URL(endpoint);
              const client = parsed.protocol === "https:" ? https : http;
              const req = client.request(parsed, {
                method,
                headers: {
                  ...headers,
                  "User-Agent": "cline/3.0.0"
                },
                timeout: 10000
              }, (res) => {
                let body = "";
                res.on("data", (chunk) => { body += chunk; });
                res.on("end", () => {
                  resolve({ statusCode: res.statusCode || 0, body });
                });
              });

              req.on("error", reject);
              req.on("timeout", () => {
                req.destroy();
                reject(new Error("探测超时 (10s)，请检查网络与代理"));
              });

              if (payload) {
                req.write(payload);
              }
              req.end();
            } catch (err) {
              reject(err);
            }
          });
        };

        try {
          // 1. 首选：以当前模型发送极简推理请求 (Deep Inference Probe)
          const probeEndpoint = isAnthropic ? `${cleanBaseUrl}/messages` : `${cleanBaseUrl}/chat/completions`;
          const probeHeaders = isAnthropic
            ? {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
              }
            : {
                "Authorization": "Bearer " + key,
                "content-type": "application/json"
              };
          const probeBody = JSON.stringify({
            model: selectedModelName,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }]
          });

          let res = null;
          let netError = null;
          try {
            res = await doHttpReq(probeEndpoint, "POST", probeHeaders, probeBody);
          } catch (err) {
            netError = err;
          }

          const elapsed = Date.now() - startTime;
          isTesting = false;

          if (res && res.statusCode >= 200 && res.statusCode < 300) {
            testResult = {
              success: true,
              message: "模型 [" + selectedModelName + "] 验证成功！HTTP " + res.statusCode + " (" + elapsed + "ms)"
            };
            render();
            return;
          }

          // 2. 若推理端点返回 404 或 405，回退尝试 GET /models 查询网关健康度
          if (!res || res.statusCode === 404 || res.statusCode === 405) {
            const fallbackEndpoint = `${cleanBaseUrl}/models`;
            const fallbackHeaders = isAnthropic
              ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
              : { "Authorization": "Bearer " + key };
            try {
              const fallbackRes = await doHttpReq(fallbackEndpoint, "GET", fallbackHeaders, null);
              const fallbackElapsed = Date.now() - startTime;
              if (fallbackRes.statusCode >= 200 && fallbackRes.statusCode < 400) {
                testResult = {
                  success: true,
                  message: "网关基础连通成功 (HTTP " + fallbackRes.statusCode + ", " + fallbackElapsed + "ms，模型列表可访问)"
                };
                render();
                return;
              }
            } catch (_) {}
          }

          // 3. 详细提取上游真实报错（如 500 sensitive_words_detected, 401 密钥失效等）
          let detail = "";
          if (res && res.body) {
            try {
              const j = JSON.parse(res.body);
              detail = j.error?.message || j.message || j.error || j.detail || "";
            } catch (_) {
              detail = res.body.replace(/<[^>]+>/g, "").trim().slice(0, 100);
            }
          }
          if (!detail && netError) {
            detail = netError.message;
          }
          if (!detail && res) {
            detail = "HTTP " + res.statusCode;
          }

          testResult = {
            success: false,
            message: "上游拒绝 [HTTP " + (res?.statusCode || "ERR") + "]: " + detail + " (" + elapsed + "ms)"
          };
          render();
        } catch (e) {
          isTesting = false;
          testResult = { success: false, message: "探测失败: " + e.message };
          render();
        }
      };
    }

    // 保存配置
    const saveBtn = container.querySelector("#dsh-adv-save-btn");
    const tipEl = container.querySelector("#dsh-adv-save-tip");
    if (saveBtn) {
      saveBtn.onclick = async () => {
        // 1. 实时获取输入框中最新的 API Key、Base URL、Timeout、服务商名称与协议
        const curP = providersData[selectedProviderIdx];
        if (curP) {
          const curKeyInput = container.querySelector("#dsh-adv-apikey");
          if (curKeyInput) {
            const val = curKeyInput.value.trim();
            const envKey = curP.apiKeyEnv;
            const originalVal = credsMap[envKey] || "";
            // 核心防线 (5.11 项四)：未编辑且原本有值的凭据绝不被空字符串意外覆盖或删除！
            // 仅在输入框有实际输入，或者用户显式清除了原本有值的输入框时才更新
            if (val !== "" || originalVal !== "") {
              const saveRes = await ipcRenderer.invoke("save-credentials", { [envKey]: val });
              if (!saveRes || saveRes.success === false) {
                throw new Error(saveRes?.error || "底层 safeStorage 凭据加密持久化失败，请重试");
              }
              credsMap[envKey] = val;
            }
            if (selectedModelName) {
              if (!curP.modelConfigs) curP.modelConfigs = {};
              if (!curP.modelConfigs[selectedModelName]) curP.modelConfigs[selectedModelName] = {};
              delete curP.modelConfigs[selectedModelName].apiKey;
            }
          }

          const curBaseInput = container.querySelector("#dsh-adv-baseurl");
          if (curBaseInput) {
            const baseVal = curBaseInput.value.trim();
            curP.baseURL = baseVal;
            if (selectedModelName) {
              if (!curP.modelConfigs) curP.modelConfigs = {};
              if (!curP.modelConfigs[selectedModelName]) curP.modelConfigs[selectedModelName] = {};
              curP.modelConfigs[selectedModelName].baseURL = baseVal;
            }
          }

          const curTimeoutInput = container.querySelector("#dsh-adv-timeout");
          if (curTimeoutInput) {
            const timeoutVal = curTimeoutInput.value.trim();
            curP.timeout = timeoutVal;
            if (selectedModelName) {
              if (!curP.modelConfigs) curP.modelConfigs = {};
              if (!curP.modelConfigs[selectedModelName]) curP.modelConfigs[selectedModelName] = {};
              curP.modelConfigs[selectedModelName].timeout = timeoutVal;
            }
          }

          const curNameInput = container.querySelector("#dsh-adv-p-name");
          if (curNameInput) {
            curP.name = curNameInput.value.trim();
          }

          const curProtoInput = container.querySelector("#dsh-adv-p-protocol");
          if (curProtoInput) {
            curP.protocol = curProtoInput.value;
          }
        }

        saveBtn.disabled = true;
        saveBtn.textContent = "⏳ 正在保存配置...";

        try {
          // 确保 ~/.dsh 目录物理存在
          if (!fs.existsSync(dshDir)) {
            try { fs.mkdirSync(dshDir, { recursive: true }); } catch (_) {}
          }

          // 2. 物理持久化 providers-config.json 与 LocalStorage 镜像（保留所有自定义服务商与胶囊独立配置，严禁持久化明文 API Key - R0-1）
          const cleanProvs = JSON.parse(JSON.stringify(providersData));
          for (const p of cleanProvs) {
            delete p.apiKey;
            if (p.modelConfigs && typeof p.modelConfigs === "object") {
              for (const m of Object.keys(p.modelConfigs)) {
                if (p.modelConfigs[m]) {
                  delete p.modelConfigs[m].apiKey; // P0 核心红线：彻底禁止明文落盘
                }
              }
            }
          }
          const providersSnapshot = {
            activeProviderId: curP?.id || "",
            activeModelName: selectedModelName || "",
            providers: cleanProvs
          };
          try {
            fs.writeFileSync(providersJsonFile, JSON.stringify(providersSnapshot, null, 2), "utf8");
          } catch (writeJsonErr) {
            console.warn("[dsh-desktop] Failed to write providers-config.json:", writeJsonErr);
          }
          try {
            localStorage.setItem("dsh_providers_snapshot_v2", JSON.stringify(providersSnapshot));
          } catch (_e) {}

          // 3. 物理落盘 settings.yaml（自愈生成与智能正则合并）
          let s = "";
          if (fs.existsSync(settingsFile)) {
            try {
              s = fs.readFileSync(settingsFile, "utf8");
            } catch (readSettingsErr) {
              console.warn("[dsh-desktop] Failed to read settings.yaml:", readSettingsErr);
            }
          }

          // 纯函数辅助：以标准带引号标量格式安全转义 YAML 字段与键名 (CODE_REVIEW R-05)
          const safeYamlScalar = (val) => JSON.stringify(String(val ?? ""));
          const safeYamlKey = (key) => /^[a-zA-Z0-9_-]+$/.test(String(key || "")) ? String(key) : JSON.stringify(String(key || ""));

          const buildProvidersBlock = (provList) => {
            let providersYaml = "providers: {\n";
            for (const p of provList) {
              const mList = (p.models || []).map(m => "              { id: " + safeYamlScalar(m) + " }").join(",\n");
              const apiType = p.protocol === "anthropic" ? "anthropic-messages" : "openai-completions";
              const pKey = safeYamlKey(p.id);
              providersYaml += "      " + pKey + ":\n        {\n          displayName: " + safeYamlScalar(p.name || p.id) + ",\n          apiKeyEnv: " + (p.apiKeyEnv ? safeYamlScalar(p.apiKeyEnv) : '""') + ",\n          api: " + apiType + ",\n          baseURL: " + safeYamlScalar(p.baseURL || "") + ",\n          models:\n            [\n" + mList + "\n            ]\n        },\n";
            }
            providersYaml += "    }";
            return providersYaml;
          };

          for (const p of providersData) {
            try {
              localStorage.setItem("dsh_models_" + p.id, JSON.stringify(p.models || []));
            } catch (e) {}
          }

          if (!s || s.trim() === "") {
            // 若文件不存在或为空，自愈生成标准合法的 settings.yaml 结构
            s = "# DSH Desktop Configuration File\nagent-default-model:\n  provider: " + safeYamlKey(curP?.id || "agent-router") + "\n  model: " + safeYamlScalar(selectedModelName || "glm-5.3") + "\n\n" + buildProvidersBlock(providersData) + "\n\nui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n";
          } else {
            // 已存在 settings.yaml，进行精准无损更新
            if (selectedModelName && curP) {
              const defaultModelBlock = 'agent-default-model:\n  provider: ' + safeYamlKey(curP.id) + '\n  model: ' + safeYamlScalar(selectedModelName);
              if (s.includes("agent-default-model:")) {
                s = s.replace(/agent-default-model:[\s\S]*?model:\s*[^\n\r]+/, () => defaultModelBlock);
              } else {
                s = defaultModelBlock + '\n\n' + s;
              }
            }

            const newProvidersBlock = buildProvidersBlock(providersData);
            s = replaceYamlProvidersBlock(s, newProvidersBlock);
          }

          fs.writeFileSync(settingsFile, s, "utf8");

          if (tipEl) {
            tipEl.style.display = "inline-flex";
          }
          saveBtn.textContent = "⚡ 正在同步并平滑重启微内核引擎...";

          let restartOk = true;
          try {
            const restartRes = await ipcRenderer.invoke("restart-backend-service");
            if (restartRes && restartRes.success === false) {
              restartOk = false;
              console.warn("[dsh-desktop] Backend restart reported false:", restartRes.error);
            }
          } catch (restartErr) {
            restartOk = false;
            console.warn("[dsh-desktop] Failed to call restart-backend-service:", restartErr);
          }

          if (restartOk) {
            saveBtn.textContent = "✅ 配置已生效，服务已重连";
          } else {
            saveBtn.textContent = "✅ 配置已保存";
          }
          setTimeout(() => { close(); }, 600);
        } catch (err) {
          alert("保存配置失败: " + err.message);
          saveBtn.disabled = false;
          saveBtn.textContent = "💾 保存配置";
        }
      };
    }
  }

  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = "none"; };
  render();
}

// ---------------------------------------------------------------------------
// 🌟 终极优雅分流引擎：内置模块右侧内嵌 + 桌面专有模块独立弹窗
// ---------------------------------------------------------------------------
function getTrueRightContentArea(tabContainer) {
  let curr = tabContainer;
  while (curr && curr.parentElement && curr.parentElement !== document.body) {
    const parent = curr.parentElement;
    const children = Array.from(parent.children);
    if (children.length === 2) {
      const right = children.find(c => !c.contains(tabContainer));
      if (right) return right;
    }
    curr = parent;
  }
  let p = tabContainer.parentElement;
  while (p && p !== document.body) {
    const siblings = Array.from(p.children).filter(c => !c.contains(tabContainer));
    const hit = siblings.find(s => s.getBoundingClientRect().width > 300);
    if (hit) return hit;
    p = p.parentElement;
  }
  return null;
}

// =========================================================================
// 设置弹窗侧边栏选项卡精准注入（主题外观、关于）
// =========================================================================
function injectCustomTabsIntoSettings() {
  // 移除旧顶栏
  const oldBar = document.getElementById("dsh-quick-actions-bar");
  if (oldBar) oldBar.remove();

  // 1. 定位设置弹窗中的 "通用设置" 按钮
  const allClickables = Array.from(document.querySelectorAll("button, [role='tab'], div[role='button']"));
  const generalBtn = allClickables.find(b => {
    const t = (b.textContent || "").trim();
    return t === "通用设置" || t === "General" || t.startsWith("通用设置");
  });

  if (!generalBtn) return;

  // 2. 向上寻找侧边栏的真正列表容器
  let navList = generalBtn.parentElement;
  let curr = generalBtn.parentElement;
  while (curr && curr !== document.body) {
    const buttons = Array.from(curr.querySelectorAll("button, [role='tab'], div[role='button']"));
    const texts = buttons.map(b => (b.textContent || "").trim());
    if (texts.some(t => t.includes("通用设置")) && 
       (texts.some(t => t.includes("模型")) || texts.some(t => t.includes("插件市场")) || texts.some(t => t.includes("侧边卡片")))) {
      navList = curr;
      // 如果当前容器的直接子元素包含多个 tab 项，则锁定该容器
      if (curr.children.length >= 4) {
        break;
      }
    }
    curr = curr.parentElement;
  }

  if (!navList) return;

  // 3. 拦截原生【模型】Tab 点击，弹出自定义配置卡片
  const allNavBtns2 = Array.from(navList.querySelectorAll("button, [role='tab'], div[role='button']"));
  const nativeModelBtn = allNavBtns2.find(b => {
    const t = (b.textContent || "").trim();
    return t === "模型" || t.startsWith("模型") || t === "Models";
  });
  if (nativeModelBtn && !nativeModelBtn.hasAttribute("data-dsh-model-hooked")) {
    nativeModelBtn.setAttribute("data-dsh-model-hooked", "1");
    const interceptAndShow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showModelConfigModal().catch((err) => {
        console.error("[dsh-desktop] Failed to show model config modal:", err);
      });
    };
    nativeModelBtn.addEventListener("click", interceptAndShow, true);
    nativeModelBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, true);
    nativeModelBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, true);
  }

  // 找到定位基准元素（优先排在 侧边卡片 或 插件市场 之后）
  const allCurrentTabs = Array.from(navList.querySelectorAll("button, [role='tab'], div[role='button']"));
  const anchorTab = allCurrentTabs.reverse().find(b => {
    const t = (b.textContent || "").trim();
    return t.includes("侧边卡片") || t.includes("插件市场") || t.includes("Agent 预设") || t.includes("通用设置");
  }) || generalBtn;

  const targetContainer = anchorTab.parentElement || navList;

  // 检查是否已经注入
  const alreadyHasTheme = Array.from(targetContainer.querySelectorAll("*")).some(el => (el.textContent || "").trim().includes("主题外观"));
  const alreadyHasFeedback = Array.from(targetContainer.querySelectorAll("*")).some(el => (el.textContent || "").trim().includes("问题反馈"));
  const alreadyHasAbout = Array.from(targetContainer.querySelectorAll("*")).some(el => (el.textContent || "").trim().includes("关于"));

  // 辅助函数：创建统一外观的侧边栏 Tab 项（彻底杜绝选中态高亮污染）
  function createSidebarTab(id, label, iconSvg, onClick) {
    // 优先寻找一个当前未激活的原生 Tab 作为克隆模板，杜绝继承“通用设置”的高亮激活底色
    const allButtons = Array.from(navList.querySelectorAll("button, [role='tab'], div[role='button']"));
    const inactiveTemplate = allButtons.find(b => {
      const t = (b.textContent || "").trim();
      const isCustom = b.hasAttribute("data-dsh-custom-tab");
      const isSelected = b.getAttribute("aria-selected") === "true" ||
                         b.getAttribute("data-state") === "active" ||
                         b.classList.contains("active");
      return !isCustom && !isSelected && t && !t.includes("通用设置");
    }) || generalBtn;

    let tab = inactiveTemplate.cloneNode(true);
    tab.removeAttribute("id");
    tab.setAttribute("data-dsh-custom-tab", id);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    if (tab.hasAttribute("data-state")) {
      tab.setAttribute("data-state", "inactive");
    }

    // 剔除任何可能残留的高亮激活类名
    Array.from(tab.classList).forEach(cls => {
      if (cls.includes("active") || cls.includes("selected") || cls.includes("orange") || cls.includes("accent")) {
        tab.classList.remove(cls);
      }
    });

    // 强制重置为纯净未激活态：默认完全透明
    tab.style.backgroundColor = "transparent";
    tab.style.color = "inherit";
    tab.style.cursor = "pointer";
    tab.style.display = "flex";
    tab.style.alignItems = "center";
    tab.style.width = "100%";
    tab.style.margin = "2px 0";
    tab.style.userSelect = "none";
    tab.style.transition = "background-color 0.15s ease, color 0.15s ease";

    // 注入图标与文本
    tab.innerHTML = `
      <span style="display: inline-flex; align-items: center; gap: 8px; width: 100%; font-size: inherit; font-family: inherit;">
        <span style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; opacity: 0.85; flex-shrink: 0;">
          ${iconSvg}
        </span>
        <span style="flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;">${label}</span>
      </span>
    `;

    tab.addEventListener("mouseenter", () => {
      const isDark = document.documentElement.classList.contains("dark") || document.body.classList.contains("dark");
      tab.style.backgroundColor = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.05)";
    });
    tab.addEventListener("mouseleave", () => {
      tab.style.backgroundColor = "transparent";
    });

    tab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });

    return tab;
  }

  // 注入主题外观 Tab
  if (!alreadyHasTheme) {
    const themeIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a10 10 0 0 1 10 10c0 5.523-4.477 10-10 10S2 17.523 2 12a10 10 0 0 1 10-10z"></path><path d="m4.93 4.93 4.24 4.24"></path><path d="m14.83 9.17 4.24-4.24"></path><path d="m14.83 14.83 4.24 4.24"></path><path d="m4.93 19.07 4.24-4.24"></path></svg>`;
    const themeTab = createSidebarTab("theme", "主题外观", themeIcon, () => {
      showThemeModal();
    });
    targetContainer.appendChild(themeTab);
  }

  // 注入问题反馈 Tab
  if (!alreadyHasFeedback) {
    const fbIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
    const fbTab = createSidebarTab("feedback", "问题反馈", fbIcon, () => {
      showFeedbackModal();
    });
    targetContainer.appendChild(fbTab);
  }

  // 注入关于 Tab
  if (!alreadyHasAbout) {
    const aboutIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    const aboutTab = createSidebarTab("about", "关于", aboutIcon, () => {
      showAboutModal();
    });
    targetContainer.appendChild(aboutTab);
  }
}

// ---------------------------------------------------------------------------
// Native Desktop Hook: 🌸 插件市场 escook-theme 卡片智能识别与桌面端联动
// ---------------------------------------------------------------------------
function enhanceEscookMarketCard() {
  const cards = document.querySelectorAll("article, div, [class*='card']");
  for (const card of cards) {
    const text = card.textContent || "";
    if (text.includes("dsh-theme-escook")) {
      // 1. 将“未安装”改写为“🌟 客户端已内置”
      const badgeCandidates = card.querySelectorAll("span, div, [class*='badge']");
      for (const b of badgeCandidates) {
        if ((b.textContent || "").trim() === "未安装") {
          b.textContent = "🌟 客户端已内置";
          b.style.color = "#10b981";
          b.style.fontWeight = "600";
        }
      }

      // 2. 将“安装”按钮改写为“🎨 切换主题”并绑定直接弹窗
      const buttons = card.querySelectorAll("button");
      for (const btn of buttons) {
        if ((btn.textContent || "").trim() === "安装") {
          btn.textContent = "🎨 切换外观";
          btn.style.backgroundColor = "#ef820c";
          btn.style.borderColor = "#ef820c";
          btn.style.color = "#ffffff";
          btn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            showThemeModal();
          };
        }
      }

      // 3. 将“暂无预览”占位图替换为高清 4 合 1 真实效果图
      const coverBtn = card.querySelector("button[class*='themeCover']");
      if (coverBtn && (coverBtn.textContent || "").includes("暂无预览")) {
        coverBtn.disabled = false;
        coverBtn.style.cursor = "pointer";
        coverBtn.style.padding = "0";
        coverBtn.innerHTML = `<img src="https://raw.githubusercontent.com/Simon-yyy/dsh-theme-escook/main/assets/preview.png" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px;" alt="escook preview" />`;
        coverBtn.onclick = (e) => {
          e.stopPropagation();
          showThemeModal();
        };
      }
    }
  }
}

// 页面加载及 DOM 变动时持续监听
window.addEventListener("DOMContentLoaded", () => {
  try {
    // 协议安全守卫：若处于 data: 或 about: 协议的启动等待页，安全跳过 (5.2.6)
    if (window.location && (window.location.protocol === "data:" || window.location.protocol === "about:")) {
      return;
    }

    const savedTheme = safeGetItem("dsh_selected_theme");
    if (savedTheme && savedTheme !== "default") {
      applyAppTheme(savedTheme);
    }
    const savedFont = safeGetItem("dsh_selected_font");
    if (savedFont && savedFont !== "default") {
      applyAppFont(savedFont);
    }
    const savedUiFont = safeGetItem("dsh_selected_ui_font");
    if (savedUiFont && savedUiFont !== "default") {
      applyAppUiFont(savedUiFont);
    }
    enableSmoothWheelScrollFix();
    scanAndEnableRestartButtons();
    injectCustomTabsIntoSettings();
    enhanceEscookMarketCard();

    const observer = new MutationObserver(() => {
      scanAndEnableRestartButtons();
      injectCustomTabsIntoSettings();
      enhanceEscookMarketCard();
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  } catch (err) {
    console.warn("[dsh-desktop] DOMContentLoaded initialization notice:", err.message);
  }
});

setInterval(() => {
  try {
    if (window.location && (window.location.protocol === "data:" || window.location.protocol === "about:")) {
      return;
    }
    scanAndEnableRestartButtons();
    injectCustomTabsIntoSettings();
    enhanceEscookMarketCard();
  } catch (_e) {}
}, 1000);
