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

function dismissDragOverlay() {
  try {
    window.dispatchEvent(new Event("dragend"));
    document.dispatchEvent(new Event("dragend"));
  } catch {}
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
      let handled = false;
      for (let i = 0; i < clipboardData.files.length; i++) {
        const file = clipboardData.files[i];
        if (file.path) {
          insertPathText(file.path);
          handled = true;
        }
      }
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
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
// 2. Drag & Drop: Full document support (PDF, Word, Excel, Code) without rejected toast
// ---------------------------------------------------------------------------
window.addEventListener(
  "dragover",
  (event) => {
    event.preventDefault();
  },
  true
);

window.addEventListener(
  "dragleave",
  (event) => {
    if (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) {
      dismissDragOverlay();
    }
  },
  true
);

window.addEventListener(
  "drop",
  async (event) => {
    // Intercept to prevent web app from rejecting non-image files with "仅支持图片" toast
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissDragOverlay();

    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !dataTransfer.files || dataTransfer.files.length === 0) return;

    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i];

      // Any file from local disk (PDF, Word, Excel, Code, etc.)
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
  true // Capture phase: must intercept before web app's rejected toast!
);

// Escape key to dismiss any stuck drag state
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    dismissDragOverlay();
  }
});
