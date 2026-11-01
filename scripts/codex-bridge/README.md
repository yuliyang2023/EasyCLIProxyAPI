# Codex App Server HTTP bridge

独立的 OpenAI 兼容文本 API 服务，直接通过 Codex App Server 的 stdio JSON-RPC 协议使用本机 Codex，不需要 ACP 或 `codex-acp`。

```text
iTerm2 / 其他 OpenAI 客户端 → CPA（可选）→ HTTP bridge → codex app-server → OpenAI
```

## 启动

### 桌面应用

在侧边栏“Codex 桥接”或“API 接入”页面，启用服务、生成或填写桥接 API Key，然后点击“保存并应用”。可配置端口、本机 Node/Codex 可执行文件的绝对路径、独立 Codex 配置目录；也可选择“随桌面应用启动”。默认禁用，不会自动安装依赖或执行 Codex 登录。退出桌面应用会关闭服务及其子进程。

运行脚本直接嵌入桌面二进制，DMG/便携包不需要源码目录。仍需要本机 Node.js 22+ 和可用的 Codex 登录。若 8320 已被手动启动的服务占用，先停止该服务，或在桌面中选择其他端口。

点击“接入 CPA”可创建/更新 `codex-desktop-bridge` OpenAI 兼容 Provider，默认模型别名 `codex-local`。服务 API Key 修改后会同步已有的托管 Provider；CPA 未启动时可稍后再次同步。现有其他 Provider 和自定义模型映射会保留。

### 使用记录

桌面托管服务将直连请求的脱敏元数据写入持久化 inbox，由桌面导入现有 SQLite 使用数据库。供应商为 `Codex Bridge`，可按模型/API Key 筛选，查看请求数、token、耗时和成功/失败；稳定请求 ID 防止重放重复计数。不会记录提示词、回复或 API Key 原文。

由“接入 CPA”创建的 Provider 带有专用路由标记，这些请求只使用 CPA 自身记录，避免统计两次。自行手动添加的 CPA Provider 需要保留同样的路由标记，或使用“接入 CPA”管理。

### 源码独立运行

需要 Node.js 22+、已安装的 Codex CLI，以及可用的 Codex 登录。无需安装额外 npm 依赖。

```sh
npm run codex:bridge
```

默认监听 `http://127.0.0.1:8320`。在 API 客户端中使用：

- Base URL：`http://127.0.0.1:8320/v1`
- 模型：`codex`（沿用 Codex 默认模型），或者 `/v1/models` 返回的实际模型名。
- 协议：Chat Completions 或 Responses。
- 若客户端填写的是完整端点，使用 `/v1/chat/completions` 或 `/v1/responses`。

iTerm2 AI Chat 请使用 Chat Completions 协议，填完整端点 `http://127.0.0.1:8320/v1/chat/completions`。可以启用 function calling，终端工具由 iTerm2 执行，桥接只转发调用和结果。图片及文件上传暂不支持。

桥接兼容 iTerm2 固定发送的 `max_tokens` 和 `temperature=0`，也接受 `max_completion_tokens`、Responses 的 `max_output_tokens` 及 `top_p`。当前 Codex App Server 没有这些参数的对应控制项，因此它们仅通过类型和范围校验，**不透传、不保证输出 token 上限或采样行为**。响应头 `X-Codex-Bridge-Ignored-Parameters` 列出实际未应用的参数；例如 `max_tokens, temperature`。需要严格 token 上限的调用方应使用支持该参数的模型 API。

独立脚本不会自动启动 CPA，也不修改现有 Codex 配置或 CPA 配置。默认沿用当前用户的 Codex 登录和配置，但进程及线程都明确选择 `openai` provider，避免默认 provider 已指向 CPA 时形成循环。

**建议使用独立的 Codex 配置目录**，避免继承现有工作环境的自定义 provider、插件、MCP 和其他配置：

```sh
CODEX_HOME="$HOME/.codex-cpa-bridge" codex login
CODEX_BRIDGE_CODEX_HOME="$HOME/.codex-cpa-bridge" npm run codex:bridge
```

桥接不读取或复制登录凭据；由 Codex 自己读取其登录状态。若必须使用已有配置，请确认其中名为 `openai` 的 provider 没有被自定义为 CPA 的地址。

## 接入 EasyCLIProxyAPI

启动 CPA 内核和桥接服务后，在“API 接入”中添加 **OpenAI 兼容 Provider**：

| 字段 | 值 |
| --- | --- |
| 名称 | `codex-app-server` |
| Base URL | `http://127.0.0.1:8320/v1` |
| API Key | 设置了 `CODEX_BRIDGE_API_KEY` 时填相同值；仅本机无认证模式可用任意占位值 |
| 上游模型 | `codex` 或 `/v1/models` 返回的实际模型名 |
| 模型别名 | 建议用 `codex-local`，以区分已有 Codex API/OAuth 路由 |

调用方继续使用 CPA 的统一地址和 CPA 的 API Key，模型选 `codex-local`。CPA 到桥接服务和调用方到 CPA 是两段独立认证。

若 CPA 在容器里，`127.0.0.1` 指向容器本身。需要使用容器可达的宿主机地址；桥接绑定非回环地址时必须配置 `CODEX_BRIDGE_API_KEY`。

## API 示例

```sh
curl http://127.0.0.1:8320/v1/models

curl http://127.0.0.1:8320/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex","messages":[{"role":"user","content":"用一句话介绍自己"}],"stream":true,"stream_options":{"include_usage":true}}'

curl http://127.0.0.1:8320/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex","input":"用一句话介绍自己","store":false}'
```

启用桥接认证后，所有 `/v1/*` 请求还需提供 `Authorization: Bearer <桥接密钥>`。

## 支持范围

- `GET /healthz`：进程存活、当前请求数及等待工具结果的会话数 `pending_tools`；不检测登录或模型连通性，不需要认证。
- `GET /v1/models`：通过 `model/list` 分页发现模型，并提供 `codex` 默认模型别名。模型目录不等于账号一定具有每个模型的调用权限。
- `POST /v1/chat/completions`：普通 JSON / SSE、文本多轮历史、`reasoning_effort`、`response_format.type=json_schema`、可选 usage 尾帧，以及调用方定义的 function tools。
- `POST /v1/responses`：文本 `input` 或文本 message 数组、`instructions`、`reasoning.effort`、`text.format.type=json_schema`、普通 JSON / SSE。
- 每个新对话请求创建独立的 App Server 进程、临时工作目录和 ephemeral thread。历史通过 `thread/inject_items` 注入，最后一条 user 消息通过 `turn/start` 提交；system/developer 消息须在历史开头，合并为线程的 developer instructions。工具结果回传会复用悬挂的进程、线程和回合。
- 超时或客户端断连时尝试 `turn/interrupt`，并终止 App Server 进程树。服务退出时清理活动请求。
- 不返回 Codex 的 commentary、推理内容或原始 stderr。usage 仅转换 App Server 报告的实际计数，不估算；工具结果回传按增量报告，避免重复累计。未报告时普通 Chat 响应省略 usage，Responses 使用 `null`。

### Function tools（Chat Completions）

客户端传入标准 `tools: [{type: "function", function: {name, description, parameters}}]`，`tool_choice` 支持 `auto`（默认）或 `none`。桥接通过 App Server 的 experimental dynamic tools 暴露这些工具；内部使用独立名称避免与 Codex 内置工具重名，对外仍返回调用方的原始工具名。

Codex 调用工具时，HTTP 返回 `finish_reason: "tool_calls"` 和标准 `message.tool_calls`，流式模式返回对应的 delta。桥接不会执行工具。iTerm2/调用方执行后，保留原对话和 assistant 的 `tool_calls`，追加 `{role: "tool", tool_call_id: "call_...", content: "结果文本"}` 再请求同一接口；桥接将结果送回原始 Codex JSON-RPC 请求，继续同一回合。

并行返回的工具必须一次提供全部结果；连续工具回合也受支持。等待期间计入进程容量，默认保留 10 分钟。会话过期或服务重启后，工具回调会失败，需要重新开始对话。随机调用 ID 用于定位悬挂会话；不要在不同调用方之间共享它。

这是 **OpenAI API 的子集**，并非完整的 Responses/Chat API 替代品。不支持图片、音频、文件、Responses 的 function tools、`previous_response_id`、响应存储、后台任务或远程工作区。token 上限和采样参数作为兼容提示接受但不应用，具体见上文；其他未知参数仍返回 400。仅支持 `n=1` 和 `store=false`；工具强制选择（`required` 或指定函数名）暂不支持。

Codex 以只读 sandbox、`approvalPolicy=never` 运行，并关闭 shell、apply-patch 和 web-search。Codex 内置工具的权限请求仍会明确失败，不自动批准；调用方 function tools 的执行和权限由 iTerm2/调用方负责。它仍使用 Codex 的运行时，不应将其当作独立的模型推理服务或完整的隔离边界；专用 CODEX_HOME 能避免继承已有插件/MCP 配置。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | 监听地址；非回环地址要求配置 API Key |
| `CODEX_BRIDGE_PORT` | `8320` | HTTP 端口 |
| `CODEX_BRIDGE_API_KEY` | 空 | 可选 Bearer 认证密钥，不记录到日志 |
| `CODEX_BRIDGE_COMMAND` | `codex` | Codex 可执行文件路径，不经过 shell |
| `CODEX_BRIDGE_CODEX_HOME` | 沿用 `CODEX_HOME` / Codex 默认目录 | 专用 Codex 配置目录 |
| `CODEX_BRIDGE_TIMEOUT_MS` | `120000` | 单个请求的总超时，包括上传、初始化和生成 |
| `CODEX_BRIDGE_MAX_CONCURRENT` | `4` | 最大活动请求数，超出返回 429 |
| `CODEX_BRIDGE_TOOL_TIMEOUT_MS` | `600000` | 等待调用方工具结果的保留时间；悬挂会话计入进程容量 |

HTTP 请求体上限为 1 MiB；生成文本上限为 8 MiB；SSE 写缓冲超过 1 MiB 时关闭慢连接。首个 SSE 帧之前的错误使用 HTTP 状态码；之后的错误使用 SSE error，不发送成功完成事件。

## 检查

```sh
npm run test:codex-bridge
```

测试使用独立假 App Server 子进程，不调用真实模型。真实环境需另行验证 Codex 登录、模型权限及 CPA 路由。

协议依据：[OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。此协议随 Codex 版本变化；服务要求支持 `thread/inject_items` 和 ephemeral threads 的版本。不支持时返回上游错误，不退化为拼接历史。
