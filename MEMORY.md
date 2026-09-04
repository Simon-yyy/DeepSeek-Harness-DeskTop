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
- **生效范围**: `main.js`, `dsh-runner.js`
- **核心结论**: 启动前必须通过 `cleanupOrphanBackend(port)` 终结监听 3080 端口的历史残留 `dsh web` 孤儿进程，严禁盲目复用未知版本的 3080 监听者。
- **成立证据**: 远古版本（如 `0.1.0-rc.8`）孤儿进程未随应用关闭退出并常驻后台霸占 3080 端口，新版客户端若检测到端口占用直接复用，将导致新特性会话（如含 `model/selection` 事件）无法被老内核解析，触发 `SessionFormatUnsupportedError: unknown to this harness` 致命报错。
- **失效条件**: 官方内核自身提供 IPC 动态握手协议或热插拔端口协商能力后废止。
