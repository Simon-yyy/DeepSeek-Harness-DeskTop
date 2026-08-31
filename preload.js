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
      console.log("[dsh-desktop] Native vision modal detected, passing imageFile to official web frontend handler");
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
// 8 款全新精心调配的高级设计感主题矩阵 (Aesthetic Theme Palettes)
// =========================================================================
const ESCOOK_THEMES = {
  "dark": {
    name: "escook Dark (经典暗黑 · 日落金橙)",
    desc: "沉浸深邃蓝黑底色搭配极光日落金橙，现代极客硬朗质感",
    type: "dark",
    colorPreview: "#FF8400",
    bgPreview: "#14171F",
    css: `
      :root, html, body, body[data-ds-dark-theme], [data-theme="escook-dark"] {
        --dsw-alias-bg-base: #14171F !important;
        --dsw-alias-bg-layer-1: #0E1017 !important;
        --dsw-alias-bg-layer-2: #1B1F2A !important;
        --dsw-alias-bg-mask-1: rgba(10, 12, 18, 0.75) !important;
        --dsw-specific-sidebar-fill: #0E1017 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 132, 0, 0.1) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 132, 0, 0.2) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #FF8400 !important;
        --dsw-specific-input-major: #1B1F2A !important;
        --dsw-specific-bubble: #1B1F2A !important;
        --dsw-specific-menu: #161922 !important;
        --dsw-hovercard-bg: #161922 !important;
        --dsw-alias-tooltip-bg: #222736 !important;
        --dsw-alias-button-elevated-fill: #1B1F2A !important;
        --dsw-alias-button-floating-hover: #262C3D !important;
        --dsw-alias-brand-primary: #FF8400 !important;
        --dsw-alias-button-primary-fill: #FF8400 !important;
        --dsw-alias-button-primary-hover: #FFA033 !important;
        --dsw-alias-label-primary-foreground: #000000 !important;
        --dsw-alias-label-primary: #F4F6FB !important;
        --dsw-alias-label-secondary: #9CA3AF !important;
        --dsw-alias-label-tertiary: #6B7280 !important;
        --dsw-alias-label-dimmed: #4B5563 !important;
        --dsw-alias-label-caption: #6B7280 !important;
        --dsw-alias-interactive-bg-hover: rgba(255, 132, 0, 0.1) !important;
        --dsw-alias-interactive-bg-active: rgba(255, 132, 0, 0.2) !important;
        --dsw-alias-border-l1: #2A3042 !important;
        --dsw-alias-border-l2: #212635 !important;
        --dsw-alias-border-l3: #384058 !important;
        --dsw-alias-border-l4: #4B5563 !important;
        --dsw-alias-markdown-code-block: #0C0E14 !important;
        --dsw-alias-markdown-code-block-banner: #14171F !important;
        --dsw-alias-scrollbar-bg-l2: #2A3042 !important;
        --dsw-alias-scrollbar-hover-l2: #FF8400 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #14171F !important; color: #F4F6FB !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #0C0E14 !important;
        color: #F4F6FB !important;
        border-color: #2A3042 !important;
      }
    `
  },
  "dark-soft": {
    name: "escook Dark Soft (柔和暗黑 · 琥珀流金)",
    desc: "温润哑光深青夜幕底色搭配柔和琥珀流金，长效护眼防疲劳",
    type: "dark",
    colorPreview: "#F6C177",
    bgPreview: "#1A1E29",
    css: `
      :root, html, body, body[data-ds-dark-theme], [data-theme="escook-dark-soft"] {
        --dsw-alias-bg-base: #1A1E29 !important;
        --dsw-alias-bg-layer-1: #141720 !important;
        --dsw-alias-bg-layer-2: #212735 !important;
        --dsw-alias-bg-mask-1: rgba(14, 16, 24, 0.7) !important;
        --dsw-specific-sidebar-fill: #141720 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(246, 193, 119, 0.1) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(246, 193, 119, 0.18) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #F6C177 !important;
        --dsw-specific-input-major: #212735 !important;
        --dsw-specific-bubble: #212735 !important;
        --dsw-specific-menu: #1B202B !important;
        --dsw-hovercard-bg: #1B202B !important;
        --dsw-alias-tooltip-bg: #293042 !important;
        --dsw-alias-button-elevated-fill: #212735 !important;
        --dsw-alias-button-floating-hover: #2B3346 !important;
        --dsw-alias-brand-primary: #F6C177 !important;
        --dsw-alias-button-primary-fill: #F6C177 !important;
        --dsw-alias-button-primary-hover: #FAD49E !important;
        --dsw-alias-label-primary-foreground: #1A1E29 !important;
        --dsw-alias-label-primary: #D5DAE5 !important;
        --dsw-alias-label-secondary: #8C95A6 !important;
        --dsw-alias-label-tertiary: #677082 !important;
        --dsw-alias-label-dimmed: #4E5666 !important;
        --dsw-alias-label-caption: #677082 !important;
        --dsw-alias-interactive-bg-hover: rgba(246, 193, 119, 0.1) !important;
        --dsw-alias-interactive-bg-active: rgba(246, 193, 119, 0.18) !important;
        --dsw-alias-border-l1: #2B3242 !important;
        --dsw-alias-border-l2: #232938 !important;
        --dsw-alias-border-l3: #3B4459 !important;
        --dsw-alias-border-l4: #4E5666 !important;
        --dsw-alias-markdown-code-block: #12151D !important;
        --dsw-alias-markdown-code-block-banner: #181C26 !important;
        --dsw-alias-scrollbar-bg-l2: #2B3242 !important;
        --dsw-alias-scrollbar-hover-l2: #F6C177 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #1A1E29 !important; color: #D5DAE5 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #12151D !important;
        color: #D5DAE5 !important;
        border-color: #2B3242 !important;
      }
    `
  },
  "light": {
    name: "escook Light (经典紫韵 · 皇家罗兰)",
    desc: "法式法兰绒暖米白搭配典雅皇家罗兰紫，极富书卷杂志质感",
    type: "light",
    colorPreview: "#7C3AED",
    bgPreview: "#FAF8F5",
    css: `
      :root, html, body, body[data-ds-dark-theme], [data-theme="escook-light"] {
        --dsw-alias-bg-base: #FAF8F5 !important;
        --dsw-alias-bg-layer-1: #F3EFEA !important;
        --dsw-alias-bg-layer-2: #FFFFFF !important;
        --dsw-alias-bg-mask-1: rgba(60, 50, 70, 0.3) !important;
        --dsw-specific-sidebar-fill: #F3EFEA !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(124, 58, 237, 0.08) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(124, 58, 237, 0.16) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #7C3AED !important;
        --dsw-specific-input-major: #FFFFFF !important;
        --dsw-specific-bubble: #FFFFFF !important;
        --dsw-specific-menu: #FFFFFF !important;
        --dsw-hovercard-bg: #FFFFFF !important;
        --dsw-alias-tooltip-bg: #1E1B24 !important;
        --dsw-alias-button-elevated-fill: #FFFFFF !important;
        --dsw-alias-button-floating-hover: #F3EFEA !important;
        --dsw-alias-brand-primary: #7C3AED !important;
        --dsw-alias-button-primary-fill: #7C3AED !important;
        --dsw-alias-button-primary-hover: #8B5CF6 !important;
        --dsw-alias-label-primary-foreground: #FFFFFF !important;
        --dsw-alias-label-primary: #1E1B24 !important;
        --dsw-alias-label-secondary: #524E5B !important;
        --dsw-alias-label-tertiary: #716C7B !important;
        --dsw-alias-label-dimmed: #9A94A4 !important;
        --dsw-alias-label-caption: #716C7B !important;
        --dsw-alias-interactive-bg-hover: rgba(124, 58, 237, 0.08) !important;
        --dsw-alias-interactive-bg-active: rgba(124, 58, 237, 0.15) !important;
        --dsw-alias-border-l1: #E6E0D8 !important;
        --dsw-alias-border-l2: #F0EAE2 !important;
        --dsw-alias-border-l3: #DDD6CE !important;
        --dsw-alias-border-l4: #9A94A4 !important;
        --dsw-alias-markdown-code-block: #F4EFE9 !important;
        --dsw-alias-markdown-code-block-banner: #EAE3DA !important;
        --dsw-alias-scrollbar-bg-l2: #E6E0D8 !important;
        --dsw-alias-scrollbar-hover-l2: #7C3AED !important;
      }
      body, body[data-ds-dark-theme] { background-color: #FAF8F5 !important; color: #1E1B24 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #F4EFE9 !important;
        color: #1E1B24 !important;
        border-color: #E6E0D8 !important;
      }
    `
  },
  "light-soft": {
    name: "escook Light Soft (柔和浅色 · 蜜柑亮橙)",
    desc: "清透微晨纯白搭配活力蜜柑亮橙，清爽明亮不刺眼",
    type: "light",
    colorPreview: "#FF6B00",
    bgPreview: "#F8FAFC",
    css: `
      :root, html, body, body[data-ds-dark-theme], [data-theme="escook-light-soft"] {
        --dsw-alias-bg-base: #F8FAFC !important;
        --dsw-alias-bg-layer-1: #F1F5F9 !important;
        --dsw-alias-bg-layer-2: #FFFFFF !important;
        --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.25) !important;
        --dsw-specific-sidebar-fill: #F1F5F9 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 107, 0, 0.08) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 107, 0, 0.16) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #FF6B00 !important;
        --dsw-specific-input-major: #FFFFFF !important;
        --dsw-specific-bubble: #FFFFFF !important;
        --dsw-specific-menu: #FFFFFF !important;
        --dsw-hovercard-bg: #FFFFFF !important;
        --dsw-alias-tooltip-bg: #0F172A !important;
        --dsw-alias-button-elevated-fill: #FFFFFF !important;
        --dsw-alias-button-floating-hover: #F1F5F9 !important;
        --dsw-alias-brand-primary: #FF6B00 !important;
        --dsw-alias-button-primary-fill: #FF6B00 !important;
        --dsw-alias-button-primary-hover: #FF8533 !important;
        --dsw-alias-label-primary-foreground: #FFFFFF !important;
        --dsw-alias-label-primary: #0F172A !important;
        --dsw-alias-label-secondary: #475569 !important;
        --dsw-alias-label-tertiary: #64748B !important;
        --dsw-alias-label-dimmed: #94A3B8 !important;
        --dsw-alias-label-caption: #64748B !important;
        --dsw-alias-interactive-bg-hover: rgba(255, 107, 0, 0.08) !important;
        --dsw-alias-interactive-bg-active: rgba(255, 107, 0, 0.15) !important;
        --dsw-alias-border-l1: #E2E8F0 !important;
        --dsw-alias-border-l2: #F1F5F9 !important;
        --dsw-alias-border-l3: #CBD5E1 !important;
        --dsw-alias-border-l4: #94A3B8 !important;
        --dsw-alias-markdown-code-block: #F1F5F9 !important;
        --dsw-alias-markdown-code-block-banner: #E2E8F0 !important;
        --dsw-alias-scrollbar-bg-l2: #E2E8F0 !important;
        --dsw-alias-scrollbar-hover-l2: #FF6B00 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #F8FAFC !important; color: #0F172A !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #F1F5F9 !important;
        color: #0F172A !important;
        border-color: #E2E8F0 !important;
      }
    `
  },
  "deepseek-dark": {
    name: "DeepSeek 极客深邃蓝",
    desc: "纯正星空蓝黑底色搭配科技动感电光蓝，现代极客首选",
    type: "dark",
    colorPreview: "#3B82F6",
    bgPreview: "#0B0F17",
    css: `
      :root, html, body, body[data-ds-dark-theme] {
        --dsw-alias-bg-base: #0B0F17 !important;
        --dsw-alias-bg-layer-1: #111827 !important;
        --dsw-alias-bg-layer-2: #161F30 !important;
        --dsw-alias-bg-mask-1: rgba(5, 8, 15, 0.75) !important;
        --dsw-specific-sidebar-fill: #0E1420 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(59, 130, 246, 0.1) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(59, 130, 246, 0.18) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #3B82F6 !important;
        --dsw-specific-input-major: #161F30 !important;
        --dsw-specific-bubble: #161F30 !important;
        --dsw-specific-menu: #131A29 !important;
        --dsw-hovercard-bg: #131A29 !important;
        --dsw-alias-tooltip-bg: #1E293B !important;
        --dsw-alias-button-elevated-fill: #1E293B !important;
        --dsw-alias-button-floating-hover: #26354D !important;
        --dsw-alias-brand-primary: #3B82F6 !important;
        --dsw-alias-button-primary-fill: #2563EB !important;
        --dsw-alias-button-primary-hover: #3B82F6 !important;
        --dsw-alias-label-primary-foreground: #FFFFFF !important;
        --dsw-alias-label-primary: #F1F5F9 !important;
        --dsw-alias-label-secondary: #94A3B8 !important;
        --dsw-alias-label-tertiary: #64748B !important;
        --dsw-alias-label-dimmed: #475569 !important;
        --dsw-alias-label-caption: #64748B !important;
        --dsw-alias-interactive-bg-hover: rgba(59, 130, 246, 0.1) !important;
        --dsw-alias-interactive-bg-active: rgba(59, 130, 246, 0.2) !important;
        --dsw-alias-border-l1: #1E293B !important;
        --dsw-alias-border-l2: #192436 !important;
        --dsw-alias-border-l3: #334155 !important;
        --dsw-alias-border-l4: #475569 !important;
        --dsw-alias-markdown-code-block: #090D14 !important;
        --dsw-alias-markdown-code-block-banner: #111827 !important;
        --dsw-alias-scrollbar-bg-l2: #1E293B !important;
        --dsw-alias-scrollbar-hover-l2: #3B82F6 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #0B0F17 !important; color: #F1F5F9 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #090D14 !important;
        color: #F1F5F9 !important;
        border-color: #1E293B !important;
      }
    `
  },
  "catppuccin-mocha": {
    name: "摩卡暗夜紫 (Catppuccin Mocha)",
    desc: "优雅治愈的哑光暗夜紫调，搭配马卡龙玫瑰粉与罗兰紫",
    type: "dark",
    colorPreview: "#CBA6F7",
    bgPreview: "#1E1E2E",
    css: `
      :root, html, body, body[data-ds-dark-theme] {
        --dsw-alias-bg-base: #1E1E2E !important;
        --dsw-alias-bg-layer-1: #181825 !important;
        --dsw-alias-bg-layer-2: #313244 !important;
        --dsw-alias-bg-mask-1: rgba(17, 17, 27, 0.7) !important;
        --dsw-specific-sidebar-fill: #181825 !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(203, 166, 247, 0.1) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(203, 166, 247, 0.2) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #CBA6F7 !important;
        --dsw-specific-input-major: #242438 !important;
        --dsw-specific-bubble: #242438 !important;
        --dsw-specific-menu: #181825 !important;
        --dsw-hovercard-bg: #181825 !important;
        --dsw-alias-tooltip-bg: #313244 !important;
        --dsw-alias-button-elevated-fill: #313244 !important;
        --dsw-alias-button-floating-hover: #45475A !important;
        --dsw-alias-brand-primary: #CBA6F7 !important;
        --dsw-alias-button-primary-fill: #CBA6F7 !important;
        --dsw-alias-button-primary-hover: #B4BEFE !important;
        --dsw-alias-label-primary-foreground: #11111B !important;
        --dsw-alias-label-primary: #CDD6F4 !important;
        --dsw-alias-label-secondary: #A6ADC8 !important;
        --dsw-alias-label-tertiary: #7F849C !important;
        --dsw-alias-label-dimmed: #585B70 !important;
        --dsw-alias-label-caption: #7F849C !important;
        --dsw-alias-interactive-bg-hover: rgba(203, 166, 247, 0.1) !important;
        --dsw-alias-interactive-bg-active: rgba(203, 166, 247, 0.2) !important;
        --dsw-alias-border-l1: #313244 !important;
        --dsw-alias-border-l2: #28283D !important;
        --dsw-alias-border-l3: #45475A !important;
        --dsw-alias-border-l4: #585B70 !important;
        --dsw-alias-markdown-code-block: #11111B !important;
        --dsw-alias-markdown-code-block-banner: #181825 !important;
        --dsw-alias-scrollbar-bg-l2: #313244 !important;
        --dsw-alias-scrollbar-hover-l2: #CBA6F7 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #1E1E2E !important; color: #CDD6F4 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #11111B !important;
        color: #CDD6F4 !important;
        border-color: #313244 !important;
      }
    `
  },
  "tokyo-night": {
    name: "东京暗夜霓虹 (Tokyo Night)",
    desc: "充满未来科技感的青紫夜景配色，电光蓝与暖日落点缀",
    type: "dark",
    colorPreview: "#7AA2F7",
    bgPreview: "#1A1B26",
    css: `
      :root, html, body, body[data-ds-dark-theme] {
        --dsw-alias-bg-base: #1A1B26 !important;
        --dsw-alias-bg-layer-1: #16161E !important;
        --dsw-alias-bg-layer-2: #24283B !important;
        --dsw-alias-bg-mask-1: rgba(15, 15, 23, 0.75) !important;
        --dsw-specific-sidebar-fill: #16161E !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(122, 162, 247, 0.1) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(122, 162, 247, 0.2) !important;
        --dsw-specific-sidebar-nav-item-active-accent: #7AA2F7 !important;
        --dsw-specific-input-major: #24283B !important;
        --dsw-specific-bubble: #24283B !important;
        --dsw-specific-menu: #1F2335 !important;
        --dsw-hovercard-bg: #1F2335 !important;
        --dsw-alias-tooltip-bg: #292E42 !important;
        --dsw-alias-button-elevated-fill: #24283B !important;
        --dsw-alias-button-floating-hover: #2F354F !important;
        --dsw-alias-brand-primary: #7AA2F7 !important;
        --dsw-alias-button-primary-fill: #7AA2F7 !important;
        --dsw-alias-button-primary-hover: #89B4FA !important;
        --dsw-alias-label-primary-foreground: #1A1B26 !important;
        --dsw-alias-label-primary: #C0CAF5 !important;
        --dsw-alias-label-secondary: #9AA5CE !important;
        --dsw-alias-label-tertiary: #787C99 !important;
        --dsw-alias-label-dimmed: #565F89 !important;
        --dsw-alias-label-caption: #787C99 !important;
        --dsw-alias-interactive-bg-hover: rgba(122, 162, 247, 0.1) !important;
        --dsw-alias-interactive-bg-active: rgba(122, 162, 247, 0.2) !important;
        --dsw-alias-border-l1: #292E42 !important;
        --dsw-alias-border-l2: #23283B !important;
        --dsw-alias-border-l3: #3B4261 !important;
        --dsw-alias-border-l4: #565F89 !important;
        --dsw-alias-markdown-code-block: #13141C !important;
        --dsw-alias-markdown-code-block-banner: #16161E !important;
        --dsw-alias-scrollbar-bg-l2: #292E42 !important;
        --dsw-alias-scrollbar-hover-l2: #7AA2F7 !important;
      }
      body, body[data-ds-dark-theme] { background-color: #1A1B26 !important; color: #C0CAF5 !important; }
      pre, code, [class*="codeBlock"] {
        background-color: #13141C !important;
        color: #C0CAF5 !important;
        border-color: #292E42 !important;
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
