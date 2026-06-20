use async_trait::async_trait;
use russh::{client, ChannelMsg};
use russh_keys::{
    known_hosts, load_secret_key, parse_public_key_base64, ssh_key::PublicKey, HashAlg,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use uuid::Uuid;

pub type SessionStore = Arc<Mutex<HashMap<String, SessionHandle>>>;
pub type HostKeyPromptStore = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;
pub type SshSharedHandle = Arc<Mutex<client::Handle<ShellyHandler>>>;

pub struct SessionHandle {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub resize_tx: mpsc::Sender<(u32, u32)>,
    pub output: Arc<Mutex<String>>,
    pub command_records: Arc<Mutex<Vec<TerminalCommandRecord>>>,
    pub handle: SshSharedHandle,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandRecord {
    pub command_id: String,
    pub command: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
    pub exit_code: Option<i64>,
    pub output: String,
}

#[derive(Serialize, Clone)]
pub struct SshDataEvent {
    pub id: String,
    pub data: Vec<u8>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshClosedEvent {
    pub id: String,
    pub reason: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKeyPromptEvent {
    pub prompt_id: String,
    pub reason: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub known_hosts_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub line: usize,
    pub hosts: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: Option<String>,
    pub known_hosts_path: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStats {
    pub hostname: Option<String>,
    pub kernel: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub load_avg: Option<String>,
    pub mem_total_kb: Option<u64>,
    pub mem_available_kb: Option<u64>,
    pub swap_total_kb: Option<u64>,
    pub swap_free_kb: Option<u64>,
    pub disk_total_kb: Option<u64>,
    pub disk_available_kb: Option<u64>,
    pub disk_mount: Option<String>,
    pub collected_at: i64,
}

const OUTPUT_BUFFER_CHARS: usize = 160_000;
pub const SSH_CONNECT_TIMEOUT_SECS: u64 = 15;
const SSH_STATS_TIMEOUT_SECS: u64 = 8;
const HOST_KEY_PROMPT_TIMEOUT_SECS: u64 = 120;

pub struct ShellyHandler {
    host: String,
    port: u16,
    app: AppHandle,
    host_key_prompts: HostKeyPromptStore,
    known_hosts_path: PathBuf,
    unknown_host_key_policy: String,
    strict_host_key_checking: bool,
}

#[async_trait]
impl client::Handler for ShellyHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        match known_hosts::check_known_hosts_path(
            &self.host,
            self.port,
            key,
            &self.known_hosts_path,
        ) {
            Ok(true) => Ok(true),
            Ok(false) => {
                if self.unknown_host_key_policy == "reject" {
                    return Ok(false);
                }
                let prompt_id = Uuid::new_v4().to_string();
                let (tx, rx) = oneshot::channel();
                self.host_key_prompts
                    .lock()
                    .await
                    .insert(prompt_id.clone(), tx);

                let event = SshHostKeyPromptEvent {
                    prompt_id: prompt_id.clone(),
                    reason: "unknown".into(),
                    host: self.host.clone(),
                    port: self.port,
                    algorithm: key.algorithm().as_str().to_string(),
                    fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                    known_hosts_path: self.known_hosts_path.display().to_string(),
                };
                let _ = self.app.emit("ssh-host-key-prompt", event);

                let accepted = timeout(Duration::from_secs(HOST_KEY_PROMPT_TIMEOUT_SECS), rx)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or(false);
                self.host_key_prompts.lock().await.remove(&prompt_id);

                if !accepted {
                    return Ok(false);
                }
                if let Err(err) = known_hosts::learn_known_hosts_path(
                    &self.host,
                    self.port,
                    key,
                    &self.known_hosts_path,
                ) {
                    eprintln!("failed to write known_hosts: {err}");
                    return Ok(false);
                }
                Ok(true)
            }
            Err(err) => {
                if self.strict_host_key_checking {
                    eprintln!(
                        "host key check failed for {}:{} at {}: {err}",
                        self.host,
                        self.port,
                        self.known_hosts_path.display()
                    );
                    return Ok(false);
                }
                let prompt_id = Uuid::new_v4().to_string();
                let (tx, rx) = oneshot::channel();
                self.host_key_prompts
                    .lock()
                    .await
                    .insert(prompt_id.clone(), tx);

                let event = SshHostKeyPromptEvent {
                    prompt_id: prompt_id.clone(),
                    reason: "changed".into(),
                    host: self.host.clone(),
                    port: self.port,
                    algorithm: key.algorithm().as_str().to_string(),
                    fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                    known_hosts_path: self.known_hosts_path.display().to_string(),
                };
                let _ = self.app.emit("ssh-host-key-prompt", event);

                let accepted = timeout(Duration::from_secs(HOST_KEY_PROMPT_TIMEOUT_SECS), rx)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or(false);
                self.host_key_prompts.lock().await.remove(&prompt_id);

                if !accepted {
                    return Ok(false);
                }
                if let Err(remove_err) =
                    remove_known_host_entries(&self.host, self.port, &self.known_hosts_path)
                {
                    eprintln!("failed to remove changed known_hosts entry: {remove_err}");
                    return Ok(false);
                }
                if let Err(learn_err) = known_hosts::learn_known_hosts_path(
                    &self.host,
                    self.port,
                    key,
                    &self.known_hosts_path,
                ) {
                    eprintln!("failed to write changed known_hosts entry: {learn_err}");
                    return Ok(false);
                }
                eprintln!(
                    "host key changed for {}:{} at {}; user accepted replacement: {err}",
                    self.host,
                    self.port,
                    self.known_hosts_path.display()
                );
                Ok(true)
            }
        }
    }
}

#[tauri::command]
pub async fn ssh_connect(
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    auth_method: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    connect_timeout_secs: Option<u64>,
    keepalive_enabled: Option<bool>,
    keepalive_interval_secs: Option<u64>,
    keepalive_max_count: Option<u32>,
    unknown_host_key_policy: Option<String>,
    strict_host_key_checking: Option<bool>,
    sessions: State<'_, SessionStore>,
    host_key_prompts: State<'_, HostKeyPromptStore>,
    app: AppHandle,
) -> Result<String, String> {
    let connect_timeout_secs = connect_timeout_secs
        .unwrap_or(SSH_CONNECT_TIMEOUT_SECS)
        .clamp(3, 120);
    let keepalive_interval = keepalive_enabled
        .unwrap_or(true)
        .then(|| Duration::from_secs(keepalive_interval_secs.unwrap_or(30).clamp(5, 300)));
    let keepalive_max = keepalive_max_count.unwrap_or(3).clamp(1, 20) as usize;
    let unknown_host_key_policy = match unknown_host_key_policy.as_deref() {
        Some("reject") => "reject".to_string(),
        _ => "prompt".to_string(),
    };
    let config = Arc::new(client::Config {
        keepalive_interval,
        keepalive_max,
        ..Default::default()
    });
    let mut handle = timeout(
        Duration::from_secs(connect_timeout_secs),
        client::connect(
            config,
            (host.as_str(), port),
            ShellyHandler {
                host: host.clone(),
                port,
                app: app.clone(),
                host_key_prompts: host_key_prompts.inner().clone(),
                known_hosts_path: known_hosts_path(),
                unknown_host_key_policy,
                strict_host_key_checking: strict_host_key_checking.unwrap_or(true),
            },
        ),
    )
    .await
    .map_err(|_| format!("Connection timed out after {connect_timeout_secs}s"))?
    .map_err(format_ssh_error)?;

    let method = auth_method.unwrap_or_else(|| "password".into());
    let ok = if method == "privateKey" {
        let key_path = private_key_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| "Private key path is required".to_string())?;
        let key = load_secret_key(key_path, passphrase.as_deref())
            .map_err(|e| format!("Failed to load private key: {e}"))?;
        timeout(
            Duration::from_secs(connect_timeout_secs),
            handle.authenticate_publickey(&username, Arc::new(key)),
        )
        .await
        .map_err(|_| format!("Authentication timed out after {connect_timeout_secs}s"))?
        .map_err(format_ssh_error)?
    } else {
        let password = password
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Password is required".to_string())?;
        timeout(
            Duration::from_secs(connect_timeout_secs),
            handle.authenticate_password(&username, password),
        )
        .await
        .map_err(|_| format!("Authentication timed out after {connect_timeout_secs}s"))?
        .map_err(format_ssh_error)?
    };
    if !ok {
        return Err("Authentication failed".into());
    }

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(format_ssh_error)?;
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(format_ssh_error)?;
    channel
        .request_shell(false)
        .await
        .map_err(format_ssh_error)?;
    let ssh_handle: SshSharedHandle = Arc::new(Mutex::new(handle));

    let id = Uuid::new_v4().to_string();
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u32, u32)>(8);
    let output = Arc::new(Mutex::new(String::new()));
    let command_records = Arc::new(Mutex::new(Vec::new()));
    let sessions_for_task = sessions.inner().clone();

    let sid = id.clone();
    let output_for_task = output.clone();
    tokio::spawn(async move {
        let close_reason = loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        append_output(&output_for_task, data).await;
                        let _ = app.emit("ssh-data", SshDataEvent { id: sid.clone(), data: data.to_vec() });
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        append_output(&output_for_task, data).await;
                        let _ = app.emit("ssh-data", SshDataEvent { id: sid.clone(), data: data.to_vec() });
                    }
                    None => {
                        break "channel ended".to_string();
                    }
                    Some(ChannelMsg::Eof) => {
                        break "remote sent EOF".to_string();
                    }
                    Some(ChannelMsg::Close) => {
                        break "remote closed channel".to_string();
                    }
                    _ => {}
                },
                data = input_rx.recv() => match data {
                    Some(data) => {
                        if let Err(e) = channel.data(data.as_slice()).await {
                            break format!("write failed: {e}");
                        }
                    }
                    None => {
                        break "session handle dropped".to_string();
                    }
                },
                resize = resize_rx.recv() => match resize {
                    Some((cols, rows)) => {
                        if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                            break format!("resize failed: {e}");
                        }
                    }
                    None => {}
                }
            }
        };
        sessions_for_task.lock().await.remove(&sid);
        let _ = app.emit(
            "ssh-closed-detail",
            SshClosedEvent {
                id: sid.clone(),
                reason: close_reason,
            },
        );
        let _ = app.emit("ssh-closed", &sid);
    });

    sessions.lock().await.insert(
        id.clone(),
        SessionHandle {
            input_tx,
            resize_tx,
            output,
            command_records,
            handle: ssh_handle,
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn ssh_input(
    id: String,
    data: Vec<u8>,
    sessions: State<'_, SessionStore>,
) -> Result<(), String> {
    let tx = sessions
        .lock()
        .await
        .get(&id)
        .map(|s| s.input_tx.clone())
        .ok_or_else(|| format!("SSH session not found: {id}"))?;
    tx.send(data)
        .await
        .map_err(|_| format!("SSH session is closed: {id}"))
}

#[tauri::command]
pub async fn ssh_resize(
    id: String,
    cols: u32,
    rows: u32,
    sessions: State<'_, SessionStore>,
) -> Result<(), String> {
    let tx = sessions
        .lock()
        .await
        .get(&id)
        .map(|s| s.resize_tx.clone())
        .ok_or_else(|| format!("SSH session not found: {id}"))?;
    tx.send((cols, rows))
        .await
        .map_err(|_| format!("SSH session is closed: {id}"))
}

#[tauri::command]
pub async fn ssh_collect_device_stats(
    id: String,
    sessions: State<'_, SessionStore>,
) -> Result<DeviceStats, String> {
    let handle = sessions
        .lock()
        .await
        .get(&id)
        .map(|s| s.handle.clone())
        .ok_or_else(|| format!("SSH session not found: {id}"))?;
    timeout(Duration::from_secs(SSH_STATS_TIMEOUT_SECS), async move {
        let mut channel = {
            let h = handle.lock().await;
            h.channel_open_session()
                .await
                .map_err(|e| format!("failed to open stats channel: {e}"))?
        };
        channel
            .exec(false, DEVICE_STATS_COMMAND)
            .await
            .map_err(|e| format!("failed to run stats command: {e}"))?;

        let mut output = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    output.extend_from_slice(&data);
                    if output.len() > 64 * 1024 {
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        let text = String::from_utf8_lossy(&output);
        Ok(parse_device_stats(&text))
    })
    .await
    .map_err(|_| format!("Device stats timed out after {SSH_STATS_TIMEOUT_SECS}s"))?
}

#[tauri::command]
pub async fn ssh_disconnect(id: String, sessions: State<'_, SessionStore>) -> Result<(), String> {
    sessions.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn ssh_host_key_respond(
    prompt_id: String,
    accept: bool,
    host_key_prompts: State<'_, HostKeyPromptStore>,
) -> Result<(), String> {
    let tx = host_key_prompts.lock().await.remove(&prompt_id);
    if let Some(tx) = tx {
        let _ = tx.send(accept);
        Ok(())
    } else {
        Err("Host key prompt is no longer pending".into())
    }
}

#[tauri::command]
pub fn ssh_list_known_hosts(
    host: Option<String>,
    port: Option<u16>,
) -> Result<Vec<KnownHostEntry>, String> {
    let path = known_hosts_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    let entries = content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| parse_known_host_line(index + 1, line, &path))
        .filter(|entry| {
            if let Some(host) = host.as_deref() {
                known_host_hosts_match(&entry.hosts, host, port.unwrap_or(22))
            } else {
                true
            }
        })
        .collect();
    Ok(entries)
}

#[tauri::command]
pub fn ssh_remove_known_host(host: String, port: u16) -> Result<usize, String> {
    let path = known_hosts_path();
    remove_known_host_entries(&host, port, &path)
}

fn remove_known_host_entries(host: &str, port: u16, path: &PathBuf) -> Result<usize, String> {
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    let mut removed = 0usize;
    let mut kept = Vec::new();
    for line in content.lines() {
        let hosts = known_host_hosts_field(line);
        if hosts
            .as_deref()
            .map(|hosts| known_host_hosts_match(hosts, host, port))
            .unwrap_or(false)
        {
            removed += 1;
        } else {
            kept.push(line);
        }
    }
    if removed > 0 {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        let mut next = kept.join("\n");
        if !next.is_empty() {
            next.push('\n');
        }
        std::fs::write(&path, next)
            .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    }
    Ok(removed)
}

async fn append_output(output: &Arc<Mutex<String>>, data: &[u8]) {
    let text = String::from_utf8_lossy(data);
    let mut buf = output.lock().await;
    buf.push_str(&text);
    let len = buf.chars().count();
    if len > OUTPUT_BUFFER_CHARS {
        *buf = buf
            .chars()
            .skip(len.saturating_sub(OUTPUT_BUFFER_CHARS))
            .collect();
    }
}

pub fn format_ssh_error(error: impl std::fmt::Display) -> String {
    let raw = error.to_string();
    let lower = raw.to_lowercase();
    if lower.contains("authentication")
        || lower.contains("auth")
        || lower.contains("permission denied")
    {
        return format!("Authentication failed: {raw}");
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return format!("Connection timed out: {raw}");
    }
    if lower.contains("connection refused") {
        return format!("Connection refused: {raw}");
    }
    if lower.contains("no route to host")
        || lower.contains("network is unreachable")
        || lower.contains("host unreachable")
    {
        return format!("Network unreachable: {raw}");
    }
    if lower.contains("dns") || lower.contains("failed to lookup") || lower.contains("resolve") {
        return format!("Host lookup failed: {raw}");
    }
    raw
}

pub fn known_hosts_path() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join(".ssh")
        .join("known_hosts")
}

const DEVICE_STATS_COMMAND: &str = r#"sh -lc '
printf "hostname=%s\n" "$(hostname 2>/dev/null)"
printf "kernel=%s\n" "$(uname -srmo 2>/dev/null || uname -a 2>/dev/null)"
awk "/^MemTotal:/ {print \"mem_total_kb=\" \$2} /^MemAvailable:/ {print \"mem_available_kb=\" \$2} /^SwapTotal:/ {print \"swap_total_kb=\" \$2} /^SwapFree:/ {print \"swap_free_kb=\" \$2}" /proc/meminfo 2>/dev/null
awk "{print \"uptime_seconds=\" int(\$1)}" /proc/uptime 2>/dev/null
awk "{print \"load_avg=\" \$1 \" \" \$2 \" \" \$3}" /proc/loadavg 2>/dev/null
df -P -k / 2>/dev/null | awk "NR==2 {print \"disk_total_kb=\" \$2; print \"disk_available_kb=\" \$4; print \"disk_mount=\" \$6}"
' "#;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn parse_device_stats(text: &str) -> DeviceStats {
    let mut stats = DeviceStats {
        collected_at: now_ms(),
        ..Default::default()
    };
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "hostname" => stats.hostname = Some(value.to_string()),
            "kernel" => stats.kernel = Some(value.to_string()),
            "uptime_seconds" => stats.uptime_seconds = value.parse().ok(),
            "load_avg" => stats.load_avg = Some(value.to_string()),
            "mem_total_kb" => stats.mem_total_kb = value.parse().ok(),
            "mem_available_kb" => stats.mem_available_kb = value.parse().ok(),
            "swap_total_kb" => stats.swap_total_kb = value.parse().ok(),
            "swap_free_kb" => stats.swap_free_kb = value.parse().ok(),
            "disk_total_kb" => stats.disk_total_kb = value.parse().ok(),
            "disk_available_kb" => stats.disk_available_kb = value.parse().ok(),
            "disk_mount" => stats.disk_mount = Some(value.to_string()),
            _ => {}
        }
    }
    stats
}

fn parse_known_host_line(line_number: usize, line: &str, path: &PathBuf) -> Option<KnownHostEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    let offset = if parts.first().is_some_and(|part| part.starts_with('@')) {
        1
    } else {
        0
    };
    let hosts = *parts.get(offset)?;
    let algorithm = *parts.get(offset + 1)?;
    let key = *parts.get(offset + 2)?;
    let public_key = parse_public_key_base64(key).ok()?;
    let comment = if parts.len() > offset + 3 {
        Some(parts[offset + 3..].join(" "))
    } else {
        None
    };
    Some(KnownHostEntry {
        line: line_number,
        hosts: hosts.to_string(),
        algorithm: algorithm.to_string(),
        fingerprint: public_key.fingerprint(HashAlg::Sha256).to_string(),
        comment,
        known_hosts_path: path.display().to_string(),
    })
}

fn known_host_hosts_field(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    let offset = if parts.first().is_some_and(|part| part.starts_with('@')) {
        1
    } else {
        0
    };
    parts.get(offset).map(|value| value.to_string())
}

fn known_host_hosts_match(hosts: &str, host: &str, port: u16) -> bool {
    let bracketed = format!("[{host}]:{port}");
    hosts.split(',').any(|pattern| {
        let pattern = pattern.trim();
        pattern == bracketed || (port == 22 && pattern == host)
    })
}
