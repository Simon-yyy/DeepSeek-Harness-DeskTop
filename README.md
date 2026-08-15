# DSH Desktop (DeepSeek Harness Desktop)

<p align="center">
  <img src="./build/icon-source.svg" width="120" height="120" alt="DSH Desktop Logo" />
</p>

<p align="center">
  <b>DeepSeek Harness 官方 Web GUI 的现代化桌面客户端外壳 (Electron)</b>
</p>

<p align="center">
  <a href="#-为什么选择-dsh-desktop">核心亮点</a> •
  <a href="#-快速安装与启动">快速安装</a> •
  <a href="#-两把-api-key-完整配置指南重要">API Key 配置指南</a> •
  <a href="#-特色功能与日常使用技巧">日常使用</a> •
  <a href="#-常见问题与故障排查-faq">常见问题 FAQ</a> •
  <a href="#-从源码构建与打包">源码构建</a> •
  <a href="#-致谢与开源鸣谢-acknowledgements">致谢鸣谢</a> •
  <a href="#-开源协议">开源协议</a>
</p>

---

## 🌟 为什么选择 DSH Desktop？

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 是 DeepSeek 官方出品的强大 Agent 编程框架。默认情况下它以命令行和浏览器网页形式运行，而 **DSH Desktop** 为其封装了类似 Cursor / VS Code 的沉浸式桌面客户端体验：

- 🖥️ **原生沉浸式窗口**：告别浏览器标签页，拥有独立的 Windows 任务栏常驻、托盘集成与优雅的深浅色窗口体验。
- 🖼️ **原生图片粘贴与视觉直通 (ModLens)**：输入框支持 **Ctrl + V 直接粘贴剪贴板截图** 或 **直接拖入图片**，底层自动拦截并转换为本地临时路径，彻底消除“模型不支持图片附件”的报错。
- 🤫 **全静默后台执行**：调用终端工具与命令行时全面静默化（`windowsHide: true`），彻底告别 AI 对话过程中频繁闪烁弹出的黑色 CMD 控制台黑框。
- ⚡ **Auto 智能自主模式**：内置 `@nanmicoder/dsh-auto-mode`，常规代码读写、构建测试全自动无感流转，涉及删库或破坏性 Git 变更时智能拦截与单次确认。
- 🔄 **智能环境回退**：自动扫描环境变量 PATH、多版本管理器（NVM / FNM / Volta / Scoop / 自定义盘符）以及 NPX 缓存，免复杂配置一键唤起。
- 🎨 **经典品牌质感图标**：内置官方质感白底圆角矩形 + 经典墨黑 DeepSeek 鲸鱼品牌多尺寸图标。

---

## 🚀 快速安装与启动

### 方式 1：直接下载安装包（推荐普通用户）
1. 前往本仓库的 [Releases](../../releases) 页面；
2. 下载最新的 `DSH Desktop Setup 1.0.0.exe`；
3. 双击完成安装，桌面和开始菜单将自动生成 **【DSH Desktop】** 快捷方式；
4. 双击打开即可自动启动后台服务并进入主界面。

> 📌 **运行前置要求**：
> 电脑需安装有 **Node.js**（推荐 v20 或 v22+，任何安装目录均可，安装包会全盘自动探测）。

---

### 方式 2：从源码运行（开发者模式）
确保本地已安装 Node.js 与 Git：

```bash
# 1. 克隆本仓库
git clone https://github.com/Simon-yyy/DeepSeek-Harness-DeskTop.git
cd dsh-desktop

# 2. 安装依赖
npm install

# 3. 启动开发模式
npm start
```

---

## 🔑 两把 API Key 完整配置指南（重要）

新用户在安装启动后，需要简单配置以下 **两把 API Key** 即可解锁完整能力：

| 密钥名称 | 核心用途 | 推荐获取渠道 | 推荐配置方式 |
| :--- | :--- | :--- | :--- |
| **1. DeepSeek 主模型 Key** | 负责核心代码编写、逻辑推理、规划与终端工具执行 | [DeepSeek 开放平台](https://platform.deepseek.com/) | 首次对话弹窗自动提示，或在应用左下角【设置 ➔ 模型】填入 |
| **2. 视觉模块 (ModLens) Key** | 负责解析你粘贴或拖入的 UI 截图、架构图与报错图 | Google Gemini / 阿里百炼 (Qwen-VL) / OpenAI / 硅基流动 | 修改配置文件 `~/.modlens/config.json` 或终端一键设置 |

---

### 1️⃣ 第一步：配置 DeepSeek 主模型 API Key

#### 操作方法：
1. 打开 **DSH Desktop** 客户端；
2. **方法 A（自动弹窗）**：直接在输入框打字发送第一条消息（如输入“你好”），界面会自动弹出输入框提示你填入 Key；
3. **方法 B（手动设置）**：点击客户端左下角的 **「⚙️ 设置 (Settings)」** ➔ 点击左侧第二个菜单 **「模型」**，在 **API Key** 输入框中填入你的 `sk-xxxx` 密钥并保存。

> 🔒 **隐私与安全说明**：
> DeepSeek API Key 仅保存在你个人电脑的浏览器本地隔离存储区（LocalStorage）中，绝不会上传给任何第三方，也不会写入本软件代码中。

---

### 2️⃣ 第二步：配置视觉模块 (ModLens) API Key

由于 DeepSeek 官方模型目前专注于文本与代码逻辑推理，图像理解由内置的 **ModLens** 视觉插件提供支持。

你可以根据自己的喜好，选择以下 **任一方式** 完成配置：

#### 选项 A：通过专属配置文件设置（最直观、推荐）
在你的 Windows 个人用户目录下，找到或新建配置文件：
- **文件路径**：`C:\Users\<你的用户名>\.modlens\config.json`

用记事本打开该文件，根据你拥有的 Key 填入以下配置之一：

##### 配置示例 1：使用 Google Gemini（推荐，免费且速度极快）
```json
{
  "provider": "gemini-api",
  "providers": {
    "gemini-api": {
      "apiKey": "你的_Google_Gemini_API_Key"
    }
  }
}
```

##### 配置示例 2：使用 阿里通义千问 Qwen-VL（推荐国内用户，极速且成本低）
```json
{
  "provider": "openai",
  "providers": {
    "openai": {
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "sk-你的阿里云DashScope_Key",
      "model": "qwen3-vl-plus"
    }
  }
}
```

##### 配置示例 3：使用 OpenAI 官方或兼容网关
```json
{
  "provider": "openai",
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-你的OpenAI_Key",
      "model": "gpt-4o-mini"
    }
  }
}
```

---

#### 选项 B：在命令行中一键配置（极速）
打开 CMD 或 PowerShell，直接执行以下指令（以通义千问为例）：
```bash
# 绑定 通义千问 Qwen-VL 视觉端点
npx @liustack/modlens config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
npx @liustack/modlens config set openai.apiKey sk-你的密钥
npx @liustack/modlens config set openai.model qwen3-vl-plus

# 运行自检，确认视觉通道是否就绪
npx @liustack/modlens doctor
```

---

#### 选项 C：环境变量自动识别（免配置）
只要你的 Windows 系统环境变量中配置了以下任意一项，ModLens 会**自动读取生效**：
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

---

---

## 🏠 离线与私有化大模型接入 (Ollama / vLLM / LM Studio)

对于企业内网、数据合规或无网络环境，**DSH Desktop** 原生支持一键直连本地或局域网私有化模型服务，实现 **100% 纯离线安全编程**：

### 1. 接入本地 Ollama
确保本地已安装 [Ollama](https://ollama.com/) 并拉取模型（如 `ollama run deepseek-r1:14b` 或 `ollama run qwen2.5-coder:32b`）：

1. 打开 DSH Desktop 左下角 **「⚙️ 设置」➔「模型」**；
2. **Base URL** 填写：`http://127.0.0.1:11434/v1`；
3. **API Key** 填写任意字符（如 `ollama`）；
4. **Model** 填写本地运行的模型名（如 `deepseek-r1:14b` 或 `qwen2.5-coder:32b`）。

### 2. 接入 vLLM / LM Studio / 局域网服务
1. 启动本地 vLLM 或 LM Studio 的 Local Server（默认监听 `http://127.0.0.1:1234/v1` 或 `http://127.0.0.1:8000/v1`）；
2. 在 DSH Desktop 设置中直接将 Base URL 指向对应端口即可，无任何遥测与外部网络外发！

---

## 💡 特色功能与日常使用技巧

### 1. 截图与设计图解析使用方式
- 在主界面右下角模型选择菜单中，选择带有 **`(modlens vision)`** 后缀的包装模型（如 `DeepSeek-V4-Flash (modlens vision)`）；
- 随时在对话框中 **Ctrl + V 粘贴截图**，或者直接从桌面把图片拖入输入框，客户端会自动解析图像中的 OCR 文字、版面结构与视觉语义，并辅助生成代码！

### 2. Auto 智能自主模式
- 在输入框下方的权限模式下拉框中，选择 **`Auto`** 模式；
- 常规的文件读取、代码编辑、编译测试、单测执行将**全自动执行无打扰**；
- 遇到高危文件删除或敏感 Git 命令时会自动拦截并请求单次确认，兼顾效率与安全。

### 3. 会话管理与重命名
- 点击左上角 **「⊕ 新会话」** 可开启纯净新对话；
- 鼠标悬停在左侧历史会话列表上，可点击 **✏️（重命名）** 或 **🗑️（删除）** 轻松管理历史记录。

---

## ❓ 常见问题与故障排查 (FAQ)

#### Q1：启动时弹出“无法在 90s 内启动 dsh web 后端”怎么办？
- **原因**：电脑未安装 Node.js，或者首次使用时由于网络波动拉取 `@deepseek-ai/dsh` 超时。
- **解决办法**：
  1. 确保电脑已安装 [Node.js](https://nodejs.org/)（推荐 LTS 版本）；
  2. 在终端手动运行一次 `npx -y @deepseek-ai/dsh web` 预热缓存后再打开客户端。

#### Q2：克隆代码或调用网络工具时提示 DNS 超时或网络失败？
- **原因**：本地开启了某些 VPN 代理导致本地回环或 DNS 拦截。
- **解决办法**：检查系统代理设置，确保 `127.0.0.1` 在不代理的白名单中，或临时切换 VPN 模式为规则分流。

#### Q3：我的 API Key 会被其他人看到吗？
- **答**：**绝对不会**。本客户端为纯外壳架构，所有 API Key 均独立保存在用户本机的 `~/.dsh/` 与 `~/.modlens/` 目录中，代码中不含任何硬编码密钥。

---

## 🛠️ 从源码构建与打包

如果你想对客户端进行二次开发或自己打包 Windows 安装包：

```bash
# 1. 生成高分辨率应用图标
npm run build:icon

# 2. 打包生成 Windows 安装包（输出到 release/ 目录）
npm run dist

# 3. 自动化版本发布与归档（自动更新版本号、哈希校验码与更新日志）
npm run release:patch   # 发布补丁版本 (1.0.0 -> 1.0.1)
npm run release:minor   # 发布次版本 (1.0.0 -> 1.1.0)
npm run release:major   # 发布主版本 (1.0.0 -> 2.0.0)
```

---

## 📂 项目结构说明

```text
dsh-desktop/
├── build/                # 应用构建资源
│   ├── icon-source.svg   # 官方矢量图标源文件
│   └── icon.ico          # 多分辨率 Windows 图标 (.ico)
├── scripts/              # 自动化构建脚本
│   └── release.mjs       # 自动化发布流水线与 Release Notes 生成器
├── main.js               # Electron 主进程 (生命周期、跨平台路径探测、安全拦截)
├── preload.js            # 预加载脚本 (剪贴板图片拦截与临时文件回填)
├── afterPack.js          # 打包后钩子 (注入高清晰度应用图标)
├── make-icon.mjs         # 鲸鱼图标多尺寸渲染生成工具
├── package.json          # 项目元数据与打包配置
├── CHANGELOG.md          # 版本更新历史记录
├── LICENSE               # MIT 开源授权协议
└── README.md             # 完整中英文项目说明文档
```

---

---

## 🙏 致谢与开源鸣谢 (Acknowledgements)

**DSH Desktop** 的诞生与生态体验离不开以下优秀的开源项目与社区开发者的贡献：

| 开源项目 | 核心贡献与集成用途 | 仓库链接 |
| :--- | :--- | :--- |
| **DeepSeek Harness** | DeepSeek 官方出品的自主编程与智能 Agent 核心框架 | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) |
| **ModLens** | 为纯文本/代码模型打造的多模态视觉解析桥梁，赋能截图直通与图生代码 | [`liustack/modlens`](https://github.com/liustack/modlens) |
| **dsh-auto-mode** | 提供无需频繁确认且具备高危拦截能力的 Auto 智能自主模式 | [`NanmiCoder/dsh-auto-mode`](https://github.com/NanmiCoder/dsh-auto-mode) |
| **dshmarket** | DeepSeek Harness 可视化生态插件市场与发现中心 | [`dshmarket`](https://github.com/dshmarket) |
| **Matt Pocock Skills** | 工业级 AI Agent 编程技能库（覆盖 TDD、Code Review、架构建模等） | [`mattpocock/skills`](https://github.com/mattpocock) |
| **Electron & electron-builder** | 现代化跨平台桌面应用外壳与自动化打包基础设施 | [`electron/electron`](https://github.com/electron/electron) |

衷心感谢各位开源作者对 DeepSeek Harness 生态建设的卓越贡献！❤️

---

## 📄 开源协议

本项目采用 [MIT License](./LICENSE) 协议开源。
