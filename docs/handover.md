# Shelly Handover

更新时间：2026-06-17

工作目录：`E:\sshelper`

## 项目定位

Shelly 是基于 Tauri 2 + React + TypeScript + Rust 的桌面 SSH 客户端，目标不是普通终端壳，而是一个更高效、更好看的 SSH 工作台。

产品方向：

- 视觉气质参考 VS Code、Claude Desktop、Codex Desktop。
- 左侧是连接入口/设备管理中心。
- 中间是 SSH 主终端和标签页。
- 右侧是上下文 Dock：文件、历史、snippets、Agent 辅助视图。
- 底部栏可在 PowerShell 和 Shelly SSH Agent 之间切换。
- Agent 设计为 CLI-first transcript，不做聊天软件式大气泡 UI。

用户明确偏好：

- 不要启动 `npm run dev` 或 `cargo tauri dev`，用户自己测试。
- 每次修改后只跑 `npm run build` 和 `cargo check`。
- 不要占用端口。
- 除独特功能外尽量复用成熟项目思路；`example/qssh` 是 Agent 参考。
- 不做无审批、solo、黑箱自动操作。Agent 命令必须用户审批，审批后写入当前可见 SSH 主终端。

## 技术栈

- 桌面：Tauri 2
- 前端：React 18 + TypeScript + Vite 6
- 状态：Zustand
- 终端：xterm.js + FitAddon + WebLinksAddon
- SSH：`russh`
- SFTP：`ssh2/libssh2`
- 本地终端：`portable-pty`
- 数据库：SQLite via `rusqlite`
- 凭据：`keyring` 优先，当前已加 SQLite `credential_cache` 兜底
- 模型 HTTP：`reqwest` + SSE stream

## 重要文档

- [development-plan.md](E:/sshelper/docs/development-plan.md)  
  当前开发计划，Phase 1/2/3 状态。

- [agent-terminal-implementation.md](E:/sshelper/docs/agent-terminal-implementation.md)  
  Agent 设计主文档，包含 provider、tools、system prompt、会话隔离、审批、稳定性策略。

- [research-architecture.md](E:/sshelper/docs/research-architecture.md)  
  同类项目调研，部分内容有编码显示问题，但方向可参考。

## 当前完成情况

### Phase 1：SSH Workbench

已基本完成：

- 设备连接列表和连接弹窗。
- SQLite 存储设备、命令历史、snippets。
- 多 SSH 标签页。
- 标签页可关闭、拖拽排序。
- SSH terminal 切换时保留 xterm 内容。
- 命令 palette：`Ctrl+/` 呼出，支持 slash/history/snippets。
- snippets 映射形式：`/snp-xxx`、`/snippets-xxx`。
- 底部本地 PowerShell 占位。

### Phase 2：Context Dock / 文件

已完成一版可用：

- 右侧 Dock tabs：`files`、`history`、`snippets`、`agent`。
- SFTP 后台 jobs：list、preview、download、upload、delete、rename、mkdir、create file。
- 文件浏览改成 VS Code 风格展开式树，不是进入式。
- 文件树缓存、返回上层、展开状态保存。
- 顶部细蓝色进度条思路已采用，避免加载状态占用文件区域。
- 文件 preview 在右侧独立预览栏。
- 文件树、SSH 终端、Dock 切换时尽量保留状态。
- 右侧 Dock 和 preview pane 支持拖拽缩放。
- 文件树右键菜单：新建、预览、下载、重命名、删除。

待收尾：

- upload 拖拽上传。
- byte-level transfer progress。
- chmod / 权限展示。
- 图片预览和编码 fallback。
- 文件树键盘导航。

### Phase 3：Agent Terminal

已实现基础闭环的一部分：

- AI provider 表和 conversation/message/session snapshot 表。
- Provider 支持两类：`openai_responses`、`claude_messages`。
- API key 使用 keyring 优先，SQLite 兜底。
- 底部栏可选择 PowerShell 或 SSH Agent。
- 设置入口在左下角齿轮，设置弹层顶部三栏：
  - `常用`：外观/i18n 等占位。
  - `连接`：SSH/路径设置占位。
  - `模型`：provider/API key + 底部栏行为。
- 右侧 Agent 视图保留，主入口改到底部栏。
- AgentPanel CLI-first transcript。
- `/sessions` 和误拼 `/seesions` 可列出当前 `server_key` 下旧会话。
- `/new-session` 新建会话。
- `read_terminal`：后端维护每个 SSH session 最近输出缓冲，发送前注入最近 120 行终端上下文。
- 纯聊天流式回复：
  - OpenAI Responses SSE：处理 `response.output_text.delta`
  - Claude Messages SSE：处理 `content_block_delta` / `text_delta`
- `/exec <cmd>` 手动生成审批块，用户 approve 后命令写入当前可见 SSH 主终端。

注意：LLM tool-call 自动生成 `exec_command` 审批还没有接入。现在只有手动 `/exec <cmd>` 审批路径。

## Agent 关键设计决策

### UI 形态

Agent 主形态是 CLI-first，不是 GUI 气泡聊天。

表现形式：

- terminal-like transcript。
- 顶部紧凑状态行。
- 单行 command composer。
- slash commands。
- 审批块内联。
- 流式输出逐步追加。

右侧 Agent 面板可以继续保留，但底部栏是主工作流入口。

### Provider 策略

第一阶段只明确支持：

- OpenAI Responses API
- Claude Messages API

不要优先做泛泛的 `/chat/completions` 兼容层，因为 tools、streaming、tool result 回填差异很大。

DeepSeek 等如果走 OpenAI-compatible API，当前可能要通过 `openai_responses` 兼容测试，后续可能需要单独加 `openai_chat_completions` provider kind。

### System Prompt 三层

见 [agent-terminal-implementation.md](E:/sshelper/docs/agent-terminal-implementation.md)。

结构：

- 静态层：`[Identity]`、`[Working Style]`、`[Hard Rules]`、`[Tools]`
- 会话层：`server_key`、host、user、OS、shell、session id、snapshot
- 动态层：cwd、recent terminal lines、estimated tokens

关键规则：

- Agent 不在远端服务器内部。
- 只能通过 Shelly 工具工作。
- 不直接执行命令。
- 不绕过审批。
- 不静默截断历史。
- `interleaved=true` 输出不能当作干净命令输出。

### 会话隔离

使用双重隔离：

- `server_key` 分辨设备，建议格式：`username@host:port`
- `conversation_id/session_id` 分辨同设备内不同对话

`ai_session_snapshots` 用于旧会话恢复，避免模型忘记当时在哪台机器、哪个目录。

### Token 策略

- Provider 设置里有 `context_window_tokens`，默认 258000。
- MVP 估算：`ceil(total_prompt_chars / 4)`。
- 达到 80%/90% 时提示建议新建会话。
- 超过限制时暂停发送，不静默截断历史。

### 命令审批

原则：

- 永远不无审批执行。
- 永远不 solo。
- 永远不黑箱执行。
- 审批后命令直接写入当前可见 SSH 主终端。
- 用户能看到命令和输出。

已实现：

- `/exec <cmd>` 生成审批块。
- approve 后通过 `sshInput()` 写入当前 session。

未实现：

- 模型 tool-call 自动生成 `exec_command` 审批。
- tool result 自动收集并回填模型。
- 命令结束 marker、interleaved 检测、超时状态。

## 最近修复与当前重点

### 凭据存储修复

之前问题：

- AI key 明明保存了，但对话提示：`AI provider API key is not saved...`
- SSH remember password 经常读不到，文件浏览报：`Saved password is missing...`
- 有时新建连接填表后过一段时间直接 disconnected，可能是连接成功后保存密码失败导致前端 catch 成失败。

当前修复：

- 新增 SQLite 表 `credential_cache(kind, account, secret, updated_at)`。
- 保存凭据时：尽力写 keyring，同时写 SQLite cache。
- 读取凭据时：keyring 优先，失败或空则读 SQLite cache。
- AI key 和 SSH password 都走这套兜底。
- SFTP 重连也改用 `Db::device_password()`，不再只靠 keyring。

风险：

- SQLite 兜底目前是明文存储。开发期为稳定性优先；正式版应考虑系统 keyring 修复、加密或明确风险提示。

### Agent 流式体验修复

之前问题：

- 模型文本像整段一次性甩进来。
- 完成后重新 `loadMessages` 导致观感不连续。
- 缺少 thinking/working 状态。

当前修复：

- 收到 `streaming` 状态时显示 `thinking...`。
- SSE delta 逐步追加。
- `done` 后只把 pending 行标记完成，不重刷整段历史。
- 顶部状态行显示：`idle`、`saving`、`thinking`、`done`、`error`、`context`。

### session_changed 误报修复

之前普通聊天可能提示：

`Active SSH session differs from the saved conversation session.`

原因：

- 旧 conversation 保存的 `active_session_id` 与当前重连后的 session id 不同，这很正常，不应该普通聊天时打扰。

当前处理：

- 普通聊天阶段移除该提示。
- 后续只应在执行命令前校验并提示重新绑定。

## 关键文件

### 后端

- [src-tauri/src/db.rs](E:/sshelper/src-tauri/src/db.rs)  
  SQLite schema、设备/历史/snippets、AI provider/conversation/messages/session snapshots、credential cache。

- [src-tauri/src/ai.rs](E:/sshelper/src-tauri/src/ai.rs)  
  Agent chat-only 流式调用、OpenAI Responses / Claude Messages SSE、`ai_read_terminal`。

- [src-tauri/src/ssh.rs](E:/sshelper/src-tauri/src/ssh.rs)  
  russh SSH session、xterm 输出事件、session 输出缓冲。

- [src-tauri/src/file_jobs.rs](E:/sshelper/src-tauri/src/file_jobs.rs)  
  SFTP jobs，已接 credential cache 读取。

- [src-tauri/src/lib.rs](E:/sshelper/src-tauri/src/lib.rs)  
  Tauri command 注册。

### 前端

- [src/App.tsx](E:/sshelper/src/App.tsx)  
  主布局，底部栏根据 `bottomPanelMode` 显示 PowerShell 或 SSH Agent。

- [src/store.ts](E:/sshelper/src/store.ts)  
  Zustand store；新增 `bottomPanelMode`、`showSettings`。

- [src/components/AgentPanel.tsx](E:/sshelper/src/components/AgentPanel.tsx)  
  CLI-first Agent 面板；支持 provider 表单、sessions、新会话、chat、read_terminal、`/exec` 审批。

- [src/components/SettingsDialog.tsx](E:/sshelper/src/components/SettingsDialog.tsx)  
  设置弹层，三栏：常用/连接/模型。

- [src/components/ContextDock.tsx](E:/sshelper/src/components/ContextDock.tsx)  
  右侧 Dock，包含 files/history/snippets/agent。

- [src/components/ConnectDialog.tsx](E:/sshelper/src/components/ConnectDialog.tsx)  
  SSH 连接弹窗，remember password 入口。

- [src/lib/ai.ts](E:/sshelper/src/lib/ai.ts)  
  Agent IPC wrapper 和事件监听。

- [src/lib/db.ts](E:/sshelper/src/lib/db.ts)  
  设备/历史/snippet IPC wrapper。

- [src/lib/files.ts](E:/sshelper/src/lib/files.ts)  
  文件 jobs IPC wrapper。

## 当前用户测试反馈

用户已用 DeepSeek key 测试：

- Agent 能正常聊天。
- DeepSeek 对 system prompt 的反馈整体正面。
- 手动 `/exec` 生成审批块，approve 后能写入 SSH 主终端，路径正确。

用户指出的问题：

1. Agent 本应放在底部 PowerShell 位置，已修正。
2. 设置入口应在左下角加号旁边，已修正。
3. 设置弹层要顶部分栏：常用、连接、模型，已修正。
4. API key 和 SSH password 存储混乱，已加 credential cache 兜底，但仍需用户继续实测。
5. 文本流式体验要像 Codex 一样逐步输出，已修正。
6. 需要 thinking/working 状态，已加基础状态行。
7. 需要连接稳定性策略，已写入文档，尚未实现自动重试。

## 已知问题 / 下一步建议

优先级从高到低：

1. 继续验证凭据存储
   - 删除旧 SQLite 后重新添加 SSH 连接，勾选 remember password。
   - 设置里重新保存 AI provider API key。
   - 测试重启后 key/password 是否仍可用。
   - 如果仍失败，需要在 UI 上显示“keyring failed, using SQLite cache”之类诊断。

2. 实现真正的 LLM tool-call 审批
   - 现在只有手动 `/exec <cmd>`。
   - 下一步：解析 OpenAI/Claude tool call，生成 approval block。
   - approve 后写入主 SSH terminal。
   - 捕获输出，作为 tool result 回填模型。

3. 命令输出捕获
   - 当前 `/exec` 只写入终端，没有自动收集本次命令结果并回填模型。
   - 需要做 command lifecycle：prompt 检测或 shell marker。
   - 需要处理 `interleaved=true`。

4. 稳定性
   - 模型 HTTP 请求 timeout。
   - 纯聊天最多 5 次重试。
   - SSE 断流提示。
   - 工具执行不能自动重复。

5. UI/i18n
   - 当前界面大多英文。
   - 收尾阶段要做 i18n。
   - 设置弹层里的常用/连接目前只有占位项。

6. 安全
   - `check_server_key` 当前仍接受所有 host key。
   - SSH password / AI key SQLite 兜底是明文，正式版要改。

## 验证状态

最近一次验证：

```powershell
npm run build
cargo check
```

结果：

- 前端 build 通过。
- Rust check 通过。
- 只有 Vite chunk size 警告和 E 盘 hard-link incremental cache 警告。

不要启动 dev server。用户会自己测试。

## 工作区状态提醒

当前 git worktree 很脏，包含大量之前阶段已改/未跟踪文件。不要随意 revert。

已知未跟踪/新增的重要文件：

- `docs/agent-terminal-implementation.md`
- `docs/development-plan.md`
- `src-tauri/src/ai.rs`
- `src-tauri/src/db.rs`
- `src-tauri/src/file_jobs.rs`
- `src/components/AgentPanel.tsx`
- `src/components/CommandPalette.tsx`
- `src/components/ContextDock.tsx`
- `src/components/SettingsDialog.tsx`
- `src/lib/ai.ts`
- `src/lib/db.ts`
- `src/lib/files.ts`

已知可忽略：

- `src-tauri/downloads/` 是用户测试下载目录，不要删除。
- E 盘 cargo hard-link 警告可以忽略。

## 推荐下一步

建议新会话从这里继续：

1. 让用户先测试删除旧 SQLite 后的新凭据保存是否稳定。
2. 如果稳定，开始做 LLM tool-call 审批：
   - OpenAI Responses tool call parse。
   - Claude Messages tool_use parse。
   - 统一内部 `AgentToolCall`。
   - 前端 approval block。
3. approve 后写入主 SSH terminal，并开始做输出捕获。

