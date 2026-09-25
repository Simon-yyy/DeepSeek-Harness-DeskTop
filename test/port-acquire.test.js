const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const { acquirePort, isPortFree } = require("../src/main/utils/port");

test("acquirePort 直接使用生产代码：端口可用探测、安全避让与非破坏性守护", async () => {
  // 0. 动态探测一个可用空闲端口基准，避免硬编码 49152 与 Windows 动态端口池冲突
  const baseProbe = net.createServer();
  await new Promise((r) => baseProbe.listen(0, "127.0.0.1", r));
  const basePort = baseProbe.address().port;
  await new Promise((r) => baseProbe.close(r));

  // 1. 空闲端口直接返回
  const p1 = await acquirePort(basePort, 5);
  assert.strictEqual(p1, basePort);

  // 2. 模拟被外部未知 Node/进程占用
  const dummy = net.createServer();
  await new Promise((r) => dummy.listen(p1, "127.0.0.1", r));

  let cleanupCalledWith = null;
  const safeCleanup = (port) => {
    cleanupCalledWith = port;
    // 无法确认为本应用孤儿，拒绝误杀，返回 false
    return false;
  };

  // 3. 必须安全递增避让到下一个端口，绝对不阻断也不误杀外部服务 (5.1.1)
  const p2 = await acquirePort(p1, 5, safeCleanup);
  assert.strictEqual(cleanupCalledWith, p1);
  assert.strictEqual(p2, p1 + 1, "检测到未知监听者占用后必须自动递增避让");

  // 4. 清理模拟 server
  await new Promise((r) => dummy.close(r));
});
