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
