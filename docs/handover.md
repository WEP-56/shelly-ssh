# Shelly Handover

更新时间：2026-06-18 10:32 +08:00

工作目录：`E:\sshelper`

## 项目定位

Shelly 是一个基于 Tauri 2 + React 18 + TypeScript + Rust 的桌面 SSH workbench。它不是单纯终端外壳，目标是提供一个更现代、更高效的远程运维工作台。

产品形态：

- 左侧：设备和连接管理。
- 中间：主 SSH 终端、连接标签页、本地 PowerShell / Agent 底部面板。
- 右侧：Context Dock，目前包含 files / history / snippets。
- 底部 Agent：CLI-first transcript 风格，不做传统聊天软件气泡 UI。
- Agent 命令执行必须经过用户审批，审批后写入用户可见的主 SSH 终端。

用户明确偏好：

- 不要运行 `npm run dev` 或 `cargo tauri dev`，用户会自己启动和体验测试。
- 每次修改后只跑 `npm run build` 和 `cargo check`。
- 不要占用端口。
- 不要自动 revert 用户已有改动；当前 worktree 很脏，许多改动是 Phase 3 正常开发结果。
- Agent 不允许 solo / 黑箱 / 绕过审批。命令必须通过 Shelly 审批 UI，并写入可见 SSH 终端。

## 技术栈

- 桌面：Tauri 2
- 前端：React 18 + TypeScript + Vite 6
- 状态：Zustand
- 终端：xterm.js + FitAddon + WebLinksAddon
- SSH：`russh`
- SFTP：`ssh2/libssh2`
- 本地终端：`portable-pty`
- 数据库：SQLite via `rusqlite`
- 凭据：`keyring` 优先，SQLite `credential_cache` 兜底
- 模型请求：`reqwest` + SSE stream

## 当前总体状态

Phase 1 / Phase 2 基本可用。Phase 3 Agent 已经从“功能闭环”推进到“后期打磨”阶段。

当前判断：核心 Agent 闭环基本完善，剩余主要是使用体验、可靠性细节、性能优化和更系统的真实场景测试。

## 已完成能力

### Phase 1：SSH Workbench

- 设备列表、连接弹窗、连接状态。
- 多 SSH 标签页。
- 标签页可关闭、可拖拽排序。
- 切换标签页时保留 xterm 内容。
- 命令历史和 snippets。
- Command Palette，`Ctrl+/` 呼出。
- 底部本地 PowerShell 面板。

### Phase 2：Context Dock / 文件

- 右侧 Dock：files / history / snippets。
- SFTP jobs：list、preview、download、upload、delete、rename、mkdir、create file。
- 文件树是 VS Code 风格展开式，不是进入式。
- 文件树缓存、展开状态、preview pane。
- 右键菜单：新建、预览、下载、重命名、删除。
- 右侧 Dock 和 preview pane 支持拖拽缩放。

仍可后续增强：

- 拖拽上传。
- byte-level transfer progress。
- chmod / 权限展示。
- 图片预览、编码 fallback。
- 文件树键盘导航。

### Phase 3：Agent Terminal

Agent 当前已经实现完整闭环：

- Provider 支持：
  - `openai_responses`
  - `claude_messages`
- Provider API key：keyring 优先，SQLite cache 兜底。
- Conversation / messages / session snapshot 表已接入。
- 底部面板可在 PowerShell 和 Agent 间切换。
- Agent Panel 是 CLI-first transcript。
- `/sessions` 和误拼 `/seesions` 可列出当前服务器 Agent 会话。
- `/new-session` 新建会话。
- 模型可发起 `exec_command` tool call。
- Shelly 弹出审批 UI。
- 用户 approve 后命令写入当前可见 SSH 主终端。
- 后端用 marker 包装命令，捕获输出和 exit code。
- tool result 回填给模型，模型自动继续，不需要用户手动一轮一轮推进。
- 用户 deny 时也会形成真实 tool result 回填，模型可继续响应。
- Shelly blocked 的命令也会形成 tool result 并继续模型。
- 交互式命令识别为 `interactive`，走用户 handoff：
  - 首次弹出独立安全提醒，可勾选下次不提醒。
  - 审批卡显示 `interaction_tip`。
  - Agent 不介入后续 stdin。
  - 用户在主 SSH 终端完成交互后，点击 continue。
  - 前端捕获终端 delta，调用 `ai_complete_interactive_tool` 回填模型。
- 弱模型防幻觉规则已加强：
  - 禁止伪造 tool result。
  - 说“我来跑/我检查/我试/我申请”必须同回合真实调用 tool。
  - 默认一次只申请一条命令。
  - 总结必须基于真实 tool result，区分最终 exit code、局部失败、stderr、推断。
- 运行时也有 fake tool result guard：
  - 如果 assistant 文本伪造 `Tool result for exec_command` 且没有真实 tool call，后端发 `ai-stream-reset`，丢弃该文本并重试。
- 流式输出做了逐字/小片段队列，不再整段吐出。
- 工作状态有动态：
  - 状态文字省略号循环。
  - 状态点轻微跳动。
- 真实运维测试矩阵已新增：`docs/phase3-ops-test-matrix.md`。

## 最近完成的 6 项收尾

用户确认“1 到 6 都要做”，最近一轮已推进：

1. 结构化 provider messages
   - 后端不再把 system、session context、history 全拼成一个巨大 prompt 字符串。
   - 新增 `AgentPrompt` / `AgentPromptMessage`。
   - OpenAI Responses 使用 `instructions` + structured `input` messages。
   - Claude Messages 使用 top-level `system` + structured `messages`，并合并连续同角色消息。

2. 长输出回填策略
   - UI / `ai_tool_runs.output` 保留较长展示输出，当前上限 `80_000` chars。
   - 模型侧 tool result 使用确定性压缩 envelope，当前上限 `12_000` chars。
   - 长输出包含行数、字符数、head、tail、omitted char count。
   - 避免 Docker logs / journalctl / 大日志把上下文撑爆。

3. lifecycle status
   - `completed`、`timeout`、`denied`、`blocked` 都在 UI 里有更清晰展示。
   - `denied` / `blocked` 不再只是 UI 状态，也会回填模型继续工作。

4. shell context / session snapshot
   - 前端发送前会基于现有终端上下文刷新 snapshot，不运行隐藏远程命令。
   - snapshot 尽量记录 server key、session id、device id、host、port、user、hostname、os、shell、cwd、terminal title、captured_at。
   - cwd / hostname / shell / OS 仍是基于 prompt 和终端文本的启发式推断，不应当当成强事实。

5. i18n
   - 新增 `src/i18n.ts`，支持英文和简体中文。
   - Settings 增加 language selector。
   - 已覆盖 SettingsDialog、AgentPanel、Sidebar、ContextDock 主文案、CommandPalette、ConnectDialog。

6. native light mode
   - Settings 增加 theme selector。
   - 初版曾用 `filter: invert(1) hue-rotate(180deg)`，现在已移除。
   - 主 UI 硬编码色大量替换为 CSS vars：`--c0` / `--c1` / `--c2` / `--t0` / `--t1` / `--t2` / `--acc` 等。
   - 浅色模式已是原生变量方案，但仍需要真实 UI 视觉测试继续调对比度。

## 重要文件

后端：

- `src-tauri/src/ai.rs`
  - Agent 核心逻辑。
  - provider prompt 构造。
  - OpenAI / Claude SSE streaming。
  - tool call parse。
  - approval event。
  - command marker 包装和输出捕获。
  - fake tool result guard。
  - interactive handoff complete。
- `src-tauri/src/db.rs`
  - SQLite schema。
  - devices、history、snippets。
  - AI provider / conversation / messages / session snapshots / tool runs。
  - credential cache。
- `src-tauri/src/ssh.rs`
  - SSH session、xterm 输出事件、session output buffer。
- `src-tauri/src/file_jobs.rs`
  - SFTP 文件任务。
- `src-tauri/src/lib.rs`
  - Tauri command 注册。

前端：

- `src/App.tsx`
  - 主布局。
  - lazy load 主要组件。
  - theme / font size data attributes。
  - 底部面板 PowerShell / Agent 切换。
- `src/store.ts`
  - Zustand store。
  - language / themeMode / uiFontSize 持久化。
  - right dock tab 已无 agent 入口。
- `src/i18n.ts`
  - 英文和简体中文词典。
- `src/components/AgentPanel.tsx`
  - Agent 主面板。
  - streaming 打字效果。
  - approval / deny / interactive handoff。
  - terminal snapshot heuristic。
- `src/components/CommandPalette.tsx`
  - slash commands / history / snippet command palette。
  - `/agent` 和 `/sessions` 打开底部 Agent，而不是右侧 Dock。
- `src/components/ContextDock.tsx`
  - 右侧 files / history / snippets。
- `src/components/SettingsDialog.tsx`
  - common / connection / model。
  - language、theme、font size。
- `src/components/Sidebar.tsx`
  - 左侧设备列表。
- `src/components/ConnectDialog.tsx`
  - SSH 连接弹窗，已接入 i18n。
- `src/index.css`
  - 全局 CSS vars。
  - dark / light theme vars。
  - UI font size vars。

文档：

- `docs/phase3-ops-test-matrix.md`
  - 真实运维可靠性测试矩阵。
- `docs/development-plan.md`
  - 旧开发计划，可参考但可能滞后。
- `docs/agent-terminal-implementation.md`
  - Agent 设计文档，可参考但部分状态可能滞后。

## 当前验证状态

最近验证命令：

```powershell
npm run build
cargo check
```

结果：

- `npm run build` 通过。
- `cargo check` 通过。
- Cargo 仍有 E 盘 incremental cache hard-link warning，可忽略。

不要启动 dev server。用户会自己测试。

## 当前 worktree 状态

当前 worktree 是脏的，主要包括 Phase 3 大量改动。不要随意 revert。

当前已知改动：

- `src-tauri/src/ai.rs`
- `src-tauri/src/db.rs`
- `src/App.tsx`
- `src/components/AgentPanel.tsx`
- `src/components/CommandPalette.tsx`
- `src/components/ConnectDialog.tsx`
- `src/components/ContextDock.tsx`
- `src/components/SettingsDialog.tsx`
- `src/components/Sidebar.tsx`
- `src/index.css`
- `src/store.ts`
- `docs/phase3-ops-test-matrix.md`
- `src/i18n.ts`

## 用户测试反馈摘要

已确认体验改善：

- 凭据缓存目前稳定。
- Agent 命令审批流程可出现。
- tool result 回填后模型能继续工作。
- 真实运维场景体验不错：
  - 查 Docker 容器。
  - 看超长日志。
  - 启停 Docker 容器。
  - 设备健康检查。
- 弱模型曾出现伪造 tool result，GPT-5.5 未复现。已通过 system prompt 和 runtime guard 降低概率。
- 字号调整曾导致右下区域空白，已从 `zoom` 改为 CSS font vars。
- 浅色模式早期固定文字/图标对比不足，已通过变量化推进，但仍需真实界面细调。

## 已知风险和限制

1. SQLite credential cache 是明文兜底
   - 开发期为稳定性优先。
   - 正式版应考虑加密、系统 keyring 修复或明确风险提示。

2. session snapshot 不是强事实
   - 当前 cwd / shell / OS 多数来自终端上下文推断。
   - 不运行隐藏 `pwd` / `uname` 等命令，符合用户可见性原则。
   - 后续可考虑可选 shell integration / prompt marker，但必须清楚告知用户。

3. 交互式命令无法完全自动闭环
   - 设计上 Agent 不接管 stdin。
   - 当前通过 handoff + continue 回填模型。
   - 这是安全和可解释性取舍。

4. provider 兼容性
   - 当前正式支持 OpenAI Responses 和 Claude Messages。
   - OpenAI-compatible chat completions provider 尚未做。
   - DeepSeek 等弱模型可能仍更容易不按 tool protocol 行事，但 guard 已增强。

5. light mode 仍需要 UI 实测
   - 已移除反色滤镜。
   - 主 UI 已变量化。
   - xterm 主题、少量文件图标颜色、terminal background 仍可能需要更细分处理。

## 下一步建议（等待用户指示）

1. ssh部分的稳定性提升（从example文件夹内的参考项目寻找）
2. 使用体验提升的提升：设置项补全、
3. 启动速度的提升：例如按需加载功能，启动后只加载左侧边栏、ssh终端，直到使用者展开右侧边栏、低栏才加载功能（常用策略）
4. i18n 收尾
   - 搜索裸英文 UI 文案。
   - 检查右侧 Dock 深层错误文案、file job messages、少量 placeholder。
5. 安全收尾
   - Host key 当前策略需要复查。
   - credential cache 明文兜底需要正式策略。
   - 高风险命令分类可以继续增强。

## 开发注意

- 修改文件请优先使用 `apply_patch`。
- 搜索优先 `rg`。
- 验证只跑：

```powershell
npm run build
cargo check
```

- 谨慎运行（必要情况下可运行，但工作结束后必须结束端口占用，防止占用端口导致用户无法自行测试）

```powershell
npm run dev
cargo tauri dev
```

- 不要清理用户测试下载目录或未知文件。
- 不要因为 worktree 脏就 reset / checkout。
