/**
 * DSH Desktop - Kernel Readiness & Dual-Track Auth Utility (P0-1 Reliability)
 * 就绪判定与双轨免死认证（Cookie + Token 互保机制）
 */

const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const { resolveDshHome, getCredentialsYamlPath } = require("./home");

const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_PAYLOAD_VERSION = 1;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value) {
  if (!value || typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    return null;
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + padding, "base64");
  return encodeBase64Url(decoded) === value ? decoded : null;
}

/**
 * 从 .credentials.yaml 文本中提取 client-connection/browser-session 的持久化密钥
 * @param {string} rawYaml
 * @returns {string|null}
 */
function extractBrowserSessionSecret(rawYaml) {
  if (!rawYaml || typeof rawYaml !== "string") return null;
  const match = rawYaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(?:["']?)([A-Za-z0-9_-]+)/);
  return match && match[1] ? match[1].trim() : null;
}

/**
 * 为 Electron 会话静默生成官方 HMAC 签名的持久化认证 Cookie
 * 允许桌面客户端无缝直连微内核，消除对 stdout 正则 Token 单轨抓取的致命依赖
 * @param {number} port 目标端口
 * @param {object} [options]
 * @returns {{ name: string, value: string, authority: string, url: string, expiresAt: number }|null}
 */
function mintKernelAuthCookie(port, options = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) return null;

  try {
    let rawYaml = options.yamlContent || null;
    if (!rawYaml) {
      const dshHome = options.dshHome || resolveDshHome();
      const yamlPath = options.yamlPath || getCredentialsYamlPath(dshHome);
      if (fs.existsSync(yamlPath)) {
        rawYaml = fs.readFileSync(yamlPath, "utf8");
      }
    }

    const secretBase64Url = extractBrowserSessionSecret(rawYaml);
    if (!secretBase64Url) return null;

    const secret = decodeBase64Url(secretBase64Url);
    if (!secret || secret.byteLength !== 32) return null;

    const authority = `127.0.0.1:${numericPort}`;
    const cookieName = COOKIE_PREFIX + encodeBase64Url(crypto.createHash("sha256").update(authority).digest());
    const issuedAt = Date.now();
    const maxAgeMs = (options.maxAgeDays || 30) * 24 * 3600 * 1000;
    const expiresAt = issuedAt + maxAgeMs;

    const payload = {
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
    };

    const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = encodeBase64Url(crypto.createHmac("sha256", secret).update(body).digest());
    const cookieValue = `v1.${body}.${sig}`;

    return {
      name: cookieName,
      value: cookieValue,
      authority,
      url: `http://${authority}`,
      expiresAt,
    };
  } catch (_e) {
    return null;
  }
}

/**
 * 校验指定 URL 是否为当前回环端口的合法微内核工作台地址
 * @param {string} authUrl
 * @param {number} expectedPort
 * @returns {boolean}
 */
function isKernelActivationUrl(authUrl, expectedPort) {
  if (!authUrl || !Number.isInteger(Number(expectedPort))) return false;

  try {
    const parsed = new URL(authUrl);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : 80;
    return parsed.protocol === "http:"
      && (hostname === "127.0.0.1" || hostname === "localhost")
      && port === Number(expectedPort);
  } catch (_err) {
    return false;
  }
}

/**
 * 校验响应内容是否具备确凿的官方 DSH 微内核特征
 * 严禁仅靠 "dsh" 等短串判定（防范类似 redshift dashboard 等外部服务误判）
 * @param {string} body
 * @returns {boolean}
 */
function isOfficialDshContent(body) {
  if (!body || typeof body !== "string") return false;
  const lower = body.toLowerCase();

  // 1. 明确的官方独占关键词组合
  if (lower.includes("deepseek harness") || lower.includes("deepseek-ai") || lower.includes("__moduleloader__")) {
    return true;
  }

  // 2. 官方微内核 Cordis 框架与 DSH 命名空间结合
  if (lower.includes("cordis") && (/\bdsh\b/i.test(body) || lower.includes("harness"))) {
    return true;
  }

  // 3. 官方微内核专属 401 拦截签名
  if (/\bdsh\s*web\s*authentication\s*required\b/i.test(body)) {
    return true;
  }

  // 4. HTML 标题明确声明 DeepSeek
  if (/<title>[^<]*deepseek[^<]*<\/title>/i.test(body)) {
    return true;
  }

  return false;
}

/**
 * 主动通过 HTTP 探测目标端口上的服务是否为真实已就绪的 DSH 微内核
 * @param {number} port
 * @param {object} [options]
 * @param {boolean} [options.requireAuthenticated] 是否要求必须已通过认证（200 OK）方可判定就绪
 * @returns {Promise<boolean>}
 */
function verifyKernelHttpReady(port, options = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(val));
    };

    const cookie = options.cookie || mintKernelAuthCookie(numericPort, options);
    const headers = {
      Host: `127.0.0.1:${numericPort}`,
    };
    if (cookie) {
      headers.Cookie = `${cookie.name}=${cookie.value}`;
    }

    const req = http.get(
      {
        host: "127.0.0.1",
        port: numericPort,
        path: "/",
        headers,
        timeout: options.timeoutMs || 2500,
      },
      (res) => {
        let body = "";
        let destroyedEarly = false;

        const evaluateResult = () => {
          if (res.statusCode === 200) {
            return isOfficialDshContent(body);
          }
          if (res.statusCode === 401) {
            if (options.requireAuthenticated) {
              return false;
            }
            return isOfficialDshContent(body);
          }
          return false;
        };

        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 500) {
            destroyedEarly = true;
            const ok = evaluateResult();
            res.destroy();
            settle(ok);
          }
        });

        res.on("end", () => {
          if (!destroyedEarly) {
            settle(evaluateResult());
          }
        });

        res.on("close", () => {
          // 兜底：处理 res.destroy() 之后未能触发 end 的场景，杜绝 Promise 挂起
          settle(evaluateResult());
        });

        res.on("error", () => settle(false));
      }
    );

    req.on("error", () => settle(false));
    req.on("timeout", () => {
      req.destroy();
      settle(false);
    });
  });
}

module.exports = {
  isKernelActivationUrl,
  extractBrowserSessionSecret,
  mintKernelAuthCookie,
  verifyKernelHttpReady,
  isOfficialDshContent,
};

