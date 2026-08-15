const { ipcRenderer } = require("electron");

function insertPathText(filePath) {
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

// 1. Intercept Image Paste
window.addEventListener(
  "paste",
  async (event) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    let imageFile = null;

    // Check clipboardData.files
    if (clipboardData.files && clipboardData.files.length > 0) {
      for (let i = 0; i < clipboardData.files.length; i++) {
        const file = clipboardData.files[i];
        if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
          imageFile = file;
          break;
        }
      }
    }

    // Check clipboardData.items
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
      // Synchronously halt native attachment intake
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

// 2. Intercept Image Drop (Drag and Drop files into input)
window.addEventListener(
  "drop",
  async (event) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !dataTransfer.files || dataTransfer.files.length === 0) return;

    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i];
      if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
        event.preventDefault();
        event.stopImmediatePropagation();

        // If it already has a local file path on disk (Electron File object)
        if (file.path) {
          insertPathText(file.path);
        } else {
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
        break;
      }
    }
  },
  true // Capture phase
);


