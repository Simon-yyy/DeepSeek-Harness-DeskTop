/**
 * DSH Desktop - Port Utility
 * 端口检测与安全分配机制
 */
const net = require("node:net");

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function acquirePort(preferred = 3080, maxOffset = 10, cleanupFn = null) {
  if (typeof cleanupFn === "function") {
    cleanupFn(preferred);
    await new Promise((r) => setTimeout(r, 200));
  }

  for (let p = preferred; p < preferred + maxOffset; p++) {
    if (await isPortFree(p)) {
      return p;
    }
    if (typeof cleanupFn === "function") {
      cleanupFn(p);
      await new Promise((r) => setTimeout(r, 150));
      if (await isPortFree(p)) {
        return p;
      }
    }
  }
  throw new Error(`DSH_BACKEND_NO_PORT: 端口 ${preferred}-${preferred + maxOffset - 1} 全部被占用`);
}

module.exports = {
  isPortFree,
  acquirePort,
};
