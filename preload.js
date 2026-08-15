const { ipcRenderer } = require("electron");

function insertPathText(textToInsert) {
  if (!textToInsert) return;
  const activeEl = document.activeElement;
  const target = activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT")
    ? activeEl
    : document.querySelector("textarea, input[type='text']");

  if (target) {
    target.focus();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, textToInsert + " ");
    } catch {
      inserted = false;
    }
    if (!inserted) {
      const proto = target.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(target, (target.value ? target.value + " " : "") + textToInsert + " ");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Intercept Paste (Images & Copied Files from Explorer)
// ---------------------------------------------------------------------------
window.addEventListener(
  "paste",
  async (event) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    // A. Check for files copied from Explorer (PDF, Word, Code, etc.)
    if (clipboardData.files && clipboardData.files.length > 0) {
      for (let i = 0; i < clipboardData.files.length; i++) {
        const file = clipboardData.files[i];
        if (file.path) {
          event.preventDefault();
          event.stopImmediatePropagation();
          insertPathText(file.path);
          return;
        }
      }
    }

    // B. Check for clipboard screenshot bitmap / image data
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
  true // Capture phase
);

// ---------------------------------------------------------------------------
// 2. Enable smooth Drag & Drop across the whole window
// ---------------------------------------------------------------------------
window.addEventListener("dragover", (event) => {
  event.preventDefault();
}, true);

window.addEventListener("dragenter", (event) => {
  event.preventDefault();
}, true);

// ---------------------------------------------------------------------------
// 3. Intercept Drop (Drag & drop ANY file: PDF, Word, Code, Image, Zip, etc.)
// ---------------------------------------------------------------------------
window.addEventListener(
  "drop",
  async (event) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !dataTransfer.files || dataTransfer.files.length === 0) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i];

      // If it has an absolute path on disk (standard Electron File object from explorer drag)
      if (file.path) {
        insertPathText(file.path);
      } else if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
        // Fallback for virtual / browser-generated image buffers
        try {
          const arrayBuffer = await file.arrayBuffer();
          const ext = file.type === "image/jpeg" ? ".jpg" : (file.type === "image/webp" ? ".webp" : ".png");
          const filePath = await ipcRenderer.invoke("save-paste-image", {
            buffer: Array.from(new Uint8Array(arrayBuffer)),
            ext,
          });
          insertPathText(filePath);
        } catch (err) {
          console.error("[dsh-desktop] drop image failed:", err);
        }
      }
    }
  },
  true // Capture phase
);

// ---------------------------------------------------------------------------
// 4. Quick Action Chips: Modern floating skill capsules above input
// ---------------------------------------------------------------------------
function initQuickActions() {
  if (document.getElementById("dsh-quick-actions-bar")) return;

  const style = document.createElement("style");
  style.id = "dsh-quick-actions-style";
  style.textContent = `
    #dsh-quick-actions-bar {
      position: fixed;
      bottom: 84px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(26, 28, 35, 0.78);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      z-index: 99999;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
    }
    #dsh-quick-actions-bar.dsh-minimized {
      transform: translateX(-50%) translateY(32px);
      opacity: 0.35;
    }
    #dsh-quick-actions-bar:hover {
      opacity: 1 !important;
      transform: translateX(-50%) translateY(0) !important;
      border-color: rgba(64, 150, 255, 0.4);
    }
    .dsh-chip {
      font-size: 12px;
      color: #e6edf3;
      background: rgba(255, 255, 255, 0.08);
      padding: 4px 10px;
      border-radius: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .dsh-chip:hover {
      background: rgba(79, 140, 255, 0.25);
      border-color: rgba(100, 160, 255, 0.5);
      color: #ffffff;
      transform: translateY(-1px);
    }
    .dsh-chip:active {
      transform: scale(0.96);
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "dsh-quick-actions-bar";

  const chips = [
    { label: "🐞 诊断报错", cmd: "/diagnosing-bugs " },
    { label: "🧪 TDD 单测", cmd: "/tdd " },
    { label: "🔍 代码审查", cmd: "/code-review " },
    { label: "🏗️ 架构设计", cmd: "/codebase-design " },
    { label: "🧙 交互向导", cmd: "/wizard " },
    { label: "🧐 方案拷问", cmd: "/grill-me " },
  ];

  chips.forEach((c) => {
    const chip = document.createElement("div");
    chip.className = "dsh-chip";
    chip.textContent = c.label;
    chip.title = `插入 ${c.cmd.trim()} 技能`;
    chip.addEventListener("click", () => {
      insertPathText(c.cmd);
    });
    bar.appendChild(chip);
  });

  document.body.appendChild(bar);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initQuickActions);
} else {
  initQuickActions();
}
