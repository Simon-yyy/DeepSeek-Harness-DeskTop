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
      if (registration === undefined) throw new Error("client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js");
      pendingQueue.splice(index, 1);
      const exports = registration.factory(specifier => {
        throw new Error('client-modules: @deepseek-ai/dsh-client-modules/client.js requested external "' + specifier + '" before the module system existed');
      });
      if (typeof exports !== "object" || exports === null || typeof exports.createClientModuleSystem !== "function" || typeof exports.apply !== "function") {
        throw new Error("client-modules: @deepseek-ai/dsh-client-modules/client.js did not export the bootstrap module face");
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
    localStorage.setItem("dsh_selected_theme", "default");
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
  localStorage.setItem("dsh_selected_theme", themeKey);
  console.info(`🌸 [dsh-desktop] 已激活主题: ${themeObj.name}`);
}

window.__DSH_BUILTIN_THEMES__ = {
  themes: ESCOOK_THEMES,
  apply: applyAppTheme,
  getCurrent: () => localStorage.getItem("dsh_selected_theme") || "default",
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
      const current = localStorage.getItem("dsh_selected_theme");
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
    mono: "Consolas, 'Courier New', monospace"
  },
  "jetbrains": {
    name: "JetBrains Mono (极客推荐)",
    desc: "为代码阅读专设的优质等宽字体，支持专业连字符号（!=, =>, ===）",
    mono: "'JetBrains Mono', 'Fira Code', Consolas, monospace"
  },
  "fira": {
    name: "Fira Code (经典连字)",
    desc: "全球知名的编程连字字体（->, !=, ===, >=），视觉辨识度极高",
    mono: "'Fira Code', 'JetBrains Mono', Consolas, monospace"
  },
  "cascadia": {
    name: "Cascadia Code (微软现代)",
    desc: "Windows Terminal / VS Code 官方默认连字字体，现代方正清晰",
    mono: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace"
  },
  "consolas": {
    name: "Consolas (经典 Windows)",
    desc: "Windows 经典内置等宽字体，开箱即用，轻快整洁零延迟",
    mono: "Consolas, 'Courier New', monospace"
  }
};

function applyAppFont(fontKey) {
  let styleEl = document.getElementById("dsh-custom-font-styles");
  if (!fontKey || fontKey === "default" || !BUILTIN_FONTS[fontKey]) {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    localStorage.setItem("dsh_selected_font", "default");
    console.info("🔤 [dsh-desktop] 已恢复系统默认字体");
    return;
  }

  const fontObj = BUILTIN_FONTS[fontKey];
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "dsh-custom-font-styles";
    document.head.appendChild(styleEl);
  }

  let fontFaceImport = "";
  if (fontKey === "jetbrains") {
    fontFaceImport = `@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');`;
  } else if (fontKey === "fira") {
    fontFaceImport = `@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600;700&display=swap');`;
  } else if (fontKey === "cascadia") {
    fontFaceImport = `@import url('https://cdn.jsdelivr.net/npm/@fontsource/cascadia-code@5.0.14/index.css');`;
  }

  styleEl.textContent = `
    ${fontFaceImport}
    pre, code, kbd, samp, [class*="codeBlock"], [class*="mono"], .font-mono, textarea {
      font-family: ${fontObj.mono} !important;
      font-feature-settings: "calt" 1, "liga" 1 !important;
    }
  `;
  localStorage.setItem("dsh_selected_font", fontKey);
  console.info(`🔤 [dsh-desktop] 已激活编程字体: ${fontObj.name}`);
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
  const currentFont = localStorage.getItem("dsh_selected_font") || "default";
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

      <!-- 字体设置分割线与标题 -->
      <div style="margin: 14px 0 10px 0; padding-top: 14px; border-top: 1px solid ${borderColor}; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 14px;">🔤</span>
          <span style="font-weight: 700; font-size: 13px;">代码与编程字体 (Code Fonts)</span>
        </div>
        <span style="font-size: 11px; opacity: 0.6;">支持专业连字 (Ligatures)</span>
      </div>

      <!-- 字体列表 -->
      <div style="display: grid; gap: 8px; margin-bottom: 16px;">
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

  // 绑定字体选项点击
  overlay.querySelectorAll(".dsh-font-option-card").forEach((card) => {
    card.addEventListener("click", () => {
      const fKey = card.dataset.fontKey;
      applyAppFont(fKey);
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

      <!-- 底部内核版本 -->
      <div style="padding-top: 14px; border-top: 1px solid ${borderColor}; font-size: 11px; opacity: 0.65; display: flex; justify-content: space-between; gap: 8px;">
        <div>官方内核包：<strong>@deepseek-ai/dsh@${cachedAppInfo.kernelVersion || '0.1.1-rc.2'}</strong></div>
        <div>桌面环境：Node ${cachedAppInfo.nodeVersion || '20'} · Electron ${cachedAppInfo.electronVersion || '33'}</div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeModal = () => { overlay.style.display = "none"; };
  overlay.querySelector("#dsh-modal-close-btn").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

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

  // 找到定位基准元素（优先排在 侧边卡片 或 插件市场 之后）
  const allCurrentTabs = Array.from(navList.querySelectorAll("button, [role='tab'], div[role='button']"));
  const anchorTab = allCurrentTabs.reverse().find(b => {
    const t = (b.textContent || "").trim();
    return t.includes("侧边卡片") || t.includes("插件市场") || t.includes("Agent 预设") || t.includes("通用设置");
  }) || generalBtn;

  const targetContainer = anchorTab.parentElement || navList;

  // 检查是否已经注入
  const alreadyHasTheme = Array.from(targetContainer.querySelectorAll("*")).some(el => (el.textContent || "").trim().includes("主题外观"));
  const alreadyHasAbout = Array.from(targetContainer.querySelectorAll("*")).some(el => (el.textContent || "").trim().includes("关于"));

  // 辅助函数：创建统一外观的侧边栏 Tab 项
  function createSidebarTab(id, label, iconSvg, onClick) {
    // 优先克隆通用设置按钮以保持 100% 原生尺寸、类名和排版
    let tab = generalBtn.cloneNode(true);
    tab.removeAttribute("id");
    tab.className = generalBtn.className;
    tab.setAttribute("data-dsh-custom-tab", id);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    tab.style.cursor = "pointer";
    tab.style.display = "flex";
    tab.style.alignItems = "center";
    tab.style.width = "100%";
    tab.style.margin = "2px 0";
    tab.style.userSelect = "none";
    tab.style.transition = "all 0.15s ease";

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
  const savedTheme = localStorage.getItem("dsh_selected_theme");
  if (savedTheme && savedTheme !== "default") {
    applyAppTheme(savedTheme);
  }
  const savedFont = localStorage.getItem("dsh_selected_font");
  if (savedFont && savedFont !== "default") {
    applyAppFont(savedFont);
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
  observer.observe(document.body, { childList: true, subtree: true });
});

setInterval(() => {
  scanAndEnableRestartButtons();
  injectCustomTabsIntoSettings();
    enhanceEscookMarketCard();
}, 1000);
