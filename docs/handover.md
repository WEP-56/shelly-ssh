# Shelly 开发状态文档

更新时间：2026-06-16

---

## 项目概览

Shelly 是一个基于 Tauri 2 + React + TypeScript 的桌面 SSH 客户端，定位为「SSH 工作台」，参考 Codex Desktop 的气质。

工程根目录：`E:\sshelper`

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | React 18 + TypeScript + Vite 6 |
| 状态管理 | Zustand 5 |
| 终端渲染 | xterm.js 5 + FitAddon + WebLinksAddon |
| SSH 库 | russh 0.48（纯 Rust，无 C 依赖） |
| 本地 PTY | portable-pty 0.8（ConPTY on Windows） |
| 异步运行时 | Tokio 1 |
| 唯一 ID | uuid v4 |

---

## 项目文件结构

```
E:\sshelper\
├── index.html              Vite 入口（最小 HTML）
├── package.json
├── vite.config.ts
├── tsconfig.json
│
├── src\
│   ├── main.tsx            React 入口
│   ├── App.tsx             主布局（Titlebar / Sidebar / Main / LocalPanel / StatusBar）
│   ├── store.ts            Zustand 全局状态
│   ├── index.css           CSS 变量（VSCode Dark+ 调色板）
│   │
│   ├── lib\
│   │   ├── ssh.ts          SSH IPC 封装（invoke + listen）
│   │   └── local.ts        本地终端 IPC 封装
│   │
│   └── components\
│       ├── Sidebar.tsx         左侧连接列表，可折叠（0 / 200px）
│       ├── TerminalView.tsx    xterm.js 容器，绑定 SSH 会话
│       ├── LocalTerminal.tsx   xterm.js 容器，绑定本地 PTY
│       └── ConnectDialog.tsx   新建连接弹窗（host/port/user/pass）
│
└── src-tauri\
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── capabilities\
    │   └── default.json    core:default + core:event:default + window 权限
    └── src\
        ├── main.rs
        ├── lib.rs          manage State + register_handler
        ├── ssh.rs          SSH 后端（russh）
        └── local_term.rs   本地终端后端（portable-pty）
```

---

## Tauri 配置要点

- `decorations: false`：无原生标题栏，完全自定义
- `withGlobalTauri: true`：注入 `window.__TAURI__` 全局（历史遗留，React 代码已改用 ES 模块导入）
- `beforeDevCommand: "npm run dev"`：Tauri 自动启动 Vite，开发时 `cargo tauri dev` 即可
- `devUrl: "http://localhost:5173"`
- 最小窗口 700×450，默认 980×610

---

## 窗口布局

```
┌─────────────────────────────────────────────────────────────────┐
│ [≡] 🖥 Shelly — prod-web-01              [─]  [□]  [×]          │  ← 34px Titlebar（data-tauri-drag-region）
├──────────┬──────────────────────────────────────────────────────┤
│          │ tab: prod-web-01  [⊞] [▶]                           │  ← Tabbar 34px
│  Sidebar │─────────────────────────────────────────────────────│
│  200px   │                                                       │
│  折叠=0  │         Terminal / Welcome                           │  ← panerow flex:1
│          │                                                       │
│  ── search ──      ┌──────────────────────────────┤
│  connections list  │  files  history  snippets  ›  │  ← Right panel 200px（可拖拽）
│                    │                               │
│  [+] [⚙]          │  No remote connected.         │
├──────────┴─────────┴────────────────────────────────────────────┤
│ ▔▔▔▔  ← 4px 可拖拽调高（80~600px）                             │
│ TERMINAL                                                    [×] │  ← 本地面板头 28px
│                                                                 │
│  PowerShell / bash                                              │  ← LocalTerminal（xterm.js）
├─────────────────────────────────────────────────────────────────┤
│ 🔌 Not connected                          / commands            │  ← StatusBar（蓝色，10px）
└─────────────────────────────────────────────────────────────────┘
```

---

## IPC 接口

### SSH（russh）

| 命令/事件 | 方向 | 说明 |
|---|---|---|
| `ssh_connect(host,port,username,password)` | FE→Rust | 建立连接，返回 session_id |
| `ssh_input(id, data: number[])` | FE→Rust | 键盘输入 |
| `ssh_resize(id, cols, rows)` | FE→Rust | PTY resize |
| `ssh_disconnect(id)` | FE→Rust | 关闭连接 |
| Event `ssh-data` `{id, data}` | Rust→FE | 终端输出 |
| Event `ssh-closed` `id` | Rust→FE | 连接断开 |

### 本地终端（portable-pty）

| 命令/事件 | 方向 | 说明 |
|---|---|---|
| `local_start(cols, rows)` | FE→Rust | 启动 PowerShell/bash，返回 id |
| `local_input(id, data)` | FE→Rust | 键盘输入 |
| `local_resize(id, cols, rows)` | FE→Rust | PTY resize |
| `local_stop(id)` | FE→Rust | 关闭 PTY |
| Event `local-data` `{id, data}` | Rust→FE | 终端输出 |
| Event `local-closed` `id` | Rust→FE | PTY 关闭 |

---

## Zustand Store（src/store.ts）

```ts
Connection { id, name, host, port, username, status, sessionId? }

useStore {
  conns, activeId, sidebarOpen, rightOpen, showConnect
  localOpen, localHeight          // 本地终端面板
  addConn / patchConn / removeConn / setActive
  toggleSidebar / toggleRight / toggleLocal
  setLocalHeight / setShowConnect
}
```

---

## 颜色系统（index.css CSS 变量）

| 变量 | 值 | 用途 |
|---|---|---|
| `--c0` | `#1e1e1e` | 标题栏/侧边栏/终端背景 |
| `--c1` | `#252526` | 主区域背景 |
| `--c2` | `#2d2d2d` | 输入框 / 面板 |
| `--c3` | `#3c3c3c` | hover |
| `--acc` | `#569cd6` | 蓝色 accent（状态栏/高亮/tab 下划线） |
| `--t0` | `#d4d4d4` | 主文字 |
| `--t1` | `#9d9d9d` | 次文字 |
| `--t2` | `#686868` | 辅助文字 |
| `--t3` | `#454545` | 暗文字 |
| `--red` | `#f44747` | 错误 |
| `--grn` | `#4ec9b0` | 成功 |

---

## SSH 连接流程（russh）

```
前端 ssh_connect → Rust：
  1. russh::client::connect(config, host:port, ShellyHandler)
  2. handle.authenticate_password(user, pass)
  3. channel_open_session() → request_pty("xterm-256color") → request_shell()
  4. tokio::select! 循环：
     - channel.wait() → emit("ssh-data")
     - input_rx.recv() → channel.data()
     - resize_rx.recv() → channel.window_change()
  5. SessionHandle { input_tx, resize_tx, _handle } 存入 SessionStore
配置：keepalive 30s / max 3次
host key：MVP 阶段全部接受（Ok(true)）
```

---

## 本地终端流程（portable-pty）

```
前端 local_start → Rust：
  1. native_pty_system().openpty(PtySize)
  2. slave.spawn_command("powershell.exe") / "bash"
  3. master.try_clone_reader() → spawn_blocking 读循环 → emit("local-data")
  4. master.take_writer() → spawn_blocking 写循环 ← input_rx
  5. LocalHandle { input_tx, master: Arc<Mutex<Box<dyn MasterPty+Send>>> }
```

---

## 已知问题 / 待确认

- russh 的 `check_server_key` 当前返回 `Ok(true)`（接受所有主机密钥），生产前需加 known_hosts 校验
- 仅支持密码认证，SSH 密钥认证尚未实现
- `withGlobalTauri: true` 在 tauri.conf.json 中仍存在，前端已用 ES 模块导入，可以去掉
- 右侧面板（files/history/snippets）为 placeholder，功能未实现
- 连接列表不持久化（重启丢失），Store 待接 tauri-plugin-store

---

## 开发命令

```bash
# 安装前端依赖（首次）
npm install

# 启动开发模式（同时起 Vite + Tauri）
cargo tauri dev

# 仅检查前端编译
npm run build

# 仅检查 Rust 编译
cd src-tauri && cargo check
```
