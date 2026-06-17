use crate::db::{AiMessage, AiProvider, Db};
use crate::ssh::SessionStore;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

const STATIC_SYSTEM_PROMPT: &str = r#"[Identity]
You are Shelly Agent, an SSH operations assistant embedded in Shelly, a desktop SSH client.
You are helping the user work inside the currently selected SSH connection. The user can see the main SSH terminal. You may inspect terminal context, explain what is happening, suggest commands, and request command execution through Shelly tools.
You are not running inside the remote server. You operate through Shelly's controlled tools and the user's visible SSH terminal.
Your job is to help the user understand, operate, and troubleshoot the connected machine efficiently while keeping the user in control.

[Working Style]
- Be concise, practical, and calm.
- Prefer direct operational help over long tutorials.
- Ask for clarification only when acting without it would be risky.
- Keep output easy to scan in a CLI-style transcript.
- When the user asks in Chinese, reply in Chinese unless code, commands, or protocol names are clearer in English.
- Prefer small, reversible diagnostic steps before changing system state.
- State assumptions when the current terminal context is incomplete.
- If tool output is incomplete, timed out, or interleaved with user input, say so plainly.

[Hard Rules]
- Never execute commands directly by yourself.
- Never claim that a command has run unless Shelly reports the tool result.
- Any command execution must go through exec_command and requires explicit user approval in the Shelly UI.
- Do not attempt to bypass approval, hide commands, run background persistence, or operate in a solo/autonomous mode.
- Destructive, privilege-changing, credential-related, network-disruptive, or data-exfiltration commands require extra caution and a clear explanation.
- Do not silently discard conversation history. If context is close to the model limit and Shelly suggests a new session, tell the user clearly.
- Do not present guesses about host identity, cwd, OS, command results, or file contents as facts. Use available context or tools.

[Tools]
Tool execution is not enabled in this chat-only phase. If a command should be run, explain the command and wait for Shelly to provide approval tooling in a later step."#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSendMessageInput {
    pub conversation_id: String,
    pub active_session_id: Option<String>,
    pub content: String,
    pub terminal_context: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub session_id: String,
    pub lines: Vec<String>,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiStatusEvent {
    conversation_id: String,
    status: String,
    message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiStreamChunkEvent {
    conversation_id: String,
    delta: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiErrorEvent {
    conversation_id: String,
    message: String,
}

#[tauri::command]
pub async fn ai_send_message(
    input: AiSendMessageInput,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<(), String> {
    let content = input.content.trim().to_string();
    if content.is_empty() {
        return Err("message is required".into());
    }

    emit_status(&app, &input.conversation_id, "saving", None);
    let conversation = db.ai_conversation(&input.conversation_id)?;
    db.append_ai_message(&input.conversation_id, "user", Some(&content))?;
    let mut messages = db.ai_messages(&input.conversation_id)?;
    let provider_id = conversation.provider_id.as_deref();
    let (provider, api_key) = match provider_id {
        Some(id) => {
            let selected = db.ai_provider_with_key(id)?;
            if selected.1.is_some() {
                selected
            } else {
                db.default_ai_provider_with_key().unwrap_or(selected)
            }
        }
        None => db.default_ai_provider_with_key()?,
    };
    let api_key = api_key.ok_or_else(|| {
        format!(
            "AI provider API key is not saved for '{}'. Open Settings and save the provider API key.",
            provider.name
        )
    })?;

    let prompt = build_prompt(
        &provider,
        &conversation.server_key,
        input.active_session_id.as_deref(),
        input.terminal_context.as_deref(),
        &messages,
    );
    let estimated_tokens = ((prompt.chars().count() as f64) / 4.0).ceil() as i64;
    db.touch_ai_conversation_tokens(&input.conversation_id, estimated_tokens)?;
    if estimated_tokens >= provider.context_window_tokens {
        return Err("Context is over the configured model limit. Create a new session or reduce context.".into());
    }
    if estimated_tokens >= provider.context_window_tokens * 9 / 10 {
        emit_status(
            &app,
            &input.conversation_id,
            "context_warning",
            Some("Context is close to the model limit. Creating a new session is recommended."),
        );
    }

    emit_status(&app, &input.conversation_id, "streaming", None);
    let result = match provider.api_kind.as_str() {
        "openai_responses" => stream_openai(&provider, &api_key, &prompt, &app, &input.conversation_id).await,
        "claude_messages" => stream_claude(&provider, &api_key, &prompt, &app, &input.conversation_id).await,
        other => Err(format!("unsupported provider api kind: {other}")),
    };

    match result {
        Ok(text) => {
            let assistant = db.append_ai_message(&input.conversation_id, "assistant", Some(&text))?;
            messages.push(assistant);
            emit_status(&app, &input.conversation_id, "done", None);
            Ok(())
        }
        Err(err) => {
            let _ = app.emit(
                "ai-error",
                AiErrorEvent {
                    conversation_id: input.conversation_id.clone(),
                    message: err.clone(),
                },
            );
            emit_status(&app, &input.conversation_id, "error", Some(&err));
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn ai_read_terminal(
    session_id: String,
    lines: Option<usize>,
    sessions: State<'_, SessionStore>,
) -> Result<TerminalSnapshot, String> {
    let output = {
        let guard = sessions.lock().await;
        guard
            .get(&session_id)
            .map(|session| session.output.clone())
            .ok_or_else(|| "SSH session is not connected".to_string())?
    };
    let text = output.lock().await.clone();
    let max_lines = lines.unwrap_or(120).clamp(1, 500);
    let lines = text
        .replace('\r', "")
        .lines()
        .rev()
        .take(max_lines)
        .map(strip_ansi)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let text = lines.join("\n");
    Ok(TerminalSnapshot {
        session_id,
        lines,
        text,
    })
}

fn emit_status(app: &AppHandle, conversation_id: &str, status: &str, message: Option<&str>) {
    let _ = app.emit(
        "ai-status",
        AiStatusEvent {
            conversation_id: conversation_id.to_string(),
            status: status.to_string(),
            message: message.map(ToString::to_string),
        },
    );
}

fn emit_delta(app: &AppHandle, conversation_id: &str, delta: &str) {
    if delta.is_empty() {
        return;
    }
    let _ = app.emit(
        "ai-stream-chunk",
        AiStreamChunkEvent {
            conversation_id: conversation_id.to_string(),
            delta: delta.to_string(),
        },
    );
}

fn build_prompt(
    provider: &AiProvider,
    server_key: &str,
    active_session_id: Option<&str>,
    terminal_context: Option<&str>,
    messages: &[AiMessage],
) -> String {
    let mut out = String::new();
    out.push_str(STATIC_SYSTEM_PROMPT);
    if let Some(extra) = provider.system_prompt.as_deref() {
        out.push_str("\n\n[Provider Custom Instructions]\n");
        out.push_str(extra);
    }
    out.push_str("\n\n## Current Session\n");
    out.push_str(&format!("- Server Key: {server_key}\n"));
    if let Some(active_session_id) = active_session_id {
        out.push_str(&format!("- Active Session ID: {active_session_id}\n"));
    }
    out.push_str("- Session details: stored in Shelly conversation snapshot when available.\n");
    if let Some(terminal_context) = terminal_context.filter(|v| !v.trim().is_empty()) {
        out.push_str("\n## Current Terminal Context\n");
        out.push_str(terminal_context);
        out.push('\n');
    }
    out.push_str("\n## Conversation\n");
    for msg in messages.iter().rev().take(40).collect::<Vec<_>>().into_iter().rev() {
        if let Some(content) = msg.content.as_deref() {
            out.push_str(&format!("\n{}:\n{}\n", msg.role, content));
        }
    }
    out
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if chars.peek() == Some(&'[') {
                let _ = chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

async fn stream_openai(
    provider: &AiProvider,
    api_key: &str,
    prompt: &str,
    app: &AppHandle,
    conversation_id: &str,
) -> Result<String, String> {
    let url = endpoint(&provider.base_url, "responses");
    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({
            "model": provider.model,
            "input": prompt,
            "stream": true,
            "temperature": provider.temperature,
            "max_output_tokens": provider.max_tokens
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("OpenAI request failed: {}", res.text().await.unwrap_or_default()));
    }
    stream_sse(res, app, conversation_id, parse_openai_delta).await
}

async fn stream_claude(
    provider: &AiProvider,
    api_key: &str,
    prompt: &str,
    app: &AppHandle,
    conversation_id: &str,
) -> Result<String, String> {
    let url = endpoint(&provider.base_url, "messages");
    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": provider.model,
            "max_tokens": provider.max_tokens,
            "temperature": provider.temperature,
            "stream": true,
            "messages": [{ "role": "user", "content": prompt }]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Claude request failed: {}", res.text().await.unwrap_or_default()));
    }
    stream_sse(res, app, conversation_id, parse_claude_delta).await
}

fn endpoint(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with(path) {
        base.to_string()
    } else {
        format!("{base}/{path}")
    }
}

async fn stream_sse<F>(
    res: reqwest::Response,
    app: &AppHandle,
    conversation_id: &str,
    parser: F,
) -> Result<String, String>
where
    F: Fn(&Value) -> Option<String>,
{
    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    let mut full = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buffer.find("\n\n") {
            let frame = buffer[..idx].to_string();
            buffer = buffer[idx + 2..].to_string();
            for line in frame.lines() {
                let line = line.trim();
                if !line.starts_with("data:") {
                    continue;
                }
                let data = line.trim_start_matches("data:").trim();
                if data == "[DONE]" || data.is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(data) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if let Some(delta) = parser(&value) {
                    emit_delta(app, conversation_id, &delta);
                    full.push_str(&delta);
                }
            }
        }
    }
    Ok(full)
}

fn parse_openai_delta(value: &Value) -> Option<String> {
    if value.get("type")?.as_str()? == "response.output_text.delta" {
        value.get("delta")?.as_str().map(ToString::to_string)
    } else {
        None
    }
}

fn parse_claude_delta(value: &Value) -> Option<String> {
    if value.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    let delta = value.get("delta")?;
    if delta.get("type")?.as_str()? == "text_delta" {
        delta.get("text")?.as_str().map(ToString::to_string)
    } else {
        None
    }
}
