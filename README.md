# DSH Desktop (DeepSeek Harness Desktop)

<p align="center">
  <img src="./build/icon-source.svg" width="120" height="120" alt="DSH Desktop Logo" />
</p>

<p align="center">
  <b>DeepSeek Harness 官方 Web GUI 的工业级现代化桌面客户端外壳 (Electron)</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-33.x-47848F?logo=electron&logoColor=white" alt="Electron 33" />
  <img src="https://img.shields.io/badge/Node.js-20%2B%20%7C%2022%2B-339933?logo=node.js&logoColor=white" alt="Node.js 20+ | 22+" />
  <img src="https://img.shields.io/badge/Tests-99%20PASS%20(100%25)-brightgreen" alt="99 Tests Passing" />
  <img src="https://img.shields.io/badge/Security-Windows%20DPAPI-blue" alt="Windows DPAPI Security" />
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License MIT" />
</p>

<p align="center">
  <a href="#-为什么选择-dsh-desktop">核心亮点</a> •
  <a href="#-快速安装与启动">快速安装</a> •
  <a href="#-全新模型与服务商配置指南">模型配置指南</a> •
  <a href="#-特色功能与日常使用技巧">日常使用</a> •
  <a href="#-常见问题与故障排查-faq">常见问题 FAQ</a> •
  <a href="#-开发者指南与项目结构说明">开发者指南</a> •
  <a href="#-致谢与开源鸣谢-acknowledgements">致谢鸣谢</a> •
  <a href="#-开源协议">开源协议</a>
</p>

---

## 🌟 为什么选择 DSH Desktop？

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 是 DeepSeek 官方出品的强大 Agent 编程框架。默认情况下它以命令行与临时浏览器网页形式运行，而 **DSH Desktop** 为其封装了具备独立窗口、托盘常驻与高可靠保障的工业级桌面外壳：

- 🖥️ **沉浸式桌面交互与正统美学**：告别杂乱的浏览器标签页，提供具备 Windows 任务栏常驻、系统托盘、无边框优雅窗口的桌面体验；内置 4 套正统 Escook 调色哲学主题与 8 款现代配色矩阵。
- 🛡️ **双轨免死认证与秒级静默直达**：主进程自动签发官方 HMAC-SHA256 签名鉴权 Cookie 注入 Session，配合激活 URL Token 实现双保险认证；由原子幂等导航控制器（`safeNavigateToWorkbench`）串行互斥调度，在 `finally` 块强制消费排队 Token，并依托轻量 MutationObserver 探测首屏 `#root` 挂载就绪后再优雅亮屏；彻底终结 Chromium `net::ERR_ABORTED (-3)` 与启动白屏/卡顿问题。
- 🔄 **微内核平滑热重启与真实推理探测**：模型配置中心保存后，主进程自动携带最新 DPAPI 解密环境变量平滑热重启微内核子进程（`restart-backend-service`），消除配置脱节引发的前端 WebSocket 闪断与 5 次重试假死；连通性测试升级为发送 `max_tokens: 1` 极简推理探测，深度透明化呈现 401/403/500 结构化拒绝原因并自动回退 `/models`。
- 🔐 **系统级 DPAPI 凭据安全与容灾自愈**：全面摒弃浏览器 LocalStorage 明文存储，通过 Windows DPAPI (`safeStorage`) 实现硬件级加密持久化（`credentials.bin`）；落盘实施 `0o600` 严格权限隔离，具备主文件损坏自动检测与基于时间戳由新到旧降序的备份自愈容灾引擎。
- 🌐 **全局网络免拦截垫片与看门狗**：底层通过 `NODE_OPTIONS` 首毫秒注入 `network-shim.js`，精准识别 `@earendil-works/pi-ai` 等底层微内核客户端，为第三方 AI 服务商请求统一注入 `cline/3.0.0` 白名单 User-Agent，深度保护 Node 原生 `fetch` 标头与 `Authorization` 继承，彻底阻断上游假敏感词（`500 sensitive_words_detected`）风控误杀；集成操作系统级管道断管自毁看门狗，父进程闪退或退出时子进程毫秒级自尽，彻底根除孤儿进程。
- 💻 **渲染层 CSP 运行时放行与开发调试通道**：CSP 响应头安全放行 `'unsafe-eval'` 与 `worker-src 'self' blob:;`，保障 Vite 动态 import 与 Shiki 语法高亮引擎平稳加载；开放 <kbd>F12</kbd> / <kbd>Ctrl+Shift+I</kbd> DevTools 并自动透传渲染错误至终端，告别排查黑盒。
- 🔌 **动态端口探测与自动避让漂移**：彻底告别端口冲突，默认 3080 端口被占用时自动向上毫秒级漂移至 3081+；拉起内核时强制锁定 `--host 127.0.0.1` 本地回环，杜绝防火墙报警与网络暴露。
- 🖼️ **原生多模态截图粘贴与沙箱直通**：输入框支持 **Ctrl + V 直接粘贴剪贴板截图** 或 **直接拖入图片**，主进程自动拦截落地至独立隔离沙箱（`temp/dsh-clipboard/`）并回填本地绝对路径，多模态模型无缝直读，退出自动清理缓存（限制 25MB 上限）。
- 🧩 **插件版本锁防崩与 Profile 自愈清洗**：启动前物理校验 bundle 存在性，自动清洗缺失声明，杜绝官方内核在 `composeProfile` 时抛出 `Exit Code: 1` 闪退崩溃；动态修复第三方插件的内核版本断言硬编码；`.npmrc` 实施非破坏性增量合并。
- 🚦 **双通道热升级与 99 项全绿单测门禁**：支持 GitHub Releases 客户端下载更新与 npm 官方微内核版本探测一键安全热升级；配备 7 大关键入口独立语法自动门禁（`node --check`）与 99 项全量自动化测试，零假阳性，零外部测试依赖。

---

## 🚀 快速安装与启动

### 方式 1：直接下载安装包（推荐普通用户）

1. 前往本仓库的 [Releases](../../releases) 页面；
2. 下载最新的 **`DSH Desktop Setup 1.3.0.exe`**；
3. 双击安装包完成安装，桌面和开始菜单将自动生成 **【DSH Desktop】** 快捷方式；
4. 双击打开，客户端将自动检测运行环境并拉起服务，秒级直达工作台。

> 📌 **运行前置要求**：
> 电脑需安装有 **Node.js**（推荐 v20 或 v22+ LTS，任意安装目录均可，客户端启动时会自动探测 Windows PATH、NVM、FNM、Volta、Scoop 及 NPX 缓存；未检测到时首秒弹出友好引导提示）。

---

### 方式 2：从源码运行与二次开发（开发者模式）

确保本地已安装 Node.js 与 Git：

```bash
# 1. 克隆本仓库
git clone https://github.com/Simon-yyy/DeepSeek-Harness-DeskTop.git
cd dsh-desktop

# 2. 安装项目依赖
npm install

# 3. 运行自动化单元测试套件（99 项用例 100% 绿灯）
npm test

# 4. 启动 Electron 开发调试模式
npm start
```

---

## ⚙️ 全新模型与服务商配置指南

**DSH Desktop** 在前端设置层深度集成了原生的 **【模型配置中心】**，彻底取代过去繁琐的外部命令行或文本手工修改。

### 1️⃣ 如何打开模型配置面板？
1. 启动 **DSH Desktop**；
2. 点击界面左下角的 **「⚙️ 设置 (Settings)」** 按钮；
3. 在左侧菜单点击 **「模型」**，即可即时唤起图形化模型服务商管理面板。

---

### 2️⃣ 默认内置的五大服务商预设

客户端预置了主流官方与聚合网关服务商模板，输入 API Key 即可一键启用：

| 服务商预设 | 默认 Base URL | 预置主流模型支持 | 对应密钥环境变量 |
| :--- | :--- | :--- | :--- |
| **DeepSeek 官方** | `https://api.deepseek.com/v1` | `deepseek-chat`, `deepseek-reasoner` (R1) | `DEEPSEEK_API_KEY` |
| **GLM (智谱清言)** | `https://open.bigmodel.cn/api/coding/paas/v4` | `glm-4.5`, `glm-5`, `glm-5.3`, `glm-5.3-flash` 等 | `BIGMODEL_API_KEY` |
| **OpenAI 官方** | `https://api.openai.com/v1` | `gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini` | `OPENAI_API_KEY` |
| **Anthropic 官方** | `https://api.anthropic.com/v1` | `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet` 等 | `ANTHROPIC_API_KEY` |
| **agent router** | `https://ps.air-outer.com/v1` | `glm-5.3` | `AGENT_ROUTER_API_KEY` |

---

### 3️⃣ 接入自定义端点与私有化模型 (Ollama / vLLM / 兼容网关)

除了预设服务商外，你可以通过面板顶部的 **「➕ 添加服务商」** 接入任意 OpenAI 或 Anthropic 兼容端点：

#### 场景 A：接入国内大模型与聚合平台（通义千问 / 硅基流动 / One-API）
- **协议类型**：选择 `openai`；
- **服务商名称**：自定义（如 `SiliconFlow` 或 `通义千问`）；
- **Base URL**：
  - 阿里百炼通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1`
  - 硅基流动：`https://api.siliconflow.cn/v1`
- **API Key**：填入对应的平台令牌；
- **模型列表**：填入支持的模型标识（如 `qwen2.5-coder-32b-instruct`、`deepseek-ai/DeepSeek-V3` 等）。

#### 场景 B：接入本地离线大模型 (Ollama / vLLM / LM Studio)
实现 **100% 局域网纯离线安全编程**，无任何外网网络外发：
- **协议类型**：`openai`；
- **Base URL**：
  - Ollama 本地端点：`http://127.0.0.1:11434/v1`
  - vLLM / LM Studio 本地端点：`http://127.0.0.1:1234/v1`
- **API Key**：填写任意非空占位符（如 `ollama`）；
- **模型列表**：填写本地拉取的模型名（如 `deepseek-r1:14b`、`qwen2.5-coder:32b`）。

---

### 4️⃣ 🔒 凭据安全存储与隐私保障

- **系统级加密持久化**：用户填入的 API Key 绝不以明文存储在 LocalStorage 或未受保护的文件中，而是经由 Electron 主进程调用 **Windows DPAPI** 系统硬件级加密 API，密文持久化于 `%APPDATA%/dsh-desktop/credentials.bin`。
- **文件权限收敛**：落盘文件严格实施 `0o600`（仅当前 Windows 用户具备读写权限）。
- **多备份自愈容灾**：系统自动轮转保护备份，读取主文件损坏时基于物理修改时间与时间戳由新到旧降序智能仲裁自愈，绝不丢失或静默覆盖既有密钥。
- **绝无隐私泄露**：客户端为纯本地外壳架构，所有请求直接由本地服务直连目标端点，不设任何中间代理或遥测收集服务器。

---

## 💡 特色功能与日常使用技巧

### 1. 原生多模态截图粘贴与设计图直传
- 在对话输入框中按下 **`Ctrl + V`**，或直接从桌面/资源管理器将图片拖入输入框；
- 客户端底层自动捕获图像二进制流，安全保存至本地临时目录并回填路径；
- 配合多模态视觉模型（如支持识图的 Claude 3.7、GPT-4o、Qwen-VL 等），实现原型图直出代码、报错截图即时排查。

### 2. 4 套专属精雕主题与 8 款配色矩阵
- 点击左下角 **「⚙️ 设置」➔「🎨 主题外观」**；
- 100% 对齐 VS Code 官方正统 `liulongbin1314.escook-theme` 调色哲学：
  - **escook Dark**：暖调极客深灰（`#252526`）搭配标志暖阳橙（`#ef820c`），长久编码护眼温润；
  - **escook Dark Soft**：Ayu 深海蓝灰（`#1f2430`）搭配柔光奶杏黄（`#ffcc66`）；
  - **escook Light**：Solarized 暖米白（`#fdf6e3`）搭配典雅紫罗兰（`#705697`），纸质书卷感；
  - **escook Light Soft**：现代极简清透浅灰（`#fafafa`）搭配蜜柑亮橙（`#ff9940`）；
- 点击配色卡片即时热切换，窗口样式、侧边栏与文字对比度全体系平滑适配。

### 3. Auto 智能自主模式
- 在输入框下方的执行权限下拉框中，可选择 **`Auto`** 模式；
- 常规的文件检索、代码读写、语法验证与单元测试执行由 Agent 全自动无感流转；
- 遇到破坏性文件删除或关键 Git 操作时，安全基座智能拦截并弹窗请求单次人工授权，兼顾开发效率与系统安全。

### 4. 一键导出全量环境诊断指纹
- 遇到任何疑难环境问题时，点击左下角 **「⚙️ 设置」➔「ℹ️ 关于」**；
- 点击 **「📋 复制诊断信息」** 按钮，一键聚合客户端版本、官方微内核版本、Node.js 路径、Electron 架构、分配端口等全量环境指纹，便于团队排查或提交 Issue。

### 5. 极简推理连通性探测与开发者调试通道
- **真实推理连通性探测**：在模型配置管理中点击连通性测试时，客户端向模型发送轻量推理请求（`max_tokens: 1`），精准透传解析 401/403/500 服务端具体错误原因，杜绝假连通与排查黑盒；
- **一键开发者工具调试**：随时按下快捷键 <kbd>F12</kbd> 或 <kbd>Ctrl + Shift + I</kbd>，直接调出 Chromium DevTools 审查 DOM、网络通信与控制台日志，关键渲染报错将同步透传至主终端。

---

## ❓ 常见问题与故障排查 (FAQ)

#### Q1：启动时卡在 Loading 屏或提示超时该怎么处理？
- **原因**：初次运行新机器时，若本地无预装内核，客户端需要通过网络拉取官方内核组件，偶发网络波动可能导致耗时较长。
- **机制与对策**：
  1. 客户端内置国内淘宝 `npmmirror` 镜像源加速与 **240 秒弹性心跳顺延机制**（检测到子进程持续输出时自动延长至 360 秒），杜绝死板误杀；
  2. 若子进程出现致命错误，具备 **Fail-Fast 即时短路**，立即弹窗呈现真实错误日志，告别盲等；
  3. 如需离线预热，可在终端提前执行一次 `npm install -g @deepseek-ai/dsh` 即可实现本地冷启动秒开。

#### Q2：我的 API Key 与密码安全吗？
- **答**：**绝对安全**。
  - DSH Desktop 将全部敏感凭据收敛至 Windows 原生 DPAPI 硬件加密通道，仅在当前用户登录态下可被解密；
  - 本地存储应用 `0o600` 物理权限隔离，任何其他未授权账户或前端代码均无法跨权限窃取明文；
  - 代码在加载配置快照时具备主动清洗机制，无条件清除 LocalStorage 中的历史残留。

#### Q3：启动时是否会触发 Windows Defender 防火墙报警？
- **答**：**不会**。
  - 客户端拉起后端微内核时显式追加了 `["--host", "127.0.0.1"]` 参数，严格绑定本地回环地址；
  - 杜绝向局域网或公网 `0.0.0.0` 暴露端口，彻底免除防火墙授权拦截弹窗。

#### Q4：调用某些第三方 AI 中转站时报 403、敏感词拦截或 UA 被杀？
- **答**：**已原生解决**。
  - 客户端内置的 `network-shim.js` 网络兼容垫片会在 Node 子进程启动首毫秒挂载；
  - 自动识别第三方 AI 推理请求并无感注入 `cline/3.0.0` 白名单 UA，同时深度处理 `@earendil-works/pi-ai` 产生的客户端特征，彻底封堵中转站假敏感词（`500 sensitive_words_detected`）误报；
  - 深度保护 `Authorization` 认证标头继承，杜绝中转站鉴权丢失。

#### Q5：退役后后台是否会残留僵尸/孤儿进程占用端口？
- **答**：**绝对不会**。
  - `network-shim.js` 中内置了父子进程管道断管看门狗；
  - 一旦 Electron 主窗口关闭、崩溃或被任务管理器强杀，子进程监听的父进程 stdin 管道将立即触发 EOF/error 事件，并在毫秒级执行自毁退出；
  - 同时主进程启动首秒具备 PID 持久化查杀机制，确保端口 100% 纯净。

#### Q6：修改/保存模型配置后是否需要手动重启应用？
- **答**：**无需手动重启**。
  - 在【模型配置管理】中保存配置后，前端自动通过 IPC 触发 `restart-backend-service`；
  - 主进程会平滑热重启微内核子进程并全量继承最新解密的环境变量与端口，前端会话无感平滑重载，彻底消除旧版本因配置脱节导致前端 WebSocket 闪断重试假死的问题。

#### Q7：启动直接进入工作台时为什么不再出现居中 Loading 弹窗和大白屏？
- **答**：**全新静默亮屏与 CSP 运行时放行**。
  - 彻底移除了居中全屏 Splash 呼吸卡片；
  - 导航器（`safeNavigateToWorkbench`）通过 MutationObserver 严密监听前端 `#root` 挂载就绪后再平滑展示窗口；
  - 结合主进程 CSP 安全放行 `'unsafe-eval'` 与 `worker-src`，消除 Vite 动态加载与 Shiki 高亮引擎异常，实现秒级直接呈现工作台。

---

## 🛠️ 开发者指南与项目结构说明

### 1. 常用开发与构建命令

```bash
# 执行全量自动化单元测试套件 (99 项原生用例 100% 绿灯，耗时 ~1.1s)
npm test

# 启动 Electron 开发调试模式
npm start

# 执行离线微内核深层瘦身 (递归剔除冗余碎文件，将安装包压缩 110MB+)
npm run prune:backend

# 构建 Windows 安装包 (NSIS 安装程序，输出至 release/)
npm run dist

# 自动化发版构建并归档 (自动前置瘦身 + 编译 + 计算 SHA-256 + 仅保留最新 2 个版本)
npm run release

# 重新生成多尺寸应用图标 (.ico / .png)
npm run build:icon

源码仓库不包含本地离线内核 bundled-backend/。如需打包安装程序，请先准备 bundled-backend/@deepseek-ai；该目录不会上传到仓库。
```

---

### 2. 核心架构与解耦目录树

```text
dsh-desktop/
├── build/                       # 应用打包构建资源与高分辨率图标源
│   ├── icon-source.svg          # 官方矢量图标源文件
│   └── icon.ico                 # Windows 多尺寸格式图标
├── src/                         # 工业级解耦源码体系
│   ├── main/                    # 主进程工具库
│   │   └── utils/
│   │       ├── compat.js        # 官方内核大版本兼容性检查矩阵与 SemVer 严格校验
│   │       ├── credentials.js   # DPAPI 凭据安全加解密、0o600 隔离与备份自愈容灾
│   │       ├── home.js          # DSH_HOME 路径解析优先级与多实例运行时隔离
│   │       ├── kernel.js        # 官方微内核版本探测、多源仲裁与升级版本校验
│   │       ├── port.js          # 动态端口探测与自动向上漂移避让引擎 (3080 -> 3081+)
│   │       ├── process-guard.js # 进程身份 6 项指纹强核验与端口防误杀守护
│   │       ├── profile.js       # Web Profile 纯净自愈清洗与插件版本锁防崩补丁
│   │       ├── readiness.js     # HMAC-SHA256 签名 Cookie 生成与微内核存活双轨探针
│   │       ├── updater.js       # 安装包哈希完整性决策与执行安全阻断
│   │       └── version.js       # SemVer 语义化版本大小比较工具
│   └── preload/                 # 渲染预加载工具库
│       └── utils/
│           └── yaml-providers.js# YAML 服务商状态机安全切片替换引擎 (防截断与防 $& 展开)
├── test/                        # 原生自动化单元测试体系 (node:test + node:assert)
│   ├── backend-readiness.test.js# 双轨认证、签名 Cookie 与 HTTP 特征探测测试
│   ├── credentials.test.js      # DPAPI 加密、损坏主文件自愈与多备份时间戳仲裁测试
│   ├── credentials-leak-prevention.test.js # IPC 严格子路径隔离与防逃逸测试
│   ├── dsh-home.test.js         # DSH_HOME 路径优先级与隔离测试
│   ├── kernel-compat.test.js    # 内核版本范围门禁与 Shell 防注入测试
│   ├── kernel-resolve.test.js   # 候选版本收集、优先级仲裁与非法版本拦截测试
│   ├── model-config.test.js     # 模型配置初始化、状态机替换与特殊字符转义测试
│   ├── network-shim.test.js     # 标头继承、UA 白名单保护与孤儿看门狗自毁测试
│   ├── port-acquire.test.js     # 端口可用探测与动态递增分配测试
│   ├── process-guard.test.js    # 进程指纹证据链核验与 PID 重用防杀测试
│   ├── profile-sanitize.test.js # .npmrc 增量合并与插件自愈装配测试
│   ├── syntax.test.js           # 7 大关键入口脚本独立 node --check 语法自动门禁
│   ├── updater.test.js          # 安装包哈希决策与下载安全测试
│   └── version-compare.test.js  # SemVer 语义化版本大小与预发布版本仲裁测试
├── scripts/                     # 自动化流水线
│   ├── prune-backend.mjs        # 离线微内核深层瘦身脚本
│   └── release.mjs              # Release Notes 自动生成与打包脚本
├── main.js                      # Electron 主进程 (生命周期、DPAPI 代理、原子导航、IPC 中心)
├── preload.js                   # 预加载脚本 (精雕主题引擎、模型配置中心、多模态剪贴板拦截)
├── network-shim.js              # 全局网络兼容垫片与管道断管自毁看门狗
├── package.json                 # 项目依赖配置、构建打包白名单与 npm 脚本
├── CHANGELOG.md                 # 详细版本发布与更新日志
└── README.md                    # 本主文档
```

---

## 🙏 致谢与开源鸣谢 (Acknowledgements)

**DSH Desktop** 的诞生与进化离不开以下优秀的开源项目与社区开发者的贡献：

| 开源项目 | 核心贡献与集成用途 | 仓库链接 |
| :--- | :--- | :--- |
| **DeepSeek Harness** | DeepSeek 官方出品的自主编程与智能 Agent 核心框架 | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) |
| **VS Code Escook Theme** | 彬哥出品的经典极客调色美学，为本桌面端注入专属温润视觉灵魂 | [`liulongbin1314/vscode-theme-escook`](https://github.com/liulongbin1314/vscode-theme-escook) |
| **Electron & electron-builder** | 现代化跨平台桌面应用外壳与自动化打包基础设施 | [`electron/electron`](https://github.com/electron/electron) |
| **Undici & Node.js** | 现代化高效网络栈与零外部依赖原生测试基座 | [`nodejs/node`](https://github.com/nodejs/node) |

衷心感谢各位开源作者对 DeepSeek Harness 生态建设的卓越贡献！❤️

---

## 📄 开源协议

本项目采用 [MIT License](./LICENSE) 协议开源。
