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
  // 1. 严格递增探测：严禁盲目在探测前无差别清理
  for (let p = preferred; p < preferred + maxOffset; p++) {
    if (await isPortFree(p)) {
      return p;
    }

    // 2. 仅对首选端口且提供合法清理函数时尝试校验并回收属于本应用的孤儿
    if (p === preferred && typeof cleanupFn === "function") {
      try {
        const cleaned = await cleanupFn(p);
        if (cleaned) {
          await new Promise((r) => setTimeout(r, 200));
          if (await isPortFree(p)) {
            return p;
          }
        }
      } catch (_e) {}
    }
    // 3. 未知监听者或非首选端口占用：遵循规范递增端口避让（3081+），严禁误杀
  }
  throw new Error(`DSH_BACKEND_NO_PORT: 端口 ${preferred}-${preferred + maxOffset - 1} 全部被占用`);
}

module.exports = {
  isPortFree,
  acquirePort,
};
