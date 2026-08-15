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
// 4. Quick Action Chips: Ultra-minimalist, sleek native design
// ---------------------------------------------------------------------------
function initQuickActions() {
  if (document.getElementById("dsh-quick-actions-bar")) return;

  const style = document.createElement("style");
  style.id = "dsh-quick-actions-style";
  style.textContent = `
    #dsh-quick-actions-bar {
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 6px;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.65);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 16px;
      z-index: 999;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
      transition: all 0.2s ease;
      user-select: none;
    }
    .dsh-chip {
      font-size: 11.5px;
      color: #64748b;
      background: transparent;
      padding: 3px 9px;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 3px;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      white-space: nowrap;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
    }
    .dsh-chip:hover {
      background: rgba(0, 0, 0, 0.05);
      color: #0f172a;
      border-color: rgba(0, 0, 0, 0.08);
    }
    .dsh-chip:active {
      transform: scale(0.97);
    }

    /* Dark mode automatic adaptation */
    @media (prefers-color-scheme: dark) {
      #dsh-quick-actions-bar {
        background: rgba(30, 32, 40, 0.65);
        border-color: rgba(255, 255, 255, 0.08);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
      }
      .dsh-chip {
        color: #94a3b8;
      }
      .dsh-chip:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #f1f5f9;
        border-color: rgba(255, 255, 255, 0.12);
      }
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "dsh-quick-actions-bar";

  const chips = [
    { label: "🐞 诊断", cmd: "/diagnosing-bugs " },
    { label: "🧪 TDD", cmd: "/tdd " },
    { label: "🔍 审查", cmd: "/code-review " },
    { label: "🏗️ 架构", cmd: "/codebase-design " },
    { label: "🧙 向导", cmd: "/wizard " },
    { label: "🧐 拷问", cmd: "/grill-me " },
  ];

  chips.forEach((c) => {
    const chip = document.createElement("div");
    chip.className = "dsh-chip";
    chip.textContent = c.label;
    chip.title = `快捷插入 ${c.cmd.trim()} 技能`;
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
