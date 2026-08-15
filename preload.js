const { ipcRenderer, contextBridge } = require("electron");

// 通过 contextBridge 安全地将 Electron IPC 能力暴露给主 World
contextBridge.exposeInMainWorld('dshBridge', {
  // 主 World 中检测到文件路径后，调用此函数委托主进程用原生 insertText 注入
  insertPath: (filePath) => ipcRenderer.invoke('dsh-insert-path', filePath),
});

// ---------------------------------------------------------------------------
// 图片截图粘贴处理器（preload 隔离 World 中处理 IPC 图片保存）
// ---------------------------------------------------------------------------
window.addEventListener(
  "paste",
  async (event) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    // A. 资源管理器中复制的非图片文件 -> 走 dshBridge.insertPath
    if (clipboardData.files && clipboardData.files.length > 0) {
      let handled = false;
      for (let i = 0; i < clipboardData.files.length; i++) {
        const file = clipboardData.files[i];
        if (file.path && !file.type.startsWith("image/")) {
          ipcRenderer.invoke('dsh-insert-path', file.path).catch(() => {});
          handled = true;
        }
      }
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }

    // B. 剪贴板截图 -> 保存为临时文件，再注入路径
    let imageFile = null;
    if (clipboardData.items) {
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
        if (filePath) ipcRenderer.invoke('dsh-insert-path', filePath).catch(() => {});
      } catch (err) {
        console.error("[dsh-desktop] paste image failed:", err);
      }
    }
  },
  true
);
