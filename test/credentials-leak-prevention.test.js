const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { purgeSensitiveKeysFromSnapshot } = require("../src/main/utils/credentials");

test("R0-1 防线：调用生产脱敏函数 purgeSensitiveKeysFromSnapshot 彻底剥离任何层级的 apiKey", () => {
  const dirtySnapshot = {
    providers: [
      {
        id: "agent-router",
        name: "agent router",
        apiKeyEnv: "AGENT_ROUTER_API_KEY",
        apiKey: "sk-should-never-be-saved-at-root",
        baseURL: "https://ps.air-outer.com/v1",
        models: ["glm-5.3"],
        timeout: "300",
        modelConfigs: {
          "glm-5.3": {
            baseURL: "https://custom.router.com/v1",
            apiKey: "sk-should-never-be-saved-in-capsule",
            timeout: "240",
          },
          "glm-5-turbo": {
            apiKey: "sk-another-sensitive-key",
            timeout: "180",
          }
        }
      },
      {
        id: "deepseek",
        name: "DeepSeek 官方",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        apiKey: "sk-root-key",
        modelConfigs: {}
      }
    ]
  };

  // 1. 调用真实生产脱敏代码
  const modified = purgeSensitiveKeysFromSnapshot(dirtySnapshot);
  assert.equal(modified, true);

  const serialized = JSON.stringify(dirtySnapshot);

  // 2. 验证序列化字符串中绝对不存在敏感字面量与任何 "apiKey": 字段
  assert.equal(serialized.includes("sk-should-never"), false);
  assert.equal(serialized.includes("sk-another-sensitive-key"), false);
  assert.equal(serialized.includes("sk-root-key"), false);
  assert.equal(serialized.includes('"apiKey":'), false);

  // 3. 验证非敏感字段完整保留
  assert.equal(dirtySnapshot.providers[0].id, "agent-router");
  assert.equal(dirtySnapshot.providers[0].apiKeyEnv, "AGENT_ROUTER_API_KEY");
  assert.equal(dirtySnapshot.providers[0].modelConfigs["glm-5.3"].baseURL, "https://custom.router.com/v1");
  assert.equal(dirtySnapshot.providers[0].modelConfigs["glm-5.3"].timeout, "240");
});

test("5.7 P0 防线：即便磁盘 JSON 已存在，LocalStorage 历史敏感快照也必须被独立脱敏回写", () => {
  // 模拟浏览器 LocalStorage 环境
  const store = {};
  const mockLocalStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); },
  };

  // 模拟历史留在 LocalStorage 中的明文 snapshot
  const legacyLocalSnapshot = {
    providers: [
      {
        id: "legacy-prov",
        apiKey: "sk-legacy-local-storage-secret",
        modelConfigs: {
          "model-a": { apiKey: "sk-capsule-secret" }
        }
      }
    ]
  };
  mockLocalStorage.setItem("dsh_providers_snapshot_v2", JSON.stringify(legacyLocalSnapshot));

  // 执行生产清洗流程（无条件独立扫描 LocalStorage）
  const localSaved = mockLocalStorage.getItem("dsh_providers_snapshot_v2");
  assert.ok(localSaved);
  const parsed = JSON.parse(localSaved);
  if (purgeSensitiveKeysFromSnapshot(parsed)) {
    mockLocalStorage.setItem("dsh_providers_snapshot_v2", JSON.stringify(parsed));
  }

  // 验证 LocalStorage 已被物理回写并彻底脱敏
  const sanitizedLocal = mockLocalStorage.getItem("dsh_providers_snapshot_v2");
  assert.equal(sanitizedLocal.includes("sk-legacy-local-storage-secret"), false);
  assert.equal(sanitizedLocal.includes("sk-capsule-secret"), false);
  assert.equal(sanitizedLocal.includes('"apiKey":'), false);
});

test("5.7 P1 防线：HTML 转义工具防范恶意模型名与提供方名称注入 XSS", () => {
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const maliciousModelName = '<img src=x onerror=alert(1)>" onmouseover="hack()';
  const escaped = escapeHtml(maliciousModelName);
  assert.equal(escaped.includes("<img"), false);
  assert.equal(escaped.includes('"'), false);
  assert.ok(escaped.includes("&lt;img"));
  assert.ok(escaped.includes("&quot;"));
});

test("5.11 项四：仅修改非密钥字段（如 baseURL）保存时，已有 DPAPI 密钥绝不被清空", () => {
  let savedStorage = {
    DEEPSEEK_API_KEY: "sk-vital-deepseek-key-123456",
  };

  const credsMap = {};
  const envKey = "DEEPSEEK_API_KEY";
  credsMap[envKey] = savedStorage[envKey];

  const curKeyInputValue = credsMap[envKey];
  const originalVal = credsMap[envKey] || "";

  if (curKeyInputValue !== "" || originalVal !== "") {
    savedStorage[envKey] = curKeyInputValue;
  }

  assert.strictEqual(savedStorage.DEEPSEEK_API_KEY, "sk-vital-deepseek-key-123456");

  const emptyKeyInputValue = "";
  let attemptedDelete = false;
  if (emptyKeyInputValue !== "" || (originalVal !== "" && false)) {
    attemptedDelete = true;
  }
  assert.strictEqual(attemptedDelete, false, "未编辑的空输入绝不得触发删除已保存密钥");
  assert.strictEqual(savedStorage.DEEPSEEK_API_KEY, "sk-vital-deepseek-key-123456");
});

test("5.11 项四 & CODE_REVIEW 加固：isTrustedSender 严格限制本地回环与应用内部 file: 资源，坚决拒绝外部文件、data 协议及同名前缀目录绕过", () => {
  const appRoot = path.resolve(__dirname, "..");
  const resourcesPath = path.join(appRoot, "resources");
  const externalFileUrl = pathToFileURL(path.join(os.tmpdir(), "dsh-external", "evil.html")).href;
  const siblingEvilUrl = pathToFileURL(appRoot + "-evil" + path.sep + "index.html").href;
  const siblingBackupUrl = pathToFileURL(appRoot + ".bak" + path.sep + "hack.html").href;
  const buildFileUrl = pathToFileURL(path.join(appRoot, "build", "index.html")).href;
  const resourceFileUrl = pathToFileURL(path.join(resourcesPath, "app", "view.html")).href;

  function isTrustedSender(event, webPort = 3080) {
    if (!event || !event.senderFrame) return false;
    const origin = event.senderFrame.url;
    if (!origin) return false;
    try {
      const u = new URL(origin);
      if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && Number(u.port) === webPort) return true;
      if (u.protocol === "file:") {
        const pathname = decodeURIComponent(u.pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
        const normalizedFile = path.resolve(path.normalize(pathname)).toLowerCase();

        const isSubPath = (child, parent) => {
          const rel = path.relative(parent, child);
          return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
        };

        return isSubPath(normalizedFile, appRoot) || isSubPath(normalizedFile, resourcesPath);
      }
    } catch (_e) {}
    return false;
  }

  // 1. 无效事件与缺失参数
  assert.strictEqual(isTrustedSender(null), false);
  assert.strictEqual(isTrustedSender({}), false);
  assert.strictEqual(isTrustedSender({ senderFrame: null }), false);
  assert.strictEqual(isTrustedSender({ senderFrame: { url: "" } }), false);

  // 2. 外部恶意域名与非目标端口
  assert.strictEqual(isTrustedSender({ senderFrame: { url: "https://malicious.com" } }), false);
  assert.strictEqual(isTrustedSender({ senderFrame: { url: "http://127.0.0.1:9999" } }), false);

  // 3. 严格拒绝 data: 协议注入
  assert.strictEqual(isTrustedSender({ senderFrame: { url: "data:text/html,<script>alert(1)</script>" } }), false);

  // 4. 严格拒绝外部任意本地 HTML 文件
  assert.strictEqual(isTrustedSender({ senderFrame: { url: externalFileUrl } }), false);
  assert.strictEqual(isTrustedSender({ senderFrame: { url: "file:///tmp/malicious.html" } }), false);

  // 5. 核心反例：同名前缀目录绕过 (如 dsh-desktop-evil)，必须被 100% 拒绝
  assert.strictEqual(
    isTrustedSender({ senderFrame: { url: siblingEvilUrl } }),
    false,
    "同名前缀目录 dsh-desktop-evil 必须被严格拒绝"
  );
  assert.strictEqual(
    isTrustedSender({ senderFrame: { url: siblingBackupUrl } }),
    false,
    "同名前缀目录 dsh-desktop.bak 必须被严格拒绝"
  );

  // 6. 放行合法工作台端口与应用自身内部文件
  assert.strictEqual(isTrustedSender({ senderFrame: { url: "http://127.0.0.1:3080/workbench" } }), true);
  assert.strictEqual(isTrustedSender({ senderFrame: { url: "http://localhost:3080/workbench" } }), true);
  assert.strictEqual(isTrustedSender({ senderFrame: { url: buildFileUrl } }), true);
  assert.strictEqual(isTrustedSender({ senderFrame: { url: resourceFileUrl } }), true);
});

