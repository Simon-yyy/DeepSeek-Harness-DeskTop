const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function acquirePort(preferred = 3080, maxOffset = 10) {
  for (let p = preferred; p < preferred + maxOffset; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`DSH_BACKEND_NO_PORT: ${preferred}-${preferred + maxOffset - 1}`);
}

test("acquirePort 端口可用探测与避让", async () => {
  const p1 = await acquirePort(49152, 5);
  assert.ok(p1 >= 49152);

  // 模拟占用
  const dummy = net.createServer();
  await new Promise((r) => dummy.listen(p1, "127.0.0.1", r));

  const p2 = await acquirePort(p1, 5);
  assert.ok(p2 > p1, "检测到占用后必须自动漂移到更高端口");

  await new Promise((r) => dummy.close(r));
});
