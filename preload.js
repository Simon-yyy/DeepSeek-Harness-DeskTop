
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

// 页面加载就绪及后续 DOM 变动时持续监听
window.addEventListener("DOMContentLoaded", () => {
  scanAndEnableRestartButtons();
  const observer = new MutationObserver(() => {
    scanAndEnableRestartButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });
});

setInterval(scanAndEnableRestartButtons, 1000);

