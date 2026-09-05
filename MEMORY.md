# 工程记忆与避坑指南 (Knowledge Runtime)

> **准入五问**：下次还会遇到吗？有代码证据吗？能独立成立吗？已存在吗？是反直觉结论吗？（任一为否绝不沉淀）

## 沉淀规则索引

### [ID: DSH-WebProfile-Npmrc-ERESOLVE]
- **角色**: Constraint
- **生效范围**: `main.js`, `~/.dsh/profiles/web/*`
- **核心结论**: 必须在客户端启动生命周期（`sanitizeWebProfile`）中强制确保 `~/.dsh/profiles/web/.npmrc` 包含 `legacy-peer-deps=true` 与 `registry=https://registry.npmmirror.com/`。
- **成立证据**: 官方新内核（如 `0.1.2-rc.1`）与社区插件（如 `@nanmicoder/dsh-auto-mode`）锁定的旧版 alpha peerDependencies 发生版本代差时，npm 默认的严格依赖解析会抛出 `ERESOLVE` 并静默中断安装，导致插件市场内点击“更新/安装”完全无响应。
- **失效条件**: 官方插件市场内核架构废除宿主模式 npm 直接安装，改用独立隔离容器后废止。

### [ID: DSH-Orphan-Port-Hijack]
- **角色**: Diagnostic & Constraint
- **生效范围**: `main.js`, `dsh-runner.js`, `src/main/utils/port.js`
- **核心结论**: 启动前必须通过 `cleanupOrphanBackend(port)` 终结监听目标端口的历史残留 `dsh web` 孤儿进程，并配合 `acquirePort` 动态避让端口，严禁盲目复用未知版本的监听者。
- **成立证据**: 远古版本（如 `0.1.0-rc.8`）孤儿进程未随应用关闭退出并常驻后台霸占 3080 端口，新版客户端若检测到端口占用直接复用，将导致新特性会话（如含 `model/selection` 事件）无法被老内核解析，触发 `SessionFormatUnsupportedError: unknown to this harness` 致命报错。
- **失效条件**: 官方内核自身提供 IPC 动态握手协议或热插拔端口协商能力后废止。

### [ID: DSH-NetworkShim-Request-Headers]
- **角色**: Diagnostic & Constraint
- **生效范围**: `network-shim.js`, `main.js`
- **核心结论**: 在垫片重写原生 `fetch` 时，当传入的第一个参数已是 `Request` 实例，严禁直接构造覆盖 headers。必须使用 `new Headers(input.headers)` 完整提取原 Request 的 Headers，再将后续 options.headers 浅层覆盖，否则 `Authorization` 凭据标头将被丢弃，导致后端鉴权失败或模型调用报 500。
- **成立证据**: Node.js 原生 Undici `fetch` 实现中，如果传参为 `(Request, options)`，底层不会自动将原 Request 实例的 headers 深度合并进 options。若直接传入 options.headers，原 Request 的认证头信息将静默丢失。
- **失效条件**: 官方不再依赖 network-shim 垫片，或 Node.js Undici 原生规范调整入参合并策略。

### [ID: DSH-Process-Pipe-Watchdog]
- **角色**: Constraint
- **生效范围**: `network-shim.js`, `main.js`
- **核心结论**: Windows 下通过 `spawn` 启动的深层 Node.js / NPX 子进程无法响应主进程非正常退出（如崩溃、任务管理器强制结束、断电）下的常规进程树清理。必须在子进程入口绑定 `process.stdin.on('end', ...)` 和 `process.stdin.on('error', ...)` 作为看门狗管道监听，检测到父进程管道断开时毫秒级执行 `process.exit(0)` 自毁退出。
- **成立证据**: Windows 缺乏原生 POSIX 进程树信号继承机制。主进程非正常退出时操作系统仅关闭 stdio 管道句柄，子进程沦为孤儿进程并长期常驻后台独占端口，导致下一次启动时发生端口冲突与会话协议不匹配。
- **失效条件**: Windows Job Object 在所有 Node.js / Electron 启动模式下全自动托管生命周期时废止。

