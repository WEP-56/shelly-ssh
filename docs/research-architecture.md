# Shelly SSH Client 调研与架构草案

更新时间：2026-06-15

## 1. 项目目标

目标不是再做一个“能连 SSH 的工具”，而是做一个更像工作台的桌面客户端：

- 终端是核心，但不只是终端。
- 命令提示、快捷命令便签、历史回放、文件树、上传下载要围绕同一个会话流畅协作。
- 界面气质参考 Codex Desktop：舒适、克制、低噪声、有包裹感，不做传统运维工具那种强功能弱体验的堆砌。

基于当前的预览稿，产品定位建议是：

- 左侧：连接与最近会话，设置入口
- 中间：会话工作区与终端（浏览器标签页、类agent cli的斜杠命令提示，提示历史命令和变迁命令）
- 右侧：上下文侧栏（文件 / 文件查看、修改 / 历史 / 便签（添加常用命令一键输入））
- 底部：状态轻提示


## 2. 现有参考稿结论

本地参考文件：

- E:\sshelper\shelly_v3.html
- [屏幕截图 2026-06-15 171753.png](E:\sshelper\屏幕截图%202026-06-15%20171753.png)

这版预览已经有几个很对的方向：

- 深色低对比背景分层做得对，已经有“包裹感”基础。
- 左中右三栏结构很适合 SSH 场景，尤其右侧文件/历史/便签切换，是很好的差异化入口。
- 底部状态条和命令建议弹层都很有价值，说明你想做的是“辅助操作体验”，不是单纯的终端壳。

建议继续强化的点：

- 不要把它做成“连接列表 + 终端 + 文件树”的传统工具，而要做成“会话工作台”。
- 命令输入区要升级成 command composer：支持 slash commands、历史联想、便签插入、参数模板。
- 文件区不要只是树，要有“缓存状态、预览、下载队列、上传拖拽、最近访问”。
- 当前 HTML 存在明显字符编码错乱，正式工程里需要统一使用 UTF-8。

## 3. GitHub 高星同类项目

下面这些项目最值得作为对标或拆解对象。星数为 2026-06-15 调研时获取。

| 项目 | Stars | 适合借鉴什么 | 不建议直接照搬什么 |
| --- | ---: | --- | --- |
| [Tabby](https://github.com/Eugeny/tabby) | 72.1k | 多标签终端、配置体系、插件化思路、成熟的 SSH profile 体验 | UI 偏“终端工具”，你的方向应该更轻、更包裹 |
| [WezTerm](https://github.com/wez/wezterm) | 26.6k | 终端交互、pane 思维、键盘体验、终端细节打磨标准 | 它更像 terminal emulator，不是 SSH 工作台 |
| [xterm.js](https://github.com/xtermjs/xterm.js) | 20.7k | Web 端终端渲染事实标准，适合 Tauri 前端嵌入 | 只负责终端显示，不负责 SSH 业务层 |
| [electerm](https://github.com/electerm/electerm) | 14.3k | SSH + SFTP 一体化、书签/命令/文件的组合方式 | 产品面稍杂，信息密度偏高 |
| [XPipe](https://github.com/xpipe-io/xpipe) | 14.2k | “连接工作台”思路、复用已有 CLI 生态、不在远端安装代理 | 范围过大，覆盖 Docker/VM/容器等，MVP 不要学它铺太开 |
| [Cyberduck](https://github.com/iterate-ch/cyberduck) | 4.6k | 文件上传下载、队列、传输反馈、失败重试等文件体验 | 它不是终端产品，终端交互参考价值有限 |

### 3.1 对标拆解建议

最值得重点拆的是 4 个：

- Tabby：学习“成熟终端产品的结构稳定性”
- electerm：学习“SSH + SFTP + 命令组织如何组合在一起”
- XPipe：学习“连接中心/工作台”的产品定位
- Cyberduck：学习“文件传输体验细节”

你的产品应该更像：

“Tabby 的稳定终端底盘 + electerm 的 SSH/SFTP 一体化 + XPipe 的工作台思路 + Codex Desktop 的气质”

而不是简单复制其中任意一个。

## 4. 底层复用策略

SSH 连接层尽量不要造轮子。

推荐按层复用：

### 4.1 SSH / SFTP 层

首选：

- [`ssh2`](https://crates.io/crates/ssh2)
- 底层依赖 [`libssh2`](https://github.com/libssh2/libssh2)

推荐原因：

- Rust 生态里非常成熟，下载量高，足够实战。
- 同时覆盖 shell channel、exec、SFTP、port forwarding、agent 等常见需求。
- 对的 MVP 最重要的是“尽快做出稳定可用的 SSH 会话 + 文件传输”，不是自己实现 SSH 协议。
- Tauri 桌面端不要求纯 Rust 协议栈，绑定成熟 C 库是完全合理的工程选择。

当前调研数据：

- `ssh2`：6.6M+ downloads
- `libssh2`：历史非常久、跨平台成熟

备选：

- [`russh`](https://crates.io/crates/russh)

适合什么场景：

- 如果后续你要做更深的协议定制、纯 Rust 异步控制、更细的连接层可塑性，可以评估它。

为什么不作为第一阶段主选：

- 第一阶段目标是产品落地速度与稳定性。
- `ssh2 + libssh2` 的工程风险更低，更适合先做桌面 SSH 客户端。

结论：

- MVP 直接选 `ssh2`
- `russh` 作为未来替代或实验分支保留

### 4.2 终端渲染层

首选：

- [`xterm.js`](https://github.com/xtermjs/xterm.js)

推荐原因：

- 这是 Web/Tauri/Electron 里最成熟的终端显示层之一。
- 生态完整，常用 addon 齐全。
- 对你来说，核心问题不是自己写 terminal renderer，而是把远端 PTY 字节流稳定映射到前端。

建议配套：

- `@xterm/addon-fit`
- `@xterm/addon-web-links`
- `@xterm/addon-search`

说明：

- 你的 Rust 后端负责 SSH channel 与字节流。
- 前端 xterm.js 负责显示、输入、选区、搜索、链接识别、尺寸变化。

### 4.3 本地存储层

建议分两类：

- 偏配置：`tauri-plugin-store`
- 偏业务数据：`rusqlite` 或 SQLite 文件

具体建议：

- 连接配置、窗口偏好、主题、布局状态：用 `tauri-plugin-store`
- 历史命令、便签、最近访问文件、下载记录、标签：用 SQLite

这样做的好处：

- 配置和业务数据解耦
- 后续做搜索、筛选、排序、历史统计会更轻松

### 4.4 密钥与凭证

建议原则：

- 尽量复用系统现有 SSH 能力，不把私钥复制进应用内部数据库
- 优先支持：
  - 私钥路径
  - `~/.ssh/config`
  - SSH Agent / Pageant / Windows OpenSSH Agent

密码存储建议：

- 敏感凭证优先走系统密钥链或安全存储
- 不建议明文写入普通 JSON/SQLite

### 4.5 PTY 与会话模型

这里有一个关键判断：

- 你的核心是“远端 SSH shell PTY”
- 不是“本地 PTY 模拟器”

所以 MVP 阶段通常不需要引入 `portable-pty` 作为主链路。

更合适的方案是：

- 后端通过 SSH channel 请求远端 PTY
- 将远端输出流式推送给前端 xterm.js
- 将前端键盘输入回写到 SSH channel
- resize 时同步远端 PTY 尺寸

`portable-pty` 更适合以后如果你想加入“本地终端”或“本地任务面板”。

## 5. 推荐技术栈

## 5.1 总体栈

- 桌面框架：Tauri 2
- 后端语言：Rust
- 前端：React + TypeScript + Vite
- 状态管理：Zustand
- 服务端异步：Tokio
- 终端渲染：xterm.js
- SSH / SFTP：ssh2 + libssh2
- 数据存储：tauri-plugin-store + SQLite

说明：

- 这里推荐 React，不是因为它“更潮”，而是因为你的界面会有很多局部状态、面板、弹层、列表、Dock、会话切换和流式输出，组件化维护成本会低很多。
- 如果你更偏 Vue 也可以做，但从生态和终端类桌面工具案例来看，React 路线会更顺手。

## 5.2 Rust 端模块建议

建议从一开始就按服务拆分：

- `connection_service`
  - 连接建立、断线重连、认证、已连接列表
- `session_service`
  - shell channel、exec、PTY resize、输入输出流
- `sftp_service`
  - 文件树、读取、上传、下载、删除、重命名、缓存
- `snippet_service`
  - 命令便签、模板参数、分组
- `history_service`
  - 历史命令、最近执行、过滤检索
- `state_service`
  - 持久化配置、窗口布局、最近访问

### 5.3 前端模块建议

- `app-shell`
  - 整体布局、侧边栏、顶部标签栏、底部状态栏
- `workspace`
  - 当前会话工作区
- `terminal-view`
  - xterm.js 容器与事件桥接
- `command-composer`
  - slash 命令、联想、便签插入、历史命中
- `context-dock`
  - 文件 / 历史 / 便签三标签
- `transfer-center`
  - 上传下载队列与通知
- `connection-manager`
  - 连接列表、搜索、分组、最近访问

## 6. MVP 功能边界

强烈建议第一阶段不要把范围拉太大。MVP 做到下面这些，就已经很有竞争力：

### 6.1 必做

1. SSH 连接管理
2. 多标签会话
3. 远端终端交互
4. 命令历史
5. 快捷命令便签
6. 右侧远端文件树
7. 文件上传/下载
8. 文本文件预览
9. 基础状态提示（连接状态、传输状态、最近错误）

### 6.2 暂缓

1. Docker / Kubernetes / VM 管理
2. 多跳板自动编排
3. 团队协作与云同步
4. 复杂插件系统
5. 远端 IDE 级编辑器
6. 大而全的监控面板

## 7. UI 与交互建议

这是你产品很可能胜出的地方。

### 7.1 应该强化的体验关键词

- 安静
- 柔和
- 低对比
- 连续感
- 小而准的反馈
- 不打扰但很聪明

### 7.2 建议保留的骨架

- 左侧窄边栏放连接、最近、搜索
- 中间是主要会话区
- 右侧是上下文 Dock，不要一直塞满内容
- 底部状态栏只放最重要信息

### 7.3 一个关键差异点

命令输入框不要只做输入框。

应该把它做成：

- 命令入口
- 快捷命令面板
- 历史命中入口
- 参数模板入口
- 最近执行入口

也就是一个轻量 command palette + command composer 的结合体。

如果这个部分做好，产品辨识度会很强。

## 8. 推荐开发路线

### Phase 0：脚手架与验证

1. 初始化 Tauri 2 + React + TypeScript
2. 接入 xterm.js
3. Rust 端打通 `ssh2` 连接
4. 实现最小可用 SSH shell
5. 跑通前后端字节流桥接

完成标准：

- 能连接服务器
- 能输入命令
- 能显示回显
- 能 resize

### Phase 1：做成“可用产品”

1. 连接配置与保存
2. 多标签会话
3. 历史命令
4. 命令便签
5. 文件树加载
6. 上传下载
7. 状态栏与错误提示

### Phase 2：做出差异化

1. slash commands
2. 带参数模板的命令便签
3. 文件预览缓存
4. 最近目录 / 最近文件
5. 上传下载中心
6. 快捷键体系
7. 更细腻的断线重连体验

## 9. 我建议现在就定下来的技术决策

为了避免后面反复摇摆，下面这些建议可以直接先定：

- 桌面框架：Tauri 2
- SSH 主链路：`ssh2`
- SFTP：直接走 `ssh2` 配套能力
- 终端显示：`xterm.js`
- 会话模型：远端 PTY，不额外自研终端协议
- 配置存储：`tauri-plugin-store`
- 历史/便签/最近记录：SQLite
- 前端框架：React + TypeScript

## 10. 下一步建议

下一步最合理的不是继续画静态 HTML，而是直接开始做技术验证版：

1. 起一个 Tauri 2 工程
2. 接上 xterm.js
3. 用 Rust `ssh2` 跑通第一条 SSH shell 链路
4. 先把你当前这套“三栏工作台”界面移植成真实前端

只要这个最小闭环跑通，后面的文件树、历史、便签都能自然往上叠。

---

## 调研来源

- Tabby: https://github.com/Eugeny/tabby
- WezTerm: https://github.com/wez/wezterm
- xterm.js: https://github.com/xtermjs/xterm.js
- electerm: https://github.com/electerm/electerm
- XPipe: https://github.com/xpipe-io/xpipe
- Cyberduck: https://github.com/iterate-ch/cyberduck
- ssh2 crate: https://crates.io/crates/ssh2
- russh crate: https://crates.io/crates/russh
- tauri-plugin-store: https://crates.io/crates/tauri-plugin-store
