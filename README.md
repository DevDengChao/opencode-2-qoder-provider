# opencode-qoder-provider

[![CI](https://github.com/wcmk21/opencode-qoder-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/wcmk21/opencode-qoder-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

基于 `@qoder-ai/qoder-agent-sdk` 的 [OpenCode](https://opencode.ai) Qoder Provider 插件。

把 Qoder 官方 CLI（qodercli）当作**无状态的语言模型后端**接入 opencode：
opencode 保留完整的 agent 循环与工具执行权，qodercli 只负责推理。

## 前提条件

1. **Qoder 账号与 PAT**：本插件通过 Qoder Personal Access Token（PAT，`pt-` 开头）认证。
   创建方式：登录 Qoder → 打开 Account → Integrations → 选择有效期与所需权限并创建 PAT，
   生成后立即复制（官方文档：[SDK Authentication](https://docs.qoder.com/cli/sdk/authentication)）
2. **OpenCode**：建议使用较新版本（本插件依赖 opencode 的 plugin `config` hook 注入模型目录）
3. **网络**：首次启动需要访问 Qoder 服务端获取模型目录；完全离线时仅有静态兜底模型可用

## 特性

- **声明型 MCP 工具桥接**：opencode 的工具 schema 通过 SDK 的 `createSdkMcpServer` 声明给模型，
  模型能"看到"工具并发出 tool_use，但 qodercli 侧永不执行（`canUseTool` 永远 deny），
  tool_use 流事件转回 opencode 执行
- **JSON transcript 回放**：多轮历史（含 tool_use / tool_result）序列化为 JSON 嵌入单条
  user message，跨进程传递上下文，并明确标注"非指令"以防 prompt injection
- **无状态单轮**：每次请求独立进程，`maxTurns: 1` + `persistSession: false`，
  多轮上下文由 opencode 管理
- **双区支持**：Global / CN 区域与各自的模型目录
- **动态模型目录自动注入**：插件 config hook 在启动时把模型目录（HTTP API + 静态 fallback）
  注入 opencode 配置，模型选择器**无需手动声明任何模型**

## 架构

```
opencode TUI
  │
  │  LanguageModelV3 接口
  ↓
┌──────────────────────────────────────────────┐
│  opencode-qoder-provider                     │
│  ┌────────────────────────────────────────┐  │
│  │  QoderLanguageModel (model.ts)         │  │
│  │  - doStream() / doGenerate()           │  │
│  │  - 工具边界立即终止进程               │  │
│  └──────────────┬─────────────────────────┘  │
│                 │                              │
│  ┌──────────────▼─────────────────────────┐  │
│  │  context.ts   tool-bridge.ts           │  │
│  │  历史 → JSON transcript  opencode 工具 │  │
│  │  回放 + transport notice  → 声明型 MCP │  │
│  └──────────────┬─────────────────────────┘  │
│                 │                              │
│  ┌──────────────▼─────────────────────────┐  │
│  │  mapper.ts                             │  │
│  │  SDKMessage → LanguageModelV3StreamPart│  │
│  │  (stream_event 6 变体 + result)        │  │
│  └──────────────┬─────────────────────────┘  │
│                 │                              │
│  ┌──────────────▼─────────────────────────┐  │
│  │  @qoder-ai/qoder-agent-sdk             │  │
│  │  ProcessTransport（Bun 兼容）          │  │
│  │  认证、COSY、WAF、进程管理由 SDK 处理 │  │
│  └──────────────┬─────────────────────────┘  │
└─────────────────┼────────────────────────────┘
                  │ JSONL over stdin/stdout
                  ↓
            qodercli（无状态推理）
                  ↓
            Qoder Backend
```

**关键设计决策**：

- LLM 交互全部通过 SDK `query()` 完成，不直接调用 HTTP API（仅模型目录获取使用 HTTP）
- 工具边界（`stop_reason = tool_use`）一到立即终止 qodercli 进程，防止 `canUseTool` 的
  deny 结果触发 qodercli 内部 agent loop 的第二轮模型调用
- opencode 是唯一的工具执行者；qodercli 原生工具/技能/插件/用户设置全部禁用

## 安装

本插件**不经 npm 分发**，构建产物（dist/）直接提交在本仓库中。两种接入方式按
稳定性排序：**方式一（本地路径）完全绕开 opencode 内置安装器与网络安装环节，
最稳，首选**；**方式二（Git 直装）免 clone 免构建，但首次使用前必须手动预热**
（原因与命令见下）。

### 方式一：本地构建 + file:// 引用（推荐）

```bash
git clone https://github.com/wcmk21/opencode-qoder-provider.git
cd opencode-qoder-provider
npm install && npm run build   # 构建产物在 dist/
```

在 opencode.json 中（项目级，或全局 `~/.config/opencode/opencode.json` 对所有项目
生效）用 `file://` 指向构建产物。**注意两点**：`provider.npm` 指向 `dist/index.js`；
`plugin` 数组直接指向 `dist/plugin.js` 文件（Windows 路径用正斜杠即可）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "qoder": {
      "npm": "file://C:/path/to/opencode-qoder-provider/dist/index.js",
      "name": "Qoder",
      "options": { "region": "global" }
    }
  },
  "plugin": ["C:/path/to/opencode-qoder-provider/dist/plugin.js"]
}
```

- 修改源码重新 build 后若行为未变化，需清理 opencode 的包缓存（见
  [包缓存位置](#包缓存位置)）并重启 opencode，避免加载到旧版本
- `plugin` 部分可以改用**插件目录自动发现**替代：把 `dist/plugin.js` 放入全局
  插件目录 `~/.config/opencode/plugins/`（目录不存在则创建），或项目级
  `.opencode/plugins/`，该目录下的文件启动时自动加载，无需 `plugin` 字段

### 方式二：Git 直装 + 手动预热

在 opencode.json 中（项目级，或全局 `~/.config/opencode/opencode.json`）直接使用
git 规格，构建产物已提交在仓库中，无需 clone 或本地构建：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "qoder": {
      "npm": "github:wcmk21/opencode-qoder-provider",
      "name": "Qoder",
      "options": { "region": "global" }
    }
  },
  "plugin": ["github:wcmk21/opencode-qoder-provider"]
}
```

- 规格统一使用 `github:` 简写（`git+https://` 完整形式与之等价）；建议在仓库打
  版本 tag 后锁定，如 `github:wcmk21/opencode-qoder-provider#v0.1.2`，此时预热
  命令中的规格需与 opencode.json 完全一致

**首次使用前必须手动预热**。opencode 用内置安装器（@npmcli/arborist）自动安装
`provider.npm` 与 `plugin` 字段的依赖，在网络环境不佳（尤其依赖经镜像源）时，可能
在"包本体落盘"环节静默挂起——症状是包缓存目录里依赖树已生成，但
`node_modules/opencode-qoder-provider` 本体缺失，全程无任何报错，`/models` 中不
出现 Qoder（opencode 对安装失败不写文件日志，错误仅发往会话事件流，所以完全静默）。
用系统 npm 把包预先装进 opencode 的包缓存目录（目录名由规格 sanitize 而来，见
[包缓存位置](#包缓存位置)），opencode 启动时即可离线复用，不再联网安装：

```powershell
# Windows PowerShell（规格需与 opencode.json 中所写完全一致）
npm install "github:wcmk21/opencode-qoder-provider" --prefix "$env:USERPROFILE\.cache\opencode\packages\github_wcmk21\opencode-qoder-provider"
```

```bash
# Linux / macOS（缓存子目录名原样保留冒号，与 Windows 的 github_wcmk21 不同）
npm install "github:wcmk21/opencode-qoder-provider" --prefix "$HOME/.cache/opencode/packages/github:wcmk21/opencode-qoder-provider"
```

预热完成后启动 opencode，`/models` 中应出现 Qoder 分组。

### 包缓存位置

opencode 把 `provider.npm` / `plugin` 字段的安装结果缓存在固定目录，预热、清理
旧版本、排查"模型不出现"都要用到：

- Windows：`%USERPROFILE%\.cache\opencode\packages\`
- Linux / macOS：`~/.cache/opencode/packages/`

子目录名由 opencode.json 所写规格字符串 sanitize 而来（Windows 把 `:` 等非法字符
换 `_`、`/` 成子路径；Linux/macOS 不做替换、原样保留）。以
`github:wcmk21/opencode-qoder-provider` 为例：

- Windows：`packages\github_wcmk21\opencode-qoder-provider`
- Linux / macOS：`packages/github:wcmk21/opencode-qoder-provider`

若规格带版本 tag（如 `#v0.1.2`），tag 会原样进入目录名（`#` 无需转义），预热命令
的 `--prefix` 需相应调整。

## 配置

### 1. 设置 PAT

```bash
# macOS / Linux —— Global 区域
export QODER_PERSONAL_ACCESS_TOKEN=pt-your-token-here

# CN 区域（CN 区优先读取；未设置时回退到 QODER_PERSONAL_ACCESS_TOKEN）
export QODERCN_PERSONAL_ACCESS_TOKEN=pt-your-cn-token-here
```

```powershell
# Windows PowerShell（仅当前会话生效）
$env:QODER_PERSONAL_ACCESS_TOKEN = "pt-your-token-here"

# 持久化到当前用户（重开终端后生效）
[Environment]::SetEnvironmentVariable("QODER_PERSONAL_ACCESS_TOKEN", "pt-your-token-here", "User")
```

也可以不设环境变量，直接在 opencode.json 的 provider `options` 中传入
（注意 PAT 明文会留在配置文件中，不要把该文件提交到版本库）：

```jsonc
"options": { "region": "global", "apiKey": "pt-your-token-here" }
```

### 2. opencode.json

完整示例见 [opencode.json.example](./opencode.json.example)。最小配置（接入方式
见上文"安装"）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "qoder": {
      "name": "Qoder",
      "npm": "file://C:/path/to/opencode-qoder-provider/dist/index.js",
      "options": { "region": "global" }
    }
  },
  "plugin": ["C:/path/to/opencode-qoder-provider/dist/plugin.js"]
}
```

> **重要**：`plugin` 字段是必需的。opencode 的模型列表只来自 config 中
> `provider.models` 的声明，provider 包内部返回的模型目录不会被读取；
> 本包通过插件的 config hook 在启动时把动态目录（HTTP API + 静态 fallback，
> 含 1 小时缓存）自动写入 `provider.models`。
>
> **为什么需要 `provider` 和 `plugin` 两处配置？** opencode 中这是两个独立机制：
> `provider.npm` 声明的是**模型后端**（实现 LanguageModelV3 接口，负责"怎么跟
> Qoder 对话"——prompt 组装、调用 qodercli、流式响应映射）；`plugin` 声明的是
> **宿主钩子**（负责在启动时把动态模型目录注入 opencode 的模型列表）。两者
> 加载的是同一个包的两个入口：`dist/index.js` 与 `dist/plugin.js`。
>
> 手动声明是可选的：若在 opencode.json 中写了 `models`，其中字段
> （如自定义 `name`）会覆盖注入的默认值，未声明的模型仍会自动出现：
>
> ```jsonc
> "models": { "auto": { "name": "自定义显示名" } }
> ```
>
> **注意**：手动声明的模型 ID 若不在目录中，会以仅含 `name` 的精简声明出现
> （缺少上下文窗口等元数据），建议仅覆盖目录中已有的模型 ID。

**设为默认模型**：在 opencode.json 顶层加 `"model"`（格式 `provider/模型ID`），
新会话将直接使用 Qoder，无需每次 /models 切换：

```jsonc
{ "model": "qoder/auto" }
```

**双区域并存**：Global 与 CN 可以同时配置为两个 provider，模型选择器中
会出现 `Qoder` 与 `Qoder CN` 两组模型，完整写法见
[opencode.json.example](./opencode.json.example)。

### 3. 环境变量参考

| 变量 | 说明 |
|------|------|
| `QODER_PERSONAL_ACCESS_TOKEN` | Global 区域 PAT（必需，或由 provider options 提供） |
| `QODERCN_PERSONAL_ACCESS_TOKEN` | CN 区域 PAT（CN 区优先读取） |
| `QODER_REGION` | 默认区域：`global`（默认）/ `cn` |
| `QODER_DEBUG` | 设为 `1` 启用 debug 级日志（见下文"日志"） |
| `QODER_CLI_PATH` | 显式指定 qodercli.js 路径（一般无需设置，插件自带 CLI） |
| `QODER_PAT` | `QODER_PERSONAL_ACCESS_TOKEN` 的别名（仅模型调用侧读取，不影响模型目录注入；推荐统一使用前者） |

### 4. 使用

```bash
opencode
```

启动后 `/models` 中应出现 `Qoder`（及 `Qoder CN`）分组——分组内即动态目录
注入的全部模型，选中即用。

- **切换模型**：TUI 中 `/models` 选择，或 `/models qoder` 快速过滤
- **默认模型**：通过顶层 `"model"` 配置固定（见上文）
- **图片输入**：仅声明支持 `image` 的模型可贴图（动态目录中服务端标记
  `is_vl` 的模型，以及静态兜底中的 Global `auto`）；其余模型中图片会被
  降级为占位文本，不会报错
- **验证生效**：日志中出现 `injected N models into provider ...` 即说明
  模型目录注入成功（见下文"日志"与"故障排查"）

## OpenCode V2（2.x）接入

opencode 2.x 更换了 provider 与插件契约，本包为此提供**V2 插件包 `plugin-v2/`**
（入口 `plugin-v2/index.js`）。旧的 `dist/plugin.js` 在 V2 会被加载器直接拒载：
`Plugin must export a default definition with an id and an effect or setup function`。
provider 本体 `dist/index.js` 两个大版本通用，无需改动。

> **V2 的 `plugins` 路径必须指向"目录包"**（该目录内要有 `package.json`）。写成
> `…/dist/plugin-v2.js` 这类**文件**路径会被拒：
> `WARN message="configured plugin path must be a directory"` —— 这是接入 V2 时最
> 容易踩的坑，因此本包把 V2 入口做成独立目录 `plugin-v2/`（自带 package.json）。

| 项 | V1（1.x） | V2（2.x） |
|----|-----------|-----------|
| provider 声明 | `provider.<id>.npm` | `providers.<id>.package`，值需带 `aisdk:` 前缀 |
| provider 参数 | `options` | `settings` |
| 插件声明 | `plugin`（字符串数组） | `plugins`（字符串/对象数组） |
| 插件入口 | `dist/plugin.js`（config hook） | `plugin-v2/` 目录（`ctx.catalog.transform`） |
| 模型注入方式 | 写 `config.provider[].models` | `draft.model.update(providerID, modelID, fn)` |

```jsonc
{
  "providers": {
    "qoder-cn": {
      "name": "Qoder CN",
      "package": "aisdk:file:///abs/path/to/opencode-2-qoder-provider/dist/index.js",
      "settings": { "region": "cn" },
      // 只需一个锚点模型；其余模型由插件在启动时注入，无需手写
      "models": { "auto": { "name": "Auto · Qoder CN" } }
    }
  },
  // 目录包规格：<名称>@file:<plugin-v2 目录的绝对路径>
  "plugins": ["opencode-qoder-provider-v2@file:/abs/path/to/opencode-2-qoder-provider/plugin-v2"]
}
```

可直接复制的最小示例见 [opencode-v2.json.example](./opencode-v2.json.example)。

- **PAT**：环境变量名与 V1 相同（CN 用 `QODERCN_PERSONAL_ACCESS_TOKEN`），也可写在
  `providers.<id>.settings.apiKey`（明文入库需谨慎）。注意 provider 代码运行在
  **opencode 服务端进程**内：以 systemd 部署时用 `EnvironmentFile=` / `Environment=`
  把 PAT 注入服务环境，写在 shell profile 里对已启动的服务无效，须重启服务。
- **插件选项**（对象形式，可选）：
  `{"package": "…/plugin-v2", "options": {"providerID": "qoder-cn", "region": "cn"}}`。
  `providerID` 显式指定目标 provider，用于"插件加载早于 provider 注册"的顺序场景；
  不填时按 provider 的 `api.package` 自动识别（含 `qoder` 即命中）。
- **锚点与覆盖**：config 中声明的模型 ID 若与目录同名，以 config 声明为准（V1 是
  config 覆盖插件；V2 由 catalog 合并，建议锚点只保留 `name` 之类的显示字段）。
- **校验**：`opencode models | grep -c '^qoder-cn/'` 应远大于 1（V2 目录当前 14 个）；
  日志 `~/.local/state/opencode/qoder-provider.log` 出现
  `[qoder-v2] injected N models into provider "qoder-cn" (region=cn)`。
- **排障**：
  - 日志出现 `configured plugin path must be a directory` → `plugins` 写成了文件
    路径，改成 `…/plugin-v2` 目录规格（见上）。
  - `/models` 里没有 Qoder → 用 `opencode debug config` 确认 `plugins` 条目已被读到。
  - 只有一个锚点模型 → 插件未加载或未取到目录：确认服务进程环境里有 PAT
    （`tr '\0' '\n' < /proc/<server-pid>/environ | grep QODERCN_`）、
    缓存文件 `~/.opencode/qoder-cn-models.json` 是否生成。
  - 改动插件或 provider 配置后需要重启 opencode 服务（配置热重载不会重新加载
    provider 包）。

## 可用模型

模型列表以**动态目录**为准（HTTP API 获取，每小时刷新，由插件 config hook 在启动时
自动注入，无需手动声明）；服务端上线新模型后自动出现。下表仅为网络不可用时的
静态兜底，只保留 Qoder 官方路由模型；第三方模型（Qwen / Kimi / GLM / DeepSeek /
MiniMax / Cantus 等）迭代频繁，不进入静态表，由动态目录提供。

### Global（静态兜底）

| 模型 ID | 名称 | 推理 | 上下文 |
|---------|------|:----:|-------:|
| `auto` | Auto | ✅ | 180K |
| `ultimate` | Ultimate | ✅ | 1M |
| `performance` | Performance | ✅ | 1M |
| `efficient` | Efficient | ❌ | 180K |
| `lite` | Lite | ❌ | 180K |

### CN（静态兜底）

| 模型 ID | 名称 | 推理 | 上下文 |
|---------|------|:----:|-------:|
| `auto` | Auto · Qoder CN | ✅ | 180K |

获取失败时自动使用上表静态列表；也可在 opencode.json 中手动声明以覆盖个别字段
（如自定义显示名）。

## 日志

- 位置：`~/.local/state/opencode/qoder-provider.log`（Windows：`%USERPROFILE%\.local\state\opencode\qoder-provider.log`）
- 默认记录 INFO / ERROR 级别（`logInfo` / `logError`），**不会污染 TUI 渲染**
- 设置 `QODER_DEBUG=1` 后追加 DEBUG 级日志。**注意**：DEBUG 日志包含发往模型的
  prompt 片段（截断至 300 字符），可能含敏感代码/对话内容，排查后请关闭

## 故障排查

| 现象 | 排查步骤 |
|------|----------|
| `/models` 中没有 Qoder 分组 | 1）确认 opencode.json 同时配置了 `provider` 与 `plugin` 字段（两者缺一不可）；2）查看日志中是否有 `[qoder-plugin] injected N models`；3）PAT 未设置时仅会出现静态兜底模型（5 个官方路由模型），而不是完整目录 |
| Git 直装后 `/models` 无 Qoder 且日志无 `injected`（配置确认无误） | opencode 自动安装 git 依赖可能在"包本体落盘"环节静默挂起（网络不佳时，依赖树已落盘但本体缺失，全程无报错——安装错误仅发往会话事件流，不写日志）。按[方式二](#方式二git-直装--手动预热)的预热命令把包手动装进包缓存后重启：Windows `npm install "github:wcmk21/opencode-qoder-provider" --prefix "$env:USERPROFILE\.cache\opencode\packages\github_wcmk21\opencode-qoder-provider"`，Linux/macOS 目录名保留冒号（见[包缓存位置](#包缓存位置)）；或改用[方式一](#方式一本地构建--file-引用推荐)的本地路径 |
| 模型列表比预期少 | 模型目录来自 HTTP API（1 小时缓存）。看日志是否有 403 / 网络错误；删除模型缓存 `~/.opencode/qoder-models.json`（CN 为 `qoder-cn-models.json`）后重启强制刷新 |
| 调用报 `Set QODER_PERSONAL_ACCESS_TOKEN` | PAT 未传到模型调用层：确认环境变量名拼写（CN 区需 `QODERCN_PERSONAL_ACCESS_TOKEN`），或改用 `options.apiKey`；Windows 下 `$env:` 设置仅在当前会话生效 |
| 修改配置 / 重新构建后不生效 | 清理 opencode 包缓存 `~/.cache/opencode/packages/` 与模型目录缓存 `~/.opencode/qoder-*.json`，重启 opencode（opencode 启动时缓存旧插件与目录） |
| 响应异常 / 请求失败 | 设置 `QODER_DEBUG=1` 重启复现，提取日志中 ERROR / DEBUG 段提 issue（注意脱敏，DEBUG 含 prompt 片段） |

## 项目结构

```
src/
├── index.ts        # Provider 工厂入口（opencode package 加载点）
├── model.ts        # LanguageModelV3 实现（核心：SDK query() 调用 + 工具边界终止）
├── mapper.ts       # SDKMessage → LanguageModelV3StreamPart 映射器（含工具名回映射）
├── context.ts      # Prompt → JSON transcript 回放 + transport notice
├── tool-bridge.ts  # 声明型 MCP 工具桥接（opencode 工具 → qodercli 可见不可执行）
├── models.ts       # 模型目录管理（HTTP API + 静态 fallback + 缓存）
├── catalog-loader.ts # 目录加载共享逻辑（PAT 解析/超时/包名识别，两个插件入口共用）
├── cli-path.ts     # qodercli.js 路径解析（Windows file:// URL 兼容）
├── logger.ts       # 文件日志（避免污染 TUI）
├── plugin.ts       # opencode V1 Plugin 入口（config hook 注入模型目录 / 事件处理）
├── plugin-v2.ts    # opencode V2 Plugin 入口源码（catalog.transform 注入模型目录）
└── ../plugin-v2/   # V2 插件包目录（package.json + index.js 构建产物；V2 要求 plugins 指向目录）
```

## 已知限制

1. **图片输入部分支持**：最新 user 消息中的图片会以 Anthropic 风格 image block
   经 qodercli wire 协议透传给模型（实测 qodercli 1.1.31，global auto 与动态
   目录中服务端标记 `is_vl` 的模型声明 `image` 输入；CN 区域未实测暂保持
   text-only）。其余场景仍降级为 `[file: mediaType]` 占位符：历史消息中的
   图片（回放 JSON 保持纯文本）、工具结果中的图片（如 Read 读图）、以及
   非图片文件
2. **token 统计为估算值，$ spent 实为 Credits**：qodercli 不上报真实 token
   计数（实测 `input_tokens`/`output_tokens`/`cache_*` 恒为 0，仅
   `context_usage_ratio` 与 `credits` 有效）。本包用 ratio × 模型上下文窗口
   估算输入 token、生成字符数 ÷ 4 粗估输出 token；而 TUI 侧边栏的
   "$ spent" 显示的是 Qoder 服务端真实计量的 **Credits 数值**（经
   providerMetadata 直通 opencode 的 cost 通路，非美元）——Credits 到
   美元的换算随套餐不同（如 Teams 40 USD/席位/3000 Credits ≈
   0.0133 USD/Credit），仅供相对消耗参考
3. **每请求冷启动**：无状态设计意味着每次请求都 spawn 一个新的 qodercli 进程，
   首包延迟高于常驻连接
4. **Bun 运行时**：opencode 是 Bun 编译二进制，SDK 默认 WorkerTransport 不兼容，
   本包强制使用 ProcessTransport 运行 `@qoder-ai/qodercli` 自带的 JS 版 CLI

## 开发

```bash
npm install        # 安装依赖
npm run check      # TypeScript 类型检查
npm run build      # 构建 dist/（esbuild bundle + tsc 声明文件）
npm test           # 运行单元测试（vitest，无需网络/PAT）
node test-bridge.mjs  # 端到端测试（需要真实 PAT 与网络）
```

## License

MIT — 见 [LICENSE](./LICENSE)

## 参考

- [marcomishi-dot/pi-qoder-provider](https://github.com/marcomishi-dot/pi-qoder-provider) — 声明型 MCP 工具桥接与 JSON transcript 回放方案
- [simonsmh/pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder) — 模型目录 HTTP API
