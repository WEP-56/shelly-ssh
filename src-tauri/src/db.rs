use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const CREDENTIAL_SERVICE: &str = "Shelly SSH";
const AI_CREDENTIAL_SERVICE: &str = "Shelly AI Provider";

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub private_key_path: Option<String>,
    pub session_id: Option<String>,
    pub remember_password: bool,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDeviceInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: Option<String>,
    pub private_key_path: Option<String>,
    pub remember_password: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub id: String,
    pub device_id: Option<String>,
    pub command: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnippetInput {
    pub id: Option<String>,
    pub name: String,
    pub command: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    pub id: String,
    pub name: String,
    pub api_kind: String,
    pub base_url: String,
    pub model: String,
    pub context_window_tokens: i64,
    pub temperature: f64,
    pub max_tokens: i64,
    pub top_p: Option<f64>,
    pub timeout_secs: i64,
    pub system_prompt: Option<String>,
    pub is_default: bool,
    pub has_api_key: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiProviderInput {
    pub id: Option<String>,
    pub name: String,
    pub api_kind: String,
    pub base_url: String,
    pub model: String,
    pub context_window_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    pub timeout_secs: Option<i64>,
    pub system_prompt: Option<String>,
    pub is_default: Option<bool>,
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConversation {
    pub id: String,
    pub server_key: String,
    pub device_id: Option<String>,
    pub active_session_id: Option<String>,
    pub latest_snapshot_id: Option<String>,
    pub provider_id: Option<String>,
    pub title: Option<String>,
    pub estimated_tokens: i64,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiConversationInput {
    pub server_key: String,
    pub device_id: Option<String>,
    pub active_session_id: Option<String>,
    pub provider_id: Option<String>,
    pub title: Option<String>,
    pub snapshot: Option<SaveAiSessionSnapshotInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionSnapshot {
    pub id: String,
    pub conversation_id: String,
    pub server_key: String,
    pub session_id: Option<String>,
    pub device_id: Option<String>,
    pub hostname: Option<String>,
    pub username: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub os: Option<String>,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub terminal_title: Option<String>,
    pub captured_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiSessionSnapshotInput {
    pub server_key: String,
    pub session_id: Option<String>,
    pub device_id: Option<String>,
    pub hostname: Option<String>,
    pub username: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub os: Option<String>,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub terminal_title: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_args_json: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolRun {
    pub id: String,
    pub conversation_id: String,
    pub server_key: String,
    pub session_id: Option<String>,
    pub message_id: Option<String>,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args_json: String,
    pub command: Option<String>,
    pub risk_level: String,
    pub approval_status: String,
    pub run_status: String,
    pub output: Option<String>,
    pub exit_code: Option<i64>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub created_at: i64,
}

impl Db {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        #[cfg(debug_assertions)]
        let started = std::time::Instant::now();
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
        #[cfg(debug_assertions)]
        eprintln!(
            "[startup] resolved app data dir in {}ms: {}",
            started.elapsed().as_millis(),
            data_dir.display()
        );
        fs::create_dir_all(&data_dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
        #[cfg(debug_assertions)]
        let sqlite_started = std::time::Instant::now();

        let db_path = data_dir.join("shelly.sqlite3");
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        #[cfg(debug_assertions)]
        eprintln!(
            "[startup] sqlite open completed in {}ms",
            sqlite_started.elapsed().as_millis()
        );
        #[cfg(debug_assertions)]
        let schema_started = std::time::Instant::now();
        init_schema(&conn)?;
        #[cfg(debug_assertions)]
        eprintln!(
            "[startup] sqlite schema init completed in {}ms",
            schema_started.elapsed().as_millis()
        );
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn device(&self, id: &str) -> Result<Device, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        get_device(&conn, id)
    }

    pub fn default_ai_provider_with_key(&self) -> Result<(AiProvider, Option<String>), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let provider = get_default_ai_provider(&conn)?;
        let key = load_ai_provider_key_inner(&conn, &provider.id)?;
        Ok((provider, key))
    }

    pub fn ai_provider_with_key(&self, id: &str) -> Result<(AiProvider, Option<String>), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let provider = get_ai_provider(&conn, id)?;
        let key = load_ai_provider_key_inner(&conn, &provider.id)?;
        Ok((provider, key))
    }

    pub fn device_password(
        &self,
        device_id: &str,
        device: Option<&Device>,
    ) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        load_device_password_inner(&conn, device_id, device)
    }

    pub fn ai_conversation(&self, id: &str) -> Result<AiConversation, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        get_ai_conversation(&conn, id)
    }

    pub fn ai_messages(&self, conversation_id: &str) -> Result<Vec<AiMessage>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        list_ai_messages_inner(&conn, conversation_id)
    }

    pub fn append_ai_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: Option<&str>,
    ) -> Result<AiMessage, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        insert_ai_message(&conn, conversation_id, role, content)
    }

    pub fn touch_ai_conversation_tokens(
        &self,
        conversation_id: &str,
        estimated_tokens: i64,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE ai_conversations SET estimated_tokens = ?1, updated_at = ?2 WHERE id = ?3",
            params![estimated_tokens, now_ms(), conversation_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn create_ai_tool_run(
        &self,
        conversation_id: &str,
        server_key: &str,
        session_id: Option<&str>,
        message_id: Option<&str>,
        tool_call_id: &str,
        tool_name: &str,
        args_json: &str,
        command: Option<&str>,
        risk_level: &str,
    ) -> Result<AiToolRun, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        insert_ai_tool_run(
            &conn,
            conversation_id,
            server_key,
            session_id,
            message_id,
            tool_call_id,
            tool_name,
            args_json,
            command,
            risk_level,
        )
    }

    pub fn set_ai_tool_approval(
        &self,
        tool_run_id: &str,
        approval_status: &str,
    ) -> Result<AiToolRun, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let run_status = match approval_status {
            "approved" => "approved",
            "denied" => "denied",
            _ => "pending",
        };
        conn.execute(
            "UPDATE ai_tool_runs
             SET approval_status = ?1, run_status = ?2
             WHERE id = ?3",
            params![approval_status, run_status, tool_run_id],
        )
        .map_err(|e| e.to_string())?;
        get_ai_tool_run(&conn, tool_run_id)
    }

    pub fn ai_tool_run(&self, tool_run_id: &str) -> Result<AiToolRun, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        get_ai_tool_run(&conn, tool_run_id)
    }

    pub fn search_command_history(
        &self,
        device_id: Option<&str>,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<CommandHistoryEntry>, String> {
        let limit = limit.clamp(1, 100);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let query = query.map(str::trim).filter(|value| !value.is_empty());
        match (device_id, query) {
            (Some(device_id), Some(query)) => list_history_with_params(
                &conn,
                "SELECT id, device_id, command, created_at
                 FROM command_history
                 WHERE device_id = ?1 AND command LIKE ?2 ESCAPE '\\'
                 ORDER BY created_at DESC
                 LIMIT ?3",
                params![device_id, like_pattern(query), limit],
            ),
            (Some(device_id), None) => list_history_with_params(
                &conn,
                "SELECT id, device_id, command, created_at
                 FROM command_history
                 WHERE device_id = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
                params![device_id, limit],
            ),
            (None, Some(query)) => list_history_with_params(
                &conn,
                "SELECT id, device_id, command, created_at
                 FROM command_history
                 WHERE command LIKE ?1 ESCAPE '\\'
                 ORDER BY created_at DESC
                 LIMIT ?2",
                params![like_pattern(query), limit],
            ),
            (None, None) => list_history_with_params(
                &conn,
                "SELECT id, device_id, command, created_at
                 FROM command_history
                 ORDER BY created_at DESC
                 LIMIT ?1",
                params![limit],
            ),
        }
    }

    pub fn list_snippets(&self) -> Result<Vec<Snippet>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        list_snippets_inner(&conn)
    }

    pub fn save_snippet(&self, input: SaveSnippetInput) -> Result<Snippet, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        save_snippet_inner(&conn, input)
    }

    pub fn latest_ai_session_snapshot(
        &self,
        conversation_id: &str,
    ) -> Result<Option<AiSessionSnapshot>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, server_key, session_id, device_id, hostname, username,
                        host, port, os, shell, cwd, terminal_title, captured_at
                 FROM ai_session_snapshots
                 WHERE conversation_id = ?1
                 ORDER BY captured_at DESC
                 LIMIT 1",
            )
            .map_err(|e| e.to_string())?;
        match stmt.query_row(params![conversation_id], ai_snapshot_from_row) {
            Ok(snapshot) => Ok(Some(snapshot)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    pub fn start_ai_tool_run(
        &self,
        tool_run_id: &str,
        session_id: &str,
    ) -> Result<AiToolRun, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE ai_tool_runs
             SET approval_status = 'approved', run_status = 'running', session_id = ?1, started_at = ?2
             WHERE id = ?3",
            params![session_id, now_ms(), tool_run_id],
        )
        .map_err(|e| e.to_string())?;
        get_ai_tool_run(&conn, tool_run_id)
    }

    pub fn finish_ai_tool_run(
        &self,
        tool_run_id: &str,
        run_status: &str,
        output: &str,
        exit_code: Option<i64>,
    ) -> Result<AiToolRun, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE ai_tool_runs
             SET run_status = ?1, output = ?2, exit_code = ?3, completed_at = ?4
             WHERE id = ?5",
            params![run_status, output, exit_code, now_ms(), tool_run_id],
        )
        .map_err(|e| e.to_string())?;
        get_ai_tool_run(&conn, tool_run_id)
    }
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            auth_method TEXT NOT NULL DEFAULT 'password',
            private_key_path TEXT,
            session_id TEXT,
            remember_password INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_devices_host_user
            ON devices(host, username);

        CREATE TABLE IF NOT EXISTS command_history (
            id TEXT PRIMARY KEY,
            device_id TEXT,
            command TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_command_history_device_time
            ON command_history(device_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            command TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_snippets_name
            ON snippets(name);

        CREATE TABLE IF NOT EXISTS credential_cache (
            kind TEXT NOT NULL,
            account TEXT NOT NULL,
            secret TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(kind, account)
        );

        CREATE TABLE IF NOT EXISTS ai_providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            api_kind TEXT NOT NULL,
            base_url TEXT NOT NULL,
            model TEXT NOT NULL,
            context_window_tokens INTEGER NOT NULL DEFAULT 258000,
            temperature REAL NOT NULL DEFAULT 0.7,
            max_tokens INTEGER NOT NULL DEFAULT 4096,
            top_p REAL,
            timeout_secs INTEGER NOT NULL DEFAULT 120,
            system_prompt TEXT,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ai_providers_default
            ON ai_providers(is_default, updated_at DESC);

        CREATE TABLE IF NOT EXISTS ai_conversations (
            id TEXT PRIMARY KEY,
            server_key TEXT NOT NULL,
            device_id TEXT,
            active_session_id TEXT,
            latest_snapshot_id TEXT,
            provider_id TEXT,
            title TEXT,
            estimated_tokens INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'idle',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL,
            FOREIGN KEY(provider_id) REFERENCES ai_providers(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ai_conversations_server_time
            ON ai_conversations(server_key, updated_at DESC);

        CREATE TABLE IF NOT EXISTS ai_session_snapshots (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            server_key TEXT NOT NULL,
            session_id TEXT,
            device_id TEXT,
            hostname TEXT,
            username TEXT,
            host TEXT,
            port INTEGER,
            os TEXT,
            shell TEXT,
            cwd TEXT,
            terminal_title TEXT,
            captured_at INTEGER NOT NULL,
            FOREIGN KEY(conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_snapshots_conversation_time
            ON ai_session_snapshots(conversation_id, captured_at DESC);

        CREATE TABLE IF NOT EXISTS ai_messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_call_id TEXT,
            tool_name TEXT,
            tool_args_json TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_time
            ON ai_messages(conversation_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS ai_tool_runs (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            server_key TEXT NOT NULL,
            session_id TEXT,
            message_id TEXT,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            args_json TEXT NOT NULL,
            command TEXT,
            risk_level TEXT NOT NULL DEFAULT 'unknown',
            approval_status TEXT NOT NULL DEFAULT 'pending',
            run_status TEXT NOT NULL DEFAULT 'pending',
            output TEXT,
            exit_code INTEGER,
            started_at INTEGER,
            completed_at INTEGER,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_tool_runs_conversation_time
            ON ai_tool_runs(conversation_id, created_at DESC);
        "#,
    )
    .map_err(|e| e.to_string())?;
    ensure_column(
        conn,
        "devices",
        "remember_password",
        "ALTER TABLE devices ADD COLUMN remember_password INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "devices",
        "auth_method",
        "ALTER TABLE devices ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'",
    )?;
    ensure_column(
        conn,
        "devices",
        "private_key_path",
        "ALTER TABLE devices ADD COLUMN private_key_path TEXT",
    )?;
    ensure_column(
        conn,
        "devices",
        "pinned",
        "ALTER TABLE devices ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if !columns.iter().any(|name| name == column) {
        conn.execute_batch(alter_sql).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn lock_conn<'a>(db: &'a State<'_, Db>) -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    db.conn
        .lock()
        .map_err(|_| "database lock poisoned".to_string())
}

#[tauri::command]
pub fn db_list_devices(db: State<'_, Db>) -> Result<Vec<Device>, String> {
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();
    let conn = lock_conn(&db)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, host, port, username, auth_method, private_key_path, session_id, remember_password, pinned, created_at, updated_at
             FROM devices
             ORDER BY pinned DESC, updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Device {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get::<_, u16>(3)?,
                username: row.get(4)?,
                auth_method: row.get(5)?,
                private_key_path: row.get(6)?,
                session_id: row.get(7)?,
                remember_password: row.get::<_, i64>(8)? != 0,
                pinned: row.get::<_, i64>(9)? != 0,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let devices = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] db_list_devices returned {} devices in {}ms",
        devices.len(),
        started.elapsed().as_millis()
    );
    Ok(devices)
}

#[tauri::command]
pub fn db_save_device(input: SaveDeviceInput, db: State<'_, Db>) -> Result<Device, String> {
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();
    let conn = lock_conn(&db)?;

    conn.execute(
        r#"
        INSERT INTO devices (id, name, host, port, username, auth_method, private_key_path, remember_password, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            host = excluded.host,
            port = excluded.port,
            username = excluded.username,
            auth_method = excluded.auth_method,
            private_key_path = excluded.private_key_path,
            remember_password = excluded.remember_password,
            updated_at = excluded.updated_at
        "#,
        params![
            id,
            input.name,
            input.host,
            input.port,
            input.username,
            input.auth_method.unwrap_or_else(|| "password".into()),
            input.private_key_path.filter(|v| !v.trim().is_empty()),
            if input.remember_password { 1 } else { 0 },
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    get_device(&conn, &id)
}

#[tauri::command]
pub fn db_update_device_session(
    device_id: String,
    session_id: Option<String>,
    db: State<'_, Db>,
) -> Result<(), String> {
    let conn = lock_conn(&db)?;
    conn.execute(
        "UPDATE devices SET session_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![session_id, now_ms(), device_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_set_device_pinned(
    device_id: String,
    pinned: bool,
    db: State<'_, Db>,
) -> Result<Device, String> {
    let conn = lock_conn(&db)?;
    conn.execute(
        "UPDATE devices SET pinned = ?1, updated_at = ?2 WHERE id = ?3",
        params![if pinned { 1 } else { 0 }, now_ms(), device_id],
    )
    .map_err(|e| e.to_string())?;
    get_device(&conn, &device_id)
}

#[tauri::command]
pub fn db_delete_device(id: String, db: State<'_, Db>) -> Result<(), String> {
    let device = db.device(&id).ok();
    let conn = lock_conn(&db)?;
    conn.execute("DELETE FROM devices WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let _ = delete_device_password_inner(&conn, &id, device.as_ref());
    Ok(())
}

#[tauri::command]
pub fn db_get_device_password(
    device_id: String,
    db: State<'_, Db>,
) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();
    let device = db.device(&device_id).ok();
    let password = db.device_password(&device_id, device.as_ref())?;
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] db_get_device_password completed in {}ms (found={})",
        started.elapsed().as_millis(),
        password.is_some()
    );
    Ok(password)
}

#[tauri::command]
pub fn db_save_device_password(
    device_id: String,
    password: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    let device = db.device(&device_id).ok();
    let conn = lock_conn(&db)?;
    save_device_password_inner(&conn, &device_id, device.as_ref(), &password)
}

#[tauri::command]
pub fn db_delete_device_password(device_id: String, db: State<'_, Db>) -> Result<(), String> {
    let device = db.device(&device_id).ok();
    let conn = lock_conn(&db)?;
    delete_device_password_inner(&conn, &device_id, device.as_ref())
}

#[tauri::command]
pub fn db_add_command_history(
    device_id: Option<String>,
    command: String,
    db: State<'_, Db>,
) -> Result<CommandHistoryEntry, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("command is required".into());
    }

    let entry = CommandHistoryEntry {
        id: Uuid::new_v4().to_string(),
        device_id,
        command,
        created_at: now_ms(),
    };
    let conn = lock_conn(&db)?;
    conn.execute(
        "INSERT INTO command_history (id, device_id, command, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![entry.id, entry.device_id, entry.command, entry.created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
pub fn db_list_command_history(
    device_id: Option<String>,
    limit: Option<u32>,
    db: State<'_, Db>,
) -> Result<Vec<CommandHistoryEntry>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let conn = lock_conn(&db)?;

    if let Some(device_id) = device_id {
        list_history_with_params(
            &conn,
            "SELECT id, device_id, command, created_at
             FROM command_history
             WHERE device_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
            params![device_id, limit],
        )
    } else {
        list_history_with_params(
            &conn,
            "SELECT id, device_id, command, created_at
             FROM command_history
             ORDER BY created_at DESC
             LIMIT ?1",
            params![limit],
        )
    }
}

#[tauri::command]
pub fn db_delete_command_history(id: String, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock_conn(&db)?;
    conn.execute("DELETE FROM command_history WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_clear_command_history(
    device_id: Option<String>,
    db: State<'_, Db>,
) -> Result<(), String> {
    let conn = lock_conn(&db)?;
    if let Some(device_id) = device_id {
        conn.execute(
            "DELETE FROM command_history WHERE device_id = ?1",
            params![device_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute("DELETE FROM command_history", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn db_list_snippets(db: State<'_, Db>) -> Result<Vec<Snippet>, String> {
    let conn = lock_conn(&db)?;
    list_snippets_inner(&conn)
}

fn list_snippets_inner(conn: &Connection) -> Result<Vec<Snippet>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, command, created_at, updated_at
             FROM snippets
             ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Snippet {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_save_snippet(input: SaveSnippetInput, db: State<'_, Db>) -> Result<Snippet, String> {
    let conn = lock_conn(&db)?;
    save_snippet_inner(&conn, input)
}

fn save_snippet_inner(conn: &Connection, input: SaveSnippetInput) -> Result<Snippet, String> {
    let name = input.name.trim().trim_start_matches('/').to_string();
    let command = input.command.trim().to_string();
    if name.is_empty() {
        return Err("snippet name is required".into());
    }
    if command.is_empty() {
        return Err("snippet command is required".into());
    }

    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO snippets (id, name, command, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?4)
        ON CONFLICT(name) DO UPDATE SET
            command = excluded.command,
            updated_at = excluded.updated_at
        "#,
        params![id, name, command, now],
    )
    .map_err(|e| e.to_string())?;

    get_snippet_by_name(&conn, &name)
}

#[tauri::command]
pub fn db_delete_snippet(id: String, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock_conn(&db)?;
    conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_list_ai_providers(db: State<'_, Db>) -> Result<Vec<AiProvider>, String> {
    let conn = lock_conn(&db)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, api_kind, base_url, model, context_window_tokens, temperature,
                    max_tokens, top_p, timeout_secs, system_prompt, is_default, created_at, updated_at
             FROM ai_providers
             ORDER BY is_default DESC, updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], ai_provider_from_row)
        .map_err(|e| e.to_string())?;
    let mut providers = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for provider in &mut providers {
        provider.has_api_key = load_ai_provider_key_inner(&conn, &provider.id)?.is_some();
    }
    Ok(providers)
}

#[tauri::command]
pub fn db_save_ai_provider(
    input: SaveAiProviderInput,
    db: State<'_, Db>,
) -> Result<AiProvider, String> {
    let name = input.name.trim().to_string();
    let api_kind = input.api_kind.trim().to_string();
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    let model = input.model.trim().to_string();
    if name.is_empty() {
        return Err("provider name is required".into());
    }
    if !matches!(api_kind.as_str(), "openai_responses" | "claude_messages") {
        return Err("provider api kind must be openai_responses or claude_messages".into());
    }
    if base_url.is_empty() {
        return Err("provider base URL is required".into());
    }
    if model.is_empty() {
        return Err("provider model is required".into());
    }

    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();
    let context_window_tokens = input.context_window_tokens.unwrap_or(258_000).max(1_000);
    let temperature = input.temperature.unwrap_or(0.7).clamp(0.0, 2.0);
    let max_tokens = input.max_tokens.unwrap_or(4096).max(1);
    let timeout_secs = input.timeout_secs.unwrap_or(120).clamp(10, 600);
    let is_default = input.is_default.unwrap_or(false);
    let system_prompt = input.system_prompt.and_then(|v| {
        if v.trim().is_empty() {
            None
        } else {
            Some(v.trim().to_string())
        }
    });

    let conn = lock_conn(&db)?;
    if is_default {
        conn.execute("UPDATE ai_providers SET is_default = 0", [])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        r#"
        INSERT INTO ai_providers
            (id, name, api_kind, base_url, model, context_window_tokens, temperature, max_tokens,
             top_p, timeout_secs, system_prompt, is_default, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            api_kind = excluded.api_kind,
            base_url = excluded.base_url,
            model = excluded.model,
            context_window_tokens = excluded.context_window_tokens,
            temperature = excluded.temperature,
            max_tokens = excluded.max_tokens,
            top_p = excluded.top_p,
            timeout_secs = excluded.timeout_secs,
            system_prompt = excluded.system_prompt,
            is_default = excluded.is_default,
            updated_at = excluded.updated_at
        "#,
        params![
            id,
            name,
            api_kind,
            base_url,
            model,
            context_window_tokens,
            temperature,
            max_tokens,
            input.top_p,
            timeout_secs,
            system_prompt,
            if is_default { 1 } else { 0 },
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    if input
        .api_key
        .as_ref()
        .is_some_and(|key| !key.trim().is_empty())
    {
        save_ai_provider_key_inner(&conn, &id, input.api_key.as_ref().unwrap().trim())?;
    }
    let provider_count = conn
        .query_row("SELECT COUNT(*) FROM ai_providers", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())?;
    if provider_count == 1 {
        conn.execute(
            "UPDATE ai_providers SET is_default = 1 WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    get_ai_provider(&conn, &id)
}

#[tauri::command]
pub fn db_delete_ai_provider(id: String, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock_conn(&db)?;
    conn.execute("DELETE FROM ai_providers WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let _ = delete_ai_provider_key_inner(&conn, &id);
    Ok(())
}

#[tauri::command]
pub fn db_set_default_ai_provider(id: String, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock_conn(&db)?;
    conn.execute("UPDATE ai_providers SET is_default = 0", [])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE ai_providers SET is_default = 1, updated_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_create_ai_conversation(
    input: CreateAiConversationInput,
    db: State<'_, Db>,
) -> Result<AiConversation, String> {
    let server_key = input.server_key.trim().to_string();
    if server_key.is_empty() {
        return Err("server key is required".into());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let title = input.title.or_else(|| Some("New session".to_string()));
    let conn = lock_conn(&db)?;
    conn.execute(
        r#"
        INSERT INTO ai_conversations
            (id, server_key, device_id, active_session_id, provider_id, title, estimated_tokens,
             status, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'idle', ?7, ?7)
        "#,
        params![
            id,
            server_key,
            input.device_id,
            input.active_session_id,
            input.provider_id,
            title,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    if let Some(snapshot) = input.snapshot {
        let snapshot = insert_ai_snapshot(&conn, &id, snapshot)?;
        conn.execute(
            "UPDATE ai_conversations SET latest_snapshot_id = ?1 WHERE id = ?2",
            params![snapshot.id, id],
        )
        .map_err(|e| e.to_string())?;
    }
    get_ai_conversation(&conn, &id)
}

#[tauri::command]
pub fn db_list_ai_conversations(
    server_key: Option<String>,
    device_id: Option<String>,
    db: State<'_, Db>,
) -> Result<Vec<AiConversation>, String> {
    let conn = lock_conn(&db)?;
    let mut sql =
        "SELECT id, server_key, device_id, active_session_id, latest_snapshot_id, provider_id,
                          title, estimated_tokens, status, created_at, updated_at
                   FROM ai_conversations"
            .to_string();
    let mut clauses = Vec::new();
    if server_key.as_ref().is_some_and(|v| !v.trim().is_empty()) {
        clauses.push("server_key = ?1");
    }
    if device_id.as_ref().is_some_and(|v| !v.trim().is_empty()) {
        clauses.push(if clauses.is_empty() {
            "device_id = ?1"
        } else {
            "device_id = ?2"
        });
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY updated_at DESC");

    match (server_key, device_id) {
        (Some(server_key), Some(device_id))
            if !server_key.trim().is_empty() && !device_id.trim().is_empty() =>
        {
            list_ai_conversations_with_params(&conn, &sql, params![server_key, device_id])
        }
        (Some(server_key), _) if !server_key.trim().is_empty() => {
            list_ai_conversations_with_params(&conn, &sql, params![server_key])
        }
        (_, Some(device_id)) if !device_id.trim().is_empty() => {
            list_ai_conversations_with_params(&conn, &sql, params![device_id])
        }
        _ => list_ai_conversations_with_params(&conn, &sql, []),
    }
}

#[tauri::command]
pub fn db_get_ai_conversation(id: String, db: State<'_, Db>) -> Result<AiConversation, String> {
    let conn = lock_conn(&db)?;
    get_ai_conversation(&conn, &id)
}

#[tauri::command]
pub fn db_delete_ai_conversation(id: String, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock_conn(&db)?;
    conn.execute("DELETE FROM ai_conversations WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_bind_ai_conversation_session(
    conversation_id: String,
    active_session_id: Option<String>,
    snapshot: SaveAiSessionSnapshotInput,
    db: State<'_, Db>,
) -> Result<AiSessionSnapshot, String> {
    let conn = lock_conn(&db)?;
    let snapshot = insert_ai_snapshot(&conn, &conversation_id, snapshot)?;
    conn.execute(
        "UPDATE ai_conversations SET active_session_id = ?1, latest_snapshot_id = ?2, updated_at = ?3 WHERE id = ?4",
        params![active_session_id, snapshot.id, now_ms(), conversation_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(snapshot)
}

#[tauri::command]
pub fn db_list_ai_session_snapshots(
    conversation_id: String,
    db: State<'_, Db>,
) -> Result<Vec<AiSessionSnapshot>, String> {
    let conn = lock_conn(&db)?;
    list_ai_snapshots_inner(&conn, &conversation_id)
}

#[tauri::command]
pub fn db_list_ai_messages(
    conversation_id: String,
    db: State<'_, Db>,
) -> Result<Vec<AiMessage>, String> {
    let conn = lock_conn(&db)?;
    list_ai_messages_inner(&conn, &conversation_id)
}

fn get_device(conn: &Connection, id: &str) -> Result<Device, String> {
    conn.query_row(
        "SELECT id, name, host, port, username, auth_method, private_key_path, session_id, remember_password, pinned, created_at, updated_at
         FROM devices
         WHERE id = ?1",
        params![id],
        |row| {
            Ok(Device {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get::<_, u16>(3)?,
                username: row.get(4)?,
                auth_method: row.get(5)?,
                private_key_path: row.get(6)?,
                session_id: row.get(7)?,
                remember_password: row.get::<_, i64>(8)? != 0,
                pinned: row.get::<_, i64>(9)? != 0,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn credential_entry(device_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, device_id).map_err(|e| e.to_string())
}

pub fn load_device_password_for_device(
    device_id: &str,
    device: Option<&Device>,
) -> Result<Option<String>, String> {
    let mut last_err: Option<String> = None;
    for account in credential_accounts(device_id, device) {
        match credential_entry(&account)?.get_password() {
            Ok(password) => {
                if account != device_id {
                    let _ = credential_entry(device_id)?.set_password(&password);
                }
                return Ok(Some(password));
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    if let Some(err) = last_err {
        return Err(err);
    }
    Ok(None)
}

fn load_device_password_inner(
    conn: &Connection,
    device_id: &str,
    device: Option<&Device>,
) -> Result<Option<String>, String> {
    if let Ok(Some(password)) = load_device_password_for_device(device_id, device) {
        return Ok(Some(password));
    }
    for account in credential_accounts(device_id, device) {
        if let Some(secret) = load_cached_credential(conn, "device_password", &account)? {
            return Ok(Some(secret));
        }
    }
    Ok(None)
}

pub fn save_device_password_for_device(
    device_id: &str,
    device: Option<&Device>,
    password: &str,
) -> Result<(), String> {
    let mut last_err: Option<String> = None;
    for account in credential_accounts(device_id, device) {
        if let Err(e) = credential_entry(&account)?.set_password(password) {
            last_err = Some(e.to_string());
        }
    }
    if let Some(err) = last_err {
        return Err(err);
    }
    Ok(())
}

fn save_device_password_inner(
    conn: &Connection,
    device_id: &str,
    device: Option<&Device>,
    password: &str,
) -> Result<(), String> {
    let _ = save_device_password_for_device(device_id, device, password);
    for account in credential_accounts(device_id, device) {
        save_cached_credential(conn, "device_password", &account, password)?;
    }
    Ok(())
}

fn credential_accounts(device_id: &str, device: Option<&Device>) -> Vec<String> {
    let mut accounts = vec![device_id.to_string()];
    if let Some(device) = device {
        accounts.push(format!(
            "{}@{}:{}",
            device.username, device.host, device.port
        ));
    }
    accounts.sort();
    accounts.dedup();
    accounts
}

fn delete_device_password_inner(
    conn: &Connection,
    device_id: &str,
    device: Option<&Device>,
) -> Result<(), String> {
    let mut last_err: Option<String> = None;
    for account in credential_accounts(device_id, device) {
        match credential_entry(&account)
            .and_then(|entry| entry.delete_credential().map_err(|e| e.to_string()))
        {
            Ok(()) => {}
            Err(e) if e.contains("NoEntry") => {}
            Err(e) => last_err = Some(e),
        }
        delete_cached_credential(conn, "device_password", &account)?;
    }
    if let Some(err) = last_err {
        eprintln!("[credentials] keyring delete failed: {err}");
    }
    Ok(())
}

fn get_snippet_by_name(conn: &Connection, name: &str) -> Result<Snippet, String> {
    conn.query_row(
        "SELECT id, name, command, created_at, updated_at FROM snippets WHERE name = ?1",
        params![name],
        |row| {
            Ok(Snippet {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn load_cached_credential(
    conn: &Connection,
    kind: &str,
    account: &str,
) -> Result<Option<String>, String> {
    match conn.query_row(
        "SELECT secret FROM credential_cache WHERE kind = ?1 AND account = ?2",
        params![kind, account],
        |row| row.get::<_, String>(0),
    ) {
        Ok(secret) => Ok(Some(secret)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn save_cached_credential(
    conn: &Connection,
    kind: &str,
    account: &str,
    secret: &str,
) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO credential_cache (kind, account, secret, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(kind, account) DO UPDATE SET
            secret = excluded.secret,
            updated_at = excluded.updated_at
        "#,
        params![kind, account, secret, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_cached_credential(conn: &Connection, kind: &str, account: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM credential_cache WHERE kind = ?1 AND account = ?2",
        params![kind, account],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ai_provider_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(AI_CREDENTIAL_SERVICE, provider_id).map_err(|e| e.to_string())
}

fn load_ai_provider_key(provider_id: &str) -> Result<Option<String>, String> {
    match ai_provider_entry(provider_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn load_ai_provider_key_inner(
    conn: &Connection,
    provider_id: &str,
) -> Result<Option<String>, String> {
    if let Ok(Some(key)) = load_ai_provider_key(provider_id) {
        return Ok(Some(key));
    }
    load_cached_credential(conn, "ai_provider_key", provider_id)
}

fn save_ai_provider_key(provider_id: &str, api_key: &str) -> Result<(), String> {
    ai_provider_entry(provider_id)?
        .set_password(api_key)
        .map_err(|e| e.to_string())
}

fn save_ai_provider_key_inner(
    conn: &Connection,
    provider_id: &str,
    api_key: &str,
) -> Result<(), String> {
    let _ = save_ai_provider_key(provider_id, api_key);
    save_cached_credential(conn, "ai_provider_key", provider_id, api_key)
}

fn delete_ai_provider_key(provider_id: &str) -> Result<(), String> {
    match ai_provider_entry(provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_ai_provider_key_inner(conn: &Connection, provider_id: &str) -> Result<(), String> {
    let _ = delete_ai_provider_key(provider_id);
    delete_cached_credential(conn, "ai_provider_key", provider_id)
}

fn ai_provider_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiProvider> {
    let id: String = row.get(0)?;
    Ok(AiProvider {
        id,
        name: row.get(1)?,
        api_kind: row.get(2)?,
        base_url: row.get(3)?,
        model: row.get(4)?,
        context_window_tokens: row.get(5)?,
        temperature: row.get(6)?,
        max_tokens: row.get(7)?,
        top_p: row.get(8)?,
        timeout_secs: row.get(9)?,
        system_prompt: row.get(10)?,
        is_default: row.get::<_, i64>(11)? != 0,
        has_api_key: false,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn get_ai_provider(conn: &Connection, id: &str) -> Result<AiProvider, String> {
    let mut provider = conn
        .query_row(
            "SELECT id, name, api_kind, base_url, model, context_window_tokens, temperature,
                max_tokens, top_p, timeout_secs, system_prompt, is_default, created_at, updated_at
         FROM ai_providers
         WHERE id = ?1",
            params![id],
            ai_provider_from_row,
        )
        .map_err(|e| e.to_string())?;
    provider.has_api_key = load_ai_provider_key_inner(conn, &provider.id)?.is_some();
    Ok(provider)
}

fn get_default_ai_provider(conn: &Connection) -> Result<AiProvider, String> {
    let mut provider = conn
        .query_row(
            "SELECT id, name, api_kind, base_url, model, context_window_tokens, temperature,
                max_tokens, top_p, timeout_secs, system_prompt, is_default, created_at, updated_at
         FROM ai_providers
         ORDER BY is_default DESC, updated_at DESC
         LIMIT 1",
            [],
            ai_provider_from_row,
        )
        .map_err(|e| e.to_string())?;
    provider.has_api_key = load_ai_provider_key_inner(conn, &provider.id)?.is_some();
    Ok(provider)
}

fn ai_conversation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiConversation> {
    Ok(AiConversation {
        id: row.get(0)?,
        server_key: row.get(1)?,
        device_id: row.get(2)?,
        active_session_id: row.get(3)?,
        latest_snapshot_id: row.get(4)?,
        provider_id: row.get(5)?,
        title: row.get(6)?,
        estimated_tokens: row.get(7)?,
        status: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn get_ai_conversation(conn: &Connection, id: &str) -> Result<AiConversation, String> {
    conn.query_row(
        "SELECT id, server_key, device_id, active_session_id, latest_snapshot_id, provider_id,
                title, estimated_tokens, status, created_at, updated_at
         FROM ai_conversations
         WHERE id = ?1",
        params![id],
        ai_conversation_from_row,
    )
    .map_err(|e| e.to_string())
}

fn list_ai_conversations_with_params<P>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<AiConversation>, String>
where
    P: rusqlite::Params,
{
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params, ai_conversation_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn insert_ai_snapshot(
    conn: &Connection,
    conversation_id: &str,
    snapshot: SaveAiSessionSnapshotInput,
) -> Result<AiSessionSnapshot, String> {
    let item = AiSessionSnapshot {
        id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        server_key: snapshot.server_key,
        session_id: snapshot.session_id,
        device_id: snapshot.device_id,
        hostname: snapshot.hostname,
        username: snapshot.username,
        host: snapshot.host,
        port: snapshot.port,
        os: snapshot.os,
        shell: snapshot.shell,
        cwd: snapshot.cwd,
        terminal_title: snapshot.terminal_title,
        captured_at: now_ms(),
    };
    conn.execute(
        r#"
        INSERT INTO ai_session_snapshots
            (id, conversation_id, server_key, session_id, device_id, hostname, username, host,
             port, os, shell, cwd, terminal_title, captured_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        "#,
        params![
            item.id,
            item.conversation_id,
            item.server_key,
            item.session_id,
            item.device_id,
            item.hostname,
            item.username,
            item.host,
            item.port,
            item.os,
            item.shell,
            item.cwd,
            item.terminal_title,
            item.captured_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(item)
}

fn ai_snapshot_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiSessionSnapshot> {
    Ok(AiSessionSnapshot {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        server_key: row.get(2)?,
        session_id: row.get(3)?,
        device_id: row.get(4)?,
        hostname: row.get(5)?,
        username: row.get(6)?,
        host: row.get(7)?,
        port: row.get(8)?,
        os: row.get(9)?,
        shell: row.get(10)?,
        cwd: row.get(11)?,
        terminal_title: row.get(12)?,
        captured_at: row.get(13)?,
    })
}

fn list_ai_snapshots_inner(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<AiSessionSnapshot>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, conversation_id, server_key, session_id, device_id, hostname, username,
                    host, port, os, shell, cwd, terminal_title, captured_at
             FROM ai_session_snapshots
             WHERE conversation_id = ?1
             ORDER BY captured_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id], ai_snapshot_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn ai_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiMessage> {
    Ok(AiMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        tool_call_id: row.get(4)?,
        tool_name: row.get(5)?,
        tool_args_json: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn list_ai_messages_inner(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<AiMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args_json, created_at
             FROM ai_messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id], ai_message_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn insert_ai_message(
    conn: &Connection,
    conversation_id: &str,
    role: &str,
    content: Option<&str>,
) -> Result<AiMessage, String> {
    let msg = AiMessage {
        id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        role: role.to_string(),
        content: content.map(ToString::to_string),
        tool_call_id: None,
        tool_name: None,
        tool_args_json: None,
        created_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO ai_messages (id, conversation_id, role, content, tool_call_id, tool_name, tool_args_json, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5)",
        params![msg.id, msg.conversation_id, msg.role, msg.content, msg.created_at],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE ai_conversations SET updated_at = ?1 WHERE id = ?2",
        params![msg.created_at, conversation_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(msg)
}

fn ai_tool_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiToolRun> {
    Ok(AiToolRun {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        server_key: row.get(2)?,
        session_id: row.get(3)?,
        message_id: row.get(4)?,
        tool_call_id: row.get(5)?,
        tool_name: row.get(6)?,
        args_json: row.get(7)?,
        command: row.get(8)?,
        risk_level: row.get(9)?,
        approval_status: row.get(10)?,
        run_status: row.get(11)?,
        output: row.get(12)?,
        exit_code: row.get(13)?,
        started_at: row.get(14)?,
        completed_at: row.get(15)?,
        created_at: row.get(16)?,
    })
}

fn insert_ai_tool_run(
    conn: &Connection,
    conversation_id: &str,
    server_key: &str,
    session_id: Option<&str>,
    message_id: Option<&str>,
    tool_call_id: &str,
    tool_name: &str,
    args_json: &str,
    command: Option<&str>,
    risk_level: &str,
) -> Result<AiToolRun, String> {
    let run = AiToolRun {
        id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        server_key: server_key.to_string(),
        session_id: session_id.map(ToString::to_string),
        message_id: message_id.map(ToString::to_string),
        tool_call_id: tool_call_id.to_string(),
        tool_name: tool_name.to_string(),
        args_json: args_json.to_string(),
        command: command.map(ToString::to_string),
        risk_level: risk_level.to_string(),
        approval_status: "pending".to_string(),
        run_status: "pending".to_string(),
        output: None,
        exit_code: None,
        started_at: None,
        completed_at: None,
        created_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO ai_tool_runs
         (id, conversation_id, server_key, session_id, message_id, tool_call_id, tool_name,
          args_json, command, risk_level, approval_status, run_status, output, exit_code,
          started_at, completed_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, NULL, NULL, NULL, ?13)",
        params![
            run.id,
            run.conversation_id,
            run.server_key,
            run.session_id,
            run.message_id,
            run.tool_call_id,
            run.tool_name,
            run.args_json,
            run.command,
            run.risk_level,
            run.approval_status,
            run.run_status,
            run.created_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(run)
}

fn get_ai_tool_run(conn: &Connection, id: &str) -> Result<AiToolRun, String> {
    conn.query_row(
        "SELECT id, conversation_id, server_key, session_id, message_id, tool_call_id, tool_name,
                args_json, command, risk_level, approval_status, run_status, output, exit_code,
                started_at, completed_at, created_at
         FROM ai_tool_runs
         WHERE id = ?1",
        params![id],
        ai_tool_run_from_row,
    )
    .map_err(|e| e.to_string())
}

fn list_history_with_params<P>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<CommandHistoryEntry>, String>
where
    P: rusqlite::Params,
{
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params, |row| {
            Ok(CommandHistoryEntry {
                id: row.get(0)?,
                device_id: row.get(1)?,
                command: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn like_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len() + 2);
    escaped.push('%');
    for ch in query.chars() {
        match ch {
            '%' | '_' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped.push('%');
    escaped
}
