/**
 * 严格核验孤儿进程身份与归属 (IMPLEMENT.md 5.1.1, R1-2, 5.9 项四, 5.11 项三)
 * 采用“证据齐备制”：任何关键证据缺失（如 startTime 缺失、CreationDate 无法解析、时间差>60s、端口未归属）均直接拒绝终止
 * @param {object} record pid 文件记录
 * @param {object} procInfo 操作系统查询到的进程信息 { ProcessName, CommandLine, CreationDate }
 * @param {boolean} isPortOwner 是否确实为目标端口的监听进程
 * @returns {{ verified: boolean, reason?: string }}
 */
function verifyProcessIdentity(record, procInfo, isPortOwner) {
  if (!record || typeof record !== "object") {
    return { verified: false, reason: "pid 文件记录缺失或格式无效" };
  }
  if (!procInfo || typeof procInfo !== "object") {
    return { verified: false, reason: "操作系统未能查到目标 PID 进程信息" };
  }

  // 1. 严格核验托管标记
  if (record.managed !== "dsh-desktop") {
    return { verified: false, reason: "缺失或无效的 managed 托管标记" };
  }

  // 2. 严格核验命令行特征片段
  const pCmd = String(procInfo.CommandLine || "").toLowerCase();
  const snippet = String(record.commandLineSnippet || "").toLowerCase().trim();
  if (!snippet || !pCmd.includes(snippet)) {
    return { verified: false, reason: "进程命令行特征与记录片段不匹配" };
  }

  // 3. 进程名合法性断言
  const pName = String(procInfo.ProcessName || "").toLowerCase();
  const nameMatched = pName.includes("node") || pName.includes("electron") || pName.includes("dsh");
  if (!nameMatched) {
    return { verified: false, reason: "进程名称不属于已知的 Node/Electron/DSH 运行时" };
  }

  // 4. 进程创建时间戳证据齐备核验 (防 PID 重用)
  if (!record.startTime || !procInfo.CreationDate) {
    return { verified: false, reason: "关键时间证据缺失 (record.startTime 或 procInfo.CreationDate 不存在)" };
  }

  let creationMs = null;
  const dateStr = String(procInfo.CreationDate);
  const numMatch = dateStr.match(/\d+/);
  if (numMatch) {
    const raw = numMatch[0];
    if (raw.length === 14) {
      // YYYYMMDDHHmmss 格式
      const y = parseInt(raw.slice(0, 4), 10);
      const m = parseInt(raw.slice(4, 6), 10) - 1;
      const d = parseInt(raw.slice(6, 8), 10);
      const h = parseInt(raw.slice(8, 10), 10);
      const min = parseInt(raw.slice(10, 12), 10);
      const s = parseInt(raw.slice(12, 14), 10);
      creationMs = new Date(Date.UTC(y, m, d, h, min, s)).getTime();
    } else if (raw.length >= 12) {
      creationMs = Number(raw);
    }
  }
  if (!creationMs || isNaN(creationMs)) {
    const parsed = Date.parse(dateStr);
    if (!isNaN(parsed)) creationMs = parsed;
  }

  if (!creationMs || isNaN(creationMs)) {
    return { verified: false, reason: `进程 CreationDate 无法解析为有效时间戳: ${procInfo.CreationDate}` };
  }

  const diff = Math.abs(creationMs - record.startTime);
  if (diff > 60_000) {
    return { verified: false, reason: `PID 重用警报：进程创建时间与记录启动时间容差过大 (diff: ${diff}ms > 60s)` };
  }

  // 5. 目标端口监听归属核验
  if (!isPortOwner) {
    return { verified: false, reason: "目标端口当前并未由该 PID 监听" };
  }

  return { verified: true };
}

/**
 * 从 Windows netstat -ano 输出中提取监听端口与 PID 列表 (IMPLEMENT.md 5.11 项三)
 * 能够精确拆分 IPv4 (0.0.0.0:3080) 与 IPv6 ([::]:3080, [::1]:3080)
 * @param {string} netstatOutput
 * @returns {Array<{ localAddr: string, port: number, pid: number }>}
 */
function parseNetstatListeningPorts(netstatOutput) {
  if (!netstatOutput || typeof netstatOutput !== "string") return [];
  const entries = [];
  const lines = netstatOutput.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 5 && parts[3] === "LISTENING") {
      const localAddr = parts[1];
      const owningPid = parseInt(parts[parts.length - 1], 10);
      const lastColon = localAddr.lastIndexOf(":");
      if (lastColon !== -1) {
        const portStr = localAddr.slice(lastColon + 1);
        const parsedPort = parseInt(portStr, 10);
        if (!isNaN(parsedPort) && !isNaN(owningPid)) {
          entries.push({ localAddr, port: parsedPort, pid: owningPid });
        }
      }
    }
  }
  return entries;
}

/**
 * 精确判断目标 PID 是否正在监听目标端口 (IMPLEMENT.md 5.11 项三)
 * 杜绝字符串模糊匹配导致 3080 误匹配 30801 的问题
 * @param {string} netstatOutput
 * @param {number|string} targetPid
 * @param {number|string} targetPort
 * @returns {boolean}
 */
function checkPortOwnerFromNetstat(netstatOutput, targetPid, targetPort) {
  const p = Number(targetPort);
  const id = Number(targetPid);
  if (isNaN(p) || isNaN(id)) return false;
  const entries = parseNetstatListeningPorts(netstatOutput);
  return entries.some((e) => e.port === p && e.pid === id);
}

module.exports = {
  verifyProcessIdentity,
  parseNetstatListeningPorts,
  checkPortOwnerFromNetstat,
};
