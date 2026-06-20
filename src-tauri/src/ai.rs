use crate::db::{
    AiMessage, AiProvider, AiSessionSnapshot, AiToolRun, CommandHistoryEntry, Db,
    SaveSnippetInput, Snippet,
};
use crate::file_jobs::{list_remote_files_for_agent, RemoteFileEntry};
use crate::ssh::{SessionStore, TerminalCommandRecord};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration, Instant};

const TOOL_DISPLAY_OUTPUT_MAX_CHARS: usize = 80_000;
const TOOL_MODEL_OUTPUT_MAX_CHARS: usize = 12_000;
const TERMINAL_TAIL_DEFAULT_LINES: usize = 80;
const TERMINAL_TAIL_MAX_LINES: usize = 500;
const TERMINAL_TAIL_DEFAULT_MAX_CHARS: usize = 12_000;
const TERMINAL_TAIL_MAX_CHARS: usize = 50_000;
const TERMINAL_COMMAND_RECORD_LIMIT: usize = 50;
const TERMINAL_COMMAND_LIST_DEFAULT_LIMIT: usize = 20;
const TERMINAL_COMMAND_LIST_MAX_LIMIT: usize = 50;
const TERMINAL_COMMAND_PREVIEW_CHARS: usize = 600;
const TERMINAL_COMMAND_OUTPUT_DEFAULT_MAX_CHARS: usize = 20_000;
const TERMINAL_COMMAND_OUTPUT_MAX_CHARS: usize = 80_000;
const WEB_FETCH_DEFAULT_MAX_CHARS: usize = 20_000;
const WEB_FETCH_MAX_CHARS: usize = 80_000;
const WEB_FETCH_DEFAULT_TIMEOUT_SECS: u64 = 15;
const WEB_FETCH_MAX_TIMEOUT_SECS: u64 = 30;
const WEB_FETCH_MAX_BODY_BYTES: usize = 1_000_000;
const REMOTE_FILE_LIST_DEFAULT_LIMIT: usize = 100;
const REMOTE_FILE_LIST_MAX_LIMIT: usize = 500;
const COMMAND_HISTORY_DEFAULT_LIMIT: u32 = 20;
const COMMAND_HISTORY_MAX_LIMIT: u32 = 100;

const STATIC_SYSTEM_PROMPT: &str = r#"[Identity]
You are Shelly Agent, an SSH operations assistant embedded in Shelly, a desktop SSH client.
The product name is spelled exactly "Shelly".
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
- You can only request execution. The user decides whether the command is actually approved and run.
- Do not attempt to bypass approval, hide commands, run background persistence, or operate in a solo/autonomous mode.
- Destructive, privilege-changing, credential-related, network-disruptive, or data-exfiltration commands require extra caution and a clear explanation.
- Do not silently discard conversation history. If context is close to the model limit and Shelly suggests a new session, tell the user clearly.
- Do not present guesses about host identity, cwd, OS, command results, or file contents as facts. Use available context or tools.
- Never write, simulate, quote, or invent a tool result block in an assistant message. Only Shelly-generated tool messages may contain command output.
- Never turn a suggested command into an executed command in prose. If you did not receive a real tool result, say it is only a suggestion.

[Tools]
You have access to Shelly tools. Use read-only tools without asking for approval. Command execution always requires approval.
Users will not always name the tool they expect. Infer the user's intent and choose the smallest, read-only, safest tool that can answer the question before considering command execution.

read_terminal_tail(sessionId?, lines?, maxChars?)
- Purpose: read recent visible terminal context from the current SSH tab.
- Use it when the user's question depends on what is currently shown in the terminal, the latest command result, current prompt, cwd, or recent errors.
- If you only need the current terminal state or latest command result, call read_terminal_tail first.
- Do not ask the user to paste terminal output before trying read_terminal_tail.
- Do not assume terminal state, cwd, command output, or file contents from memory.
- Normal chat turns do not receive terminal history unless you explicitly call read_terminal_tail.

list_terminal_commands(sessionId?, limit?)
- Purpose: list recent command output records captured by Shelly Agent for the current SSH session.
- Use it when read_terminal_tail is insufficient, truncated, interleaved, or the user asks about a specific earlier command.
- Call read_terminal_tail first when you only need the latest visible output.
- The list contains command IDs, commands, status, exit code, output size, and short previews. It is an index, not full output.
- Current scope: this index only includes commands requested through exec_command and approved in Shelly Agent, plus completed interactive handoffs. It does not include arbitrary commands the user typed manually in the SSH terminal.

read_terminal_command_output(commandId, offset?, maxChars?, mode?)
- Purpose: read captured output for one Shelly Agent command by commandId.
- Use it after list_terminal_commands identifies the relevant commandId, or when the commandId is already present in the conversation or a previous tool result.
- Do not call it for arbitrary shell history. It only reads Shelly Agent captured command records.
- Supported modes are window, head, tail, and full. Output is still capped by Shelly safety limits.

web_fetch(url, maxChars?, timeoutSecs?)
- Purpose: fetch public web documentation or project pages and return cleaned text plus metadata.
- Use it when the user asks about public documentation, a GitHub project, Docker image, install guide, release note, API docs, or an error likely answered by current external docs.
- Prefer official or user-provided URLs.
- Do not use it for private URLs, credentials, local network addresses, or data exfiltration.
- Treat fetched content as external evidence. If extraction is truncated or noisy, say so.

get_session_info(sessionId?)
- Purpose: return Shelly's current known SSH session metadata and connection status without running remote commands.
- Use it when the user asks which server/session/device is active, or before command execution when the target session may be ambiguous.
- This is metadata from Shelly's connection state and latest session snapshot, not proof of remote command output.

list_remote_files(path, sessionId?, limit?)
- Purpose: list entries in a remote directory through Shelly's existing SFTP connection.
- Use it when the user asks about remote project structure, directory contents, or whether a path contains files, and a directory listing is enough.
- This is read-only metadata. It does not read file contents, upload, download, create, rename, or delete files.
- Do not use it for private key paths or credential directories unless the user explicitly asks and the request is safe to answer with names only.

search_command_history(query?, deviceId?, limit?)
- Purpose: search Shelly's local command history records.
- Use it when the user asks for a command they used before, wants to reuse a workflow, or asks for recent commands.
- This searches Shelly's saved local history, not the remote shell's full history file.

list_snippets(query?, limit?)
- Purpose: list or search Shelly snippets, which are user-defined long commands mapped to short names for quick terminal insertion.
- Use it when the user asks what snippets exist, wants to reuse a saved workflow, or asks about a shortcut command.
- This is read-only and returns local Shelly snippet metadata and command text.

write_snippet(name, command, id?, purpose?)
- Purpose: create or update one Shelly snippet.
- This writes local Shelly snippet data and requires user approval before saving.
- Use it when the user explicitly asks to save, create, update, or remember a reusable command shortcut.
- Do not use it to write remote files or execute commands.

exec_command(cmd, purpose)
- Purpose: request approval to write a command into the user's visible SSH terminal.
Shelly will show the command to the user for approval before anything is written to the visible SSH terminal.
Only request exec_command when running a command is necessary. Prefer one clear command at a time, and explain the purpose briefly.
If you say you are going to run, check, test, inspect, or try a command, you must call exec_command in that same response. Do not merely announce the next command in prose.
If you cannot or do not call exec_command, phrase commands as suggestions for the user, such as "you can run..." or "I suggest running...".
Do not request another command until the current approval-sensitive command has a tool result, unless the user explicitly asks for batch execution.
Interactive commands that wait for stdin or take over the terminal, such as cat with no input file, read, passwd, vi/vim/nano, top/htop, less/more, ssh/sftp, bare shells, REPLs, or tail -f, require user handoff. If you request one, include interaction_tip explaining what the user may see and how to proceed safely. After requesting an interactive command, wait for the interactive handoff result before requesting any next command. Shelly Agent will not type follow-up input for the user.

[Result Interpretation]
- Summaries must be based only on real Shelly tool results or visible terminal context.
- Distinguish the final shell exit code reported by the tool from command-internal failures, failed branches in &&/|| chains, pipeline behavior, stderr text, and your own inference.
- If output is long, truncated, timed out, or may be interleaved with user input, state that limitation before drawing conclusions."#;

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
    pub truncated: bool,
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
struct AiStreamResetEvent {
    conversation_id: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiErrorEvent {
    conversation_id: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiToolApprovalEvent {
    conversation_id: String,
    tool_run_id: String,
    tool_call_id: String,
    tool_name: String,
    server_key: String,
    session_id: Option<String>,
    args_json: String,
    command: Option<String>,
    purpose: Option<String>,
    interaction_tip: Option<String>,
    risk_level: String,
    risk_reasons: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiToolDecisionInput {
    pub tool_run_id: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiExecuteToolInput {
    pub tool_run_id: String,
    pub active_session_id: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiCompleteInteractiveToolInput {
    pub tool_run_id: String,
    pub active_session_id: String,
    pub output: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SnippetUpdatedEvent {
    id: String,
    name: String,
    command: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiToolStartedEvent {
    conversation_id: String,
    tool_run_id: String,
    command: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiToolOutputEvent {
    conversation_id: String,
    tool_run_id: String,
    output: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiToolResultEvent {
    conversation_id: String,
    tool_run_id: String,
    run_status: String,
    output: String,
    timed_out: bool,
}

#[derive(Debug, Clone)]
struct AgentToolCall {
    id: String,
    name: String,
    args_json: String,
}

#[derive(Debug, Default)]
struct AgentStreamResult {
    text: String,
    tool_calls: Vec<AgentToolCall>,
}

#[derive(Debug, Clone)]
struct AgentPromptMessage {
    role: String,
    content: String,
}

#[derive(Debug, Clone)]
struct AgentPrompt {
    system: String,
    context: String,
    messages: Vec<AgentPromptMessage>,
}

impl AgentPrompt {
    fn estimated_chars(&self) -> usize {
        self.system.chars().count()
            + self.context.chars().count()
            + self
                .messages
                .iter()
                .map(|msg| msg.role.chars().count() + msg.content.chars().count())
                .sum::<usize>()
    }
}

#[tauri::command]
pub async fn ai_send_message(
    input: AiSendMessageInput,
    db: State<'_, Db>,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<(), String> {
    let content = input.content.trim().to_string();
    if content.is_empty() {
        return Err("message is required".into());
    }

    emit_status(&app, &input.conversation_id, "saving", None);
    let conversation = db.ai_conversation(&input.conversation_id)?;
    db.append_ai_message(&input.conversation_id, "user", Some(&content))?;
    run_agent_turn(
        &db,
        &app,
        &conversation,
        input.active_session_id.as_deref(),
        input.terminal_context.as_deref(),
        sessions.inner().clone(),
    )
    .await
}

#[tauri::command]
pub async fn ai_read_terminal(
    session_id: String,
    lines: Option<usize>,
    sessions: State<'_, SessionStore>,
) -> Result<TerminalSnapshot, String> {
    read_terminal_tail_snapshot(sessions.inner(), &session_id, lines, None).await
}

async fn read_terminal_tail_snapshot(
    sessions: &SessionStore,
    session_id: &str,
    lines: Option<usize>,
    max_chars: Option<usize>,
) -> Result<TerminalSnapshot, String> {
    let output = {
        let guard = sessions.lock().await;
        guard
            .get(session_id)
            .map(|session| session.output.clone())
            .ok_or_else(|| "SSH session is not connected".to_string())?
    };
    let text = output.lock().await.clone();
    let max_lines = lines
        .unwrap_or(TERMINAL_TAIL_DEFAULT_LINES)
        .clamp(1, TERMINAL_TAIL_MAX_LINES);
    let max_chars = max_chars
        .unwrap_or(TERMINAL_TAIL_DEFAULT_MAX_CHARS)
        .clamp(1_000, TERMINAL_TAIL_MAX_CHARS);
    let all_lines = text
        .replace('\r', "")
        .lines()
        .map(strip_ansi)
        .collect::<Vec<_>>();
    let mut truncated = all_lines.len() > max_lines;
    let mut lines = all_lines
        .iter()
        .rev()
        .take(max_lines)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let mut text = lines.join("\n");
    let char_count = text.chars().count();
    if char_count > max_chars {
        truncated = true;
        text = text
            .chars()
            .skip(char_count.saturating_sub(max_chars))
            .collect::<String>();
        lines = text.lines().map(ToString::to_string).collect();
    }
    Ok(TerminalSnapshot {
        session_id: session_id.to_string(),
        lines,
        text,
        truncated,
    })
}

async fn run_agent_turn(
    db: &Db,
    app: &AppHandle,
    conversation: &crate::db::AiConversation,
    active_session_id: Option<&str>,
    terminal_context: Option<&str>,
    sessions: SessionStore,
) -> Result<(), String> {
    let mut messages = db.ai_messages(&conversation.id)?;
    let (provider, api_key) = select_provider_with_key(db, conversation)?;
    let latest_snapshot = db
        .latest_ai_session_snapshot(&conversation.id)
        .ok()
        .flatten();

    let prompt = build_prompt(
        &provider,
        &conversation.server_key,
        active_session_id,
        terminal_context,
        latest_snapshot.as_ref(),
        &messages,
    );
    let estimated_tokens = ((prompt.estimated_chars() as f64) / 4.0).ceil() as i64;
    db.touch_ai_conversation_tokens(&conversation.id, estimated_tokens)?;
    if estimated_tokens >= provider.context_window_tokens {
        return Err(
            "Context is over the configured model limit. Create a new session or reduce context."
                .into(),
        );
    }
    if estimated_tokens >= provider.context_window_tokens * 9 / 10 {
        emit_status(
            app,
            &conversation.id,
            "context_warning",
            Some("Context is close to the model limit. Creating a new session is recommended."),
        );
    }

    emit_status(app, &conversation.id, "streaming", None);
    let result = match provider.api_kind.as_str() {
        "openai_responses" => {
            stream_openai(&provider, &api_key, &prompt, app, &conversation.id).await
        }
        "claude_messages" => {
            stream_claude(&provider, &api_key, &prompt, app, &conversation.id).await
        }
        other => Err(format!("unsupported provider api kind: {other}")),
    };

    match result {
        Ok(stream) => {
            if stream.tool_calls.is_empty() && looks_like_fake_tool_result(&stream.text) {
                let guard_message = "Model attempted to write a tool result as assistant text. Shelly ignored that text and is retrying with a real exec_command request.";
                let _ = app.emit(
                    "ai-stream-reset",
                    AiStreamResetEvent {
                        conversation_id: conversation.id.clone(),
                        message: guard_message.to_string(),
                    },
                );
                if !last_message_is_fake_tool_reprompt(&messages) {
                    db.append_ai_message(
                        &conversation.id,
                        "user",
                        Some("Shelly internal safety note: You wrote or simulated a tool result in assistant text. That is not allowed. If a command result is needed, call exec_command now and wait for Shelly's real tool result. If no command is needed, answer without any tool/result block."),
                    )?;
                    emit_status(
                        app,
                        &conversation.id,
                        "streaming",
                        Some("retrying fake tool result"),
                    );
                    return Box::pin(run_agent_turn(
                        db,
                        app,
                        conversation,
                        active_session_id,
                        terminal_context,
                        sessions.clone(),
                    ))
                    .await;
                }
                emit_status(app, &conversation.id, "error", Some(guard_message));
                return Ok(());
            }
            let assistant = if stream.text.trim().is_empty() {
                None
            } else {
                let assistant =
                    db.append_ai_message(&conversation.id, "assistant", Some(&stream.text))?;
                messages.push(assistant.clone());
                Some(assistant)
            };
            if stream.tool_calls.is_empty() {
                if should_reprompt_for_missing_tool(&stream.text)
                    && !last_message_is_tool_reprompt(&messages)
                {
                    db.append_ai_message(
                        &conversation.id,
                        "user",
                        Some("Shelly internal note: You said you would run or try another command, but no exec_command tool call was emitted. If a command is needed, call exec_command now with the exact command. If no command is needed, continue with a direct answer and do not say you will run one."),
                    )?;
                    emit_status(
                        app,
                        &conversation.id,
                        "streaming",
                        Some("retrying tool request"),
                    );
                    return Box::pin(run_agent_turn(
                        db,
                        app,
                        conversation,
                        active_session_id,
                        terminal_context,
                        sessions.clone(),
                    ))
                    .await;
                }
                emit_status(app, &conversation.id, "done", None);
                return Ok(());
            }
            let mut approval_count = 0;
            let mut completed_without_approval = 0;
            for call in stream.tool_calls {
                if call.name == "read_terminal_tail" {
                    let tool_message =
                        execute_read_terminal_tail_tool(&call, active_session_id, sessions.clone())
                            .await;
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                if call.name == "list_terminal_commands" {
                    let tool_message = execute_list_terminal_commands_tool(
                        &call,
                        active_session_id,
                        sessions.clone(),
                    )
                    .await;
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                if call.name == "read_terminal_command_output" {
                    let tool_message =
                        execute_read_terminal_command_output_tool(&call, sessions.clone()).await;
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                if call.name == "web_fetch" {
                    let tool_message = execute_web_fetch_tool(&call).await;
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                if call.name == "get_session_info" {
                    let tool_message = execute_get_session_info_tool(
                        &call,
                        active_session_id,
                        latest_snapshot.as_ref(),
                        sessions.clone(),
                    )
                    .await;
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                if call.name == "list_remote_files" {
                    let tool_message =
                        execute_list_remote_files_tool(&call, active_session_id, sessions.clone())
                            .await;
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                if call.name == "search_command_history" {
                    let tool_message = execute_search_command_history_tool(
                        &call,
                        latest_snapshot.as_ref(),
                        db,
                    );
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                if call.name == "list_snippets" {
                    let tool_message = execute_list_snippets_tool(&call, db);
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                if call.name == "write_snippet" {
                    let parsed = parse_write_snippet_args(&call.args_json)?;
                    let tool_run = db.create_ai_tool_run(
                        &conversation.id,
                        &conversation.server_key,
                        active_session_id,
                        assistant.as_ref().map(|msg| msg.id.as_str()),
                        &call.id,
                        &call.name,
                        &call.args_json,
                        Some(&format!("write_snippet /{}\n{}", parsed.name, parsed.command)),
                        "medium",
                    )?;
                    emit_tool_approval(
                        app,
                        &conversation.server_key,
                        active_session_id,
                        &tool_run,
                        parsed.purpose.as_deref(),
                        None,
                        vec!["writes local Shelly snippet data".to_string()],
                    );
                    approval_count += 1;
                    continue;
                }
                if call.name != "exec_command" {
                    let note = format!("Model requested unsupported tool '{}'.", call.name);
                    let _ = db.append_ai_message(&conversation.id, "assistant", Some(&note));
                    emit_status(app, &conversation.id, "error", Some(&note));
                    continue;
                }
                let parsed = parse_exec_command_args(&call.args_json)?;
                let risk = analyze_command_risk(&parsed.cmd);
                let risk_reasons = risk.reasons.clone();
                let tool_run = db.create_ai_tool_run(
                    &conversation.id,
                    &conversation.server_key,
                    active_session_id,
                    assistant.as_ref().map(|msg| msg.id.as_str()),
                    &call.id,
                    &call.name,
                    &call.args_json,
                    Some(&parsed.cmd),
                    &risk.level,
                )?;
                emit_tool_approval(
                    app,
                    &conversation.server_key,
                    active_session_id,
                    &tool_run,
                    parsed.purpose.as_deref(),
                    parsed.interaction_tip.as_deref(),
                    risk_reasons.clone(),
                );
                if risk.level == "blocked" {
                    let blocked_output = format!(
                        "Shelly blocked this command before execution: {}",
                        risk_reasons.join("; ")
                    );
                    let blocked =
                        db.finish_ai_tool_run(&tool_run.id, "blocked", &blocked_output, None)?;
                    let _ = app.emit(
                        "ai-tool-result",
                        AiToolResultEvent {
                            conversation_id: blocked.conversation_id.clone(),
                            tool_run_id: blocked.id.clone(),
                            run_status: blocked.run_status.clone(),
                            output: blocked_output.clone(),
                            timed_out: false,
                        },
                    );
                    let tool_message = format_tool_result_message(&blocked, &parsed.cmd);
                    db.append_ai_message(&conversation.id, "tool", Some(&tool_message))?;
                    completed_without_approval += 1;
                    continue;
                }
                approval_count += 1;
            }
            if approval_count > 0 {
                emit_status(app, &conversation.id, "waiting_approval", None);
            } else if completed_without_approval > 0 {
                emit_status(
                    app,
                    &conversation.id,
                    "streaming",
                    Some("continuing after tool result"),
                );
                return Box::pin(run_agent_turn(
                    db,
                    app,
                    conversation,
                    active_session_id,
                    terminal_context,
                    sessions.clone(),
                ))
                .await;
            } else {
                emit_status(app, &conversation.id, "done", None);
            }
            Ok(())
        }
        Err(err) => {
            let _ = app.emit(
                "ai-error",
                AiErrorEvent {
                    conversation_id: conversation.id.clone(),
                    message: err.clone(),
                },
            );
            emit_status(app, &conversation.id, "error", Some(&err));
            Err(err)
        }
    }
}

fn select_provider_with_key(
    db: &Db,
    conversation: &crate::db::AiConversation,
) -> Result<(AiProvider, String), String> {
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
    Ok((provider, api_key))
}

#[tauri::command]
pub fn ai_approve_tool(input: AiToolDecisionInput, db: State<'_, Db>) -> Result<AiToolRun, String> {
    db.set_ai_tool_approval(&input.tool_run_id, "approved")
}

#[tauri::command]
pub async fn ai_deny_tool(
    input: AiToolDecisionInput,
    db: State<'_, Db>,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<AiToolRun, String> {
    let denied = db.set_ai_tool_approval(&input.tool_run_id, "denied")?;
    let command = denied
        .command
        .clone()
        .unwrap_or_else(|| denied.args_json.clone());
    let output =
        "User denied this command before execution. No command was written to the SSH terminal.";
    let finished = db.finish_ai_tool_run(&denied.id, "denied", output, None)?;
    let _ = app.emit(
        "ai-tool-result",
        AiToolResultEvent {
            conversation_id: finished.conversation_id.clone(),
            tool_run_id: finished.id.clone(),
            run_status: finished.run_status.clone(),
            output: output.to_string(),
            timed_out: false,
        },
    );
    let tool_message = format_tool_result_message(&finished, &command);
    db.append_ai_message(&finished.conversation_id, "tool", Some(&tool_message))?;
    let conversation = db.ai_conversation(&finished.conversation_id)?;
    let _ = run_agent_turn(
        &db,
        &app,
        &conversation,
        finished.session_id.as_deref(),
        None,
        sessions.inner().clone(),
    )
    .await;
    Ok(finished)
}

#[tauri::command]
pub async fn ai_execute_approved_tool(
    input: AiExecuteToolInput,
    db: State<'_, Db>,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<AiToolRun, String> {
    let run = db.ai_tool_run(&input.tool_run_id)?;
    if run.tool_name == "write_snippet" {
        return execute_approved_write_snippet_tool(input, db, sessions, app).await;
    }
    if run.tool_name != "exec_command" {
        return Err(format!("unsupported tool: {}", run.tool_name));
    }
    if run.approval_status != "approved" {
        return Err("tool run is not approved by the user".into());
    }
    if run.risk_level == "interactive" {
        return Err("This command needs an interactive handoff. Shelly Agent will not run it through the non-interactive executor.".into());
    }
    let command = run
        .command
        .clone()
        .ok_or_else(|| "tool run has no command".to_string())?;
    if analyze_command_risk(&command).level == "interactive" {
        return Err("This command needs an interactive handoff. Shelly Agent will not run it through the non-interactive executor.".into());
    }
    let marker = marker_for_tool_run(&run.id);
    let wrapped_command = wrap_command_with_marker(&command, &marker);
    let started_at = unix_time_ms();
    let (input_tx, output, command_records, before_len) = {
        let guard = sessions.lock().await;
        let session = guard
            .get(&input.active_session_id)
            .ok_or_else(|| "SSH session is not connected".to_string())?;
        let before = session.output.lock().await.clone();
        (
            session.input_tx.clone(),
            session.output.clone(),
            session.command_records.clone(),
            before.len(),
        )
    };
    input_tx
        .send(wrapped_command.into_bytes())
        .await
        .map_err(|e| e.to_string())?;

    let started = db.start_ai_tool_run(&input.tool_run_id, &input.active_session_id)?;
    emit_status(&app, &started.conversation_id, "executing_tool", None);
    let _ = app.emit(
        "ai-tool-started",
        AiToolStartedEvent {
            conversation_id: started.conversation_id.clone(),
            tool_run_id: started.id.clone(),
            command: command.clone(),
        },
    );

    let captured = capture_command_output(output, before_len, &marker).await;
    let cleaned = trim_tool_output(&strip_ansi(&captured.output), TOOL_DISPLAY_OUTPUT_MAX_CHARS);
    let run_status = if captured.timed_out {
        "timeout"
    } else {
        "completed"
    };
    let finished =
        db.finish_ai_tool_run(&input.tool_run_id, run_status, &cleaned, captured.exit_code)?;
    push_terminal_command_record(
        command_records,
        TerminalCommandRecord {
            command_id: finished.id.clone(),
            command: command.clone(),
            started_at,
            ended_at: Some(unix_time_ms()),
            status: finished.run_status.clone(),
            exit_code: finished.exit_code,
            output: cleaned.clone(),
        },
    )
    .await;
    let _ = app.emit(
        "ai-tool-output",
        AiToolOutputEvent {
            conversation_id: finished.conversation_id.clone(),
            tool_run_id: finished.id.clone(),
            output: cleaned.clone(),
        },
    );
    let _ = app.emit(
        "ai-tool-result",
        AiToolResultEvent {
            conversation_id: finished.conversation_id.clone(),
            tool_run_id: finished.id.clone(),
            run_status: finished.run_status.clone(),
            output: cleaned,
            timed_out: captured.timed_out,
        },
    );
    let tool_message = format_tool_result_message(&finished, &command);
    db.append_ai_message(&finished.conversation_id, "tool", Some(&tool_message))?;
    let conversation = db.ai_conversation(&finished.conversation_id)?;
    let _ = run_agent_turn(
        &db,
        &app,
        &conversation,
        Some(&input.active_session_id),
        None,
        sessions.inner().clone(),
    )
    .await;
    Ok(finished)
}

#[tauri::command]
pub async fn ai_complete_interactive_tool(
    input: AiCompleteInteractiveToolInput,
    db: State<'_, Db>,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<AiToolRun, String> {
    let run = db.ai_tool_run(&input.tool_run_id)?;
    if run.tool_name != "exec_command" {
        return Err(format!("unsupported tool: {}", run.tool_name));
    }
    if run.approval_status != "approved" {
        return Err("interactive tool run is not approved by the user".into());
    }
    if run.risk_level != "interactive" {
        return Err(
            "Only interactive tool runs can be completed with an interactive handoff result."
                .into(),
        );
    }
    let command = run
        .command
        .clone()
        .ok_or_else(|| "tool run has no command".to_string())?;
    let cleaned = trim_tool_output(&strip_ansi(&input.output), TOOL_DISPLAY_OUTPUT_MAX_CHARS);
    let output = if cleaned.trim().is_empty() {
        "Interactive handoff completed by user. No terminal output was captured.".to_string()
    } else {
        format!("Interactive handoff completed by user.\n{}", cleaned)
    };

    let finished = db.finish_ai_tool_run(&input.tool_run_id, "completed", &output, None)?;
    if let Some(command_records) =
        terminal_command_records_for_session(&sessions, &input.active_session_id).await
    {
        push_terminal_command_record(
            command_records,
            TerminalCommandRecord {
                command_id: finished.id.clone(),
                command: command.clone(),
                started_at: finished.started_at.unwrap_or_else(unix_time_ms),
                ended_at: Some(unix_time_ms()),
                status: finished.run_status.clone(),
                exit_code: finished.exit_code,
                output: output.clone(),
            },
        )
        .await;
    }
    let _ = app.emit(
        "ai-tool-output",
        AiToolOutputEvent {
            conversation_id: finished.conversation_id.clone(),
            tool_run_id: finished.id.clone(),
            output: output.clone(),
        },
    );
    let _ = app.emit(
        "ai-tool-result",
        AiToolResultEvent {
            conversation_id: finished.conversation_id.clone(),
            tool_run_id: finished.id.clone(),
            run_status: finished.run_status.clone(),
            output,
            timed_out: false,
        },
    );
    let tool_message = format_tool_result_message(&finished, &command);
    db.append_ai_message(&finished.conversation_id, "tool", Some(&tool_message))?;
    let conversation = db.ai_conversation(&finished.conversation_id)?;
    let _ = run_agent_turn(
        &db,
        &app,
        &conversation,
        Some(&input.active_session_id),
        None,
        sessions.inner().clone(),
    )
    .await;
    Ok(finished)
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

fn looks_like_fake_tool_result(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    let has_tool_result = normalized.contains("tool result for exec_command")
        || normalized.contains("tool:\ntool result")
        || normalized.contains("tool:\r\ntool result")
        || normalized.contains("status: completed\nexit_code:")
        || normalized.contains("status: completed\r\nexit_code:");
    let has_command_output_shape = normalized.contains("\ncommand:")
        || normalized.contains("\noutput:")
        || normalized.contains("\nexit_code:");
    has_tool_result && has_command_output_shape
}

fn last_message_is_fake_tool_reprompt(messages: &[AiMessage]) -> bool {
    messages
        .last()
        .and_then(|msg| msg.content.as_deref())
        .is_some_and(|content| {
            content.starts_with("Shelly internal safety note: You wrote or simulated")
        })
}

fn emit_tool_approval(
    app: &AppHandle,
    server_key: &str,
    session_id: Option<&str>,
    tool_run: &AiToolRun,
    purpose: Option<&str>,
    interaction_tip: Option<&str>,
    risk_reasons: Vec<String>,
) {
    let _ = app.emit(
        "ai-tool-approval",
        AiToolApprovalEvent {
            conversation_id: tool_run.conversation_id.clone(),
            tool_run_id: tool_run.id.clone(),
            tool_call_id: tool_run.tool_call_id.clone(),
            tool_name: tool_run.tool_name.clone(),
            server_key: server_key.to_string(),
            session_id: session_id.map(ToString::to_string),
            args_json: tool_run.args_json.clone(),
            command: tool_run.command.clone(),
            purpose: purpose.map(ToString::to_string),
            interaction_tip: interaction_tip.map(ToString::to_string),
            risk_level: tool_run.risk_level.clone(),
            risk_reasons,
        },
    );
}

#[derive(Debug)]
struct ExecCommandArgs {
    cmd: String,
    purpose: Option<String>,
    interaction_tip: Option<String>,
}

fn parse_exec_command_args(args_json: &str) -> Result<ExecCommandArgs, String> {
    let value: Value = serde_json::from_str(args_json)
        .map_err(|e| format!("invalid exec_command arguments: {e}"))?;
    let cmd = value
        .get("cmd")
        .or_else(|| value.get("command"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "exec_command requires a non-empty cmd".to_string())?
        .to_string();
    let purpose = value
        .get("purpose")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let interaction_tip = value
        .get("interaction_tip")
        .or_else(|| value.get("interactionTip"))
        .or_else(|| value.get("tip"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    Ok(ExecCommandArgs {
        cmd,
        purpose,
        interaction_tip,
    })
}

async fn execute_read_terminal_tail_tool(
    call: &AgentToolCall,
    active_session_id: Option<&str>,
    sessions: SessionStore,
) -> String {
    match parse_read_terminal_tail_args(&call.args_json, active_session_id) {
        Ok(args) => match read_terminal_tail_snapshot(
            &sessions,
            &args.session_id,
            args.lines,
            args.max_chars,
        )
        .await
        {
            Ok(snapshot) => format!(
                "Tool result for read_terminal_tail\nstatus: completed\nsession_id: {}\nline_count: {}\ntruncated: {}\ntext:\n{}",
                snapshot.session_id,
                snapshot.lines.len(),
                snapshot.truncated,
                snapshot.text
            ),
            Err(err) => format!(
                "Tool result for read_terminal_tail\nstatus: error\nerror: {}",
                err
            ),
        },
        Err(err) => format!(
            "Tool result for read_terminal_tail\nstatus: error\nerror: {}",
            err
        ),
    }
}

struct ReadTerminalTailArgs {
    session_id: String,
    lines: Option<usize>,
    max_chars: Option<usize>,
}

fn parse_read_terminal_tail_args(
    args_json: &str,
    active_session_id: Option<&str>,
) -> Result<ReadTerminalTailArgs, String> {
    let value: Value = if args_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(args_json)
            .map_err(|e| format!("invalid read_terminal_tail arguments: {e}"))?
    };
    let session_id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .or_else(|| active_session_id.map(ToString::to_string))
        .ok_or_else(|| "read_terminal_tail requires an active SSH session".to_string())?;
    let lines = value
        .get("lines")
        .and_then(Value::as_u64)
        .map(|v| v as usize);
    let max_chars = value
        .get("maxChars")
        .or_else(|| value.get("max_chars"))
        .and_then(Value::as_u64)
        .map(|v| v as usize);
    Ok(ReadTerminalTailArgs {
        session_id,
        lines,
        max_chars,
    })
}

async fn execute_list_terminal_commands_tool(
    call: &AgentToolCall,
    active_session_id: Option<&str>,
    sessions: SessionStore,
) -> String {
    match parse_list_terminal_commands_args(&call.args_json, active_session_id) {
        Ok(args) => match terminal_command_records_for_session(&sessions, &args.session_id).await {
            Some(command_records) => {
                let records = command_records.lock().await;
                let commands = records
                    .iter()
                    .rev()
                    .take(args.limit)
                    .map(command_record_summary)
                    .collect::<Vec<_>>();
                let commands = commands.into_iter().rev().collect::<Vec<_>>();
                format!(
                    "Tool result for list_terminal_commands\nstatus: completed\nscope: shelly_agent_approved_commands_only\nsession_id: {}\ncommands:\n{}",
                    args.session_id,
                    serde_json::to_string_pretty(&commands).unwrap_or_else(|_| "[]".to_string())
                )
            }
            None => format!(
                "Tool result for list_terminal_commands\nstatus: error\nerror: SSH session is not connected"
            ),
        },
        Err(err) => format!(
            "Tool result for list_terminal_commands\nstatus: error\nerror: {}",
            err
        ),
    }
}

struct ListTerminalCommandsArgs {
    session_id: String,
    limit: usize,
}

fn parse_list_terminal_commands_args(
    args_json: &str,
    active_session_id: Option<&str>,
) -> Result<ListTerminalCommandsArgs, String> {
    let value: Value = if args_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(args_json)
            .map_err(|e| format!("invalid list_terminal_commands arguments: {e}"))?
    };
    let session_id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .or_else(|| active_session_id.map(ToString::to_string))
        .ok_or_else(|| "list_terminal_commands requires an active SSH session".to_string())?;
    let limit = value
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(TERMINAL_COMMAND_LIST_DEFAULT_LIMIT)
        .clamp(1, TERMINAL_COMMAND_LIST_MAX_LIMIT);
    Ok(ListTerminalCommandsArgs { session_id, limit })
}

fn command_record_summary(record: &TerminalCommandRecord) -> Value {
    let clean_output = clean_captured_output(&record.output);
    let output_chars = clean_output.chars().count();
    let output_lines = clean_output.lines().count();
    json!({
        "commandId": record.command_id,
        "command": record.command,
        "startedAt": record.started_at,
        "endedAt": record.ended_at,
        "status": record.status,
        "exitCode": record.exit_code,
        "outputChars": output_chars,
        "outputLines": output_lines,
        "preview": preview_text(&clean_output, TERMINAL_COMMAND_PREVIEW_CHARS)
    })
}

fn preview_text(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.trim().to_string();
    }
    let tail = text
        .chars()
        .skip(count.saturating_sub(max_chars))
        .collect::<String>();
    format!(
        "[preview truncated to last {max_chars} chars]\n{}",
        tail.trim()
    )
}

async fn terminal_command_records_for_session(
    sessions: &SessionStore,
    session_id: &str,
) -> Option<Arc<Mutex<Vec<TerminalCommandRecord>>>> {
    let guard = sessions.lock().await;
    guard
        .get(session_id)
        .map(|session| session.command_records.clone())
}

async fn push_terminal_command_record(
    command_records: Arc<Mutex<Vec<TerminalCommandRecord>>>,
    record: TerminalCommandRecord,
) {
    let mut records = command_records.lock().await;
    records.push(record);
    let overflow = records.len().saturating_sub(TERMINAL_COMMAND_RECORD_LIMIT);
    if overflow > 0 {
        records.drain(0..overflow);
    }
}

async fn execute_read_terminal_command_output_tool(
    call: &AgentToolCall,
    sessions: SessionStore,
) -> String {
    match parse_read_terminal_command_output_args(&call.args_json) {
        Ok(args) => match find_terminal_command_record(&sessions, &args.command_id).await {
            Some(record) => {
                let clean_output = clean_captured_output(&record.output);
                let total_chars = clean_output.chars().count();
                let window = command_output_window(
                    &clean_output,
                    args.mode.as_str(),
                    args.offset,
                    args.max_chars,
                );
                format!(
                    "Tool result for read_terminal_command_output\nstatus: completed\nscope: shelly_agent_approved_commands_only\ncommand_id: {}\ncommand: {}\nrun_status: {}\nexit_code: {}\noffset: {}\nreturned_chars: {}\ntotal_chars: {}\ntruncated: {}\noutput:\n{}",
                    record.command_id,
                    record.command,
                    record.status,
                    record
                        .exit_code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "unknown".to_string()),
                    window.offset,
                    window.returned_chars,
                    total_chars,
                    window.truncated,
                    window.output
                )
            }
            None => format!(
                "Tool result for read_terminal_command_output\nstatus: error\nerror: commandId not found in Shelly Agent captured command records"
            ),
        },
        Err(err) => format!(
            "Tool result for read_terminal_command_output\nstatus: error\nerror: {}",
            err
        ),
    }
}

struct ReadTerminalCommandOutputArgs {
    command_id: String,
    offset: usize,
    max_chars: usize,
    mode: String,
}

fn parse_read_terminal_command_output_args(
    args_json: &str,
) -> Result<ReadTerminalCommandOutputArgs, String> {
    let value: Value = serde_json::from_str(args_json)
        .map_err(|e| format!("invalid read_terminal_command_output arguments: {e}"))?;
    let command_id = value
        .get("commandId")
        .or_else(|| value.get("command_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "read_terminal_command_output requires commandId".to_string())?;
    let offset = value
        .get("offset")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(0);
    let max_chars = value
        .get("maxChars")
        .or_else(|| value.get("max_chars"))
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(TERMINAL_COMMAND_OUTPUT_DEFAULT_MAX_CHARS)
        .clamp(1_000, TERMINAL_COMMAND_OUTPUT_MAX_CHARS);
    let mode = value
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("window")
        .to_ascii_lowercase();
    let mode = match mode.as_str() {
        "window" | "head" | "tail" | "full" => mode,
        _ => return Err("mode must be one of: window, head, tail, full".to_string()),
    };
    Ok(ReadTerminalCommandOutputArgs {
        command_id,
        offset,
        max_chars,
        mode,
    })
}

struct CommandOutputWindow {
    output: String,
    offset: usize,
    returned_chars: usize,
    truncated: bool,
}

fn command_output_window(
    output: &str,
    mode: &str,
    offset: usize,
    max_chars: usize,
) -> CommandOutputWindow {
    let chars = output.chars().collect::<Vec<_>>();
    let total = chars.len();
    let (start, end) = match mode {
        "head" => (0, total.min(max_chars)),
        "tail" => (total.saturating_sub(max_chars), total),
        "full" => (0, total.min(max_chars)),
        _ => {
            let start = offset.min(total);
            (start, (start + max_chars).min(total))
        }
    };
    let text = chars[start..end].iter().collect::<String>();
    CommandOutputWindow {
        output: text,
        offset: start,
        returned_chars: end.saturating_sub(start),
        truncated: start > 0 || end < total,
    }
}

async fn find_terminal_command_record(
    sessions: &SessionStore,
    command_id: &str,
) -> Option<TerminalCommandRecord> {
    let command_record_lists = {
        let guard = sessions.lock().await;
        guard
            .values()
            .map(|session| session.command_records.clone())
            .collect::<Vec<_>>()
    };
    for command_records in command_record_lists {
        let records = command_records.lock().await;
        if let Some(record) = records
            .iter()
            .find(|record| record.command_id == command_id)
            .cloned()
        {
            return Some(record);
        }
    }
    None
}

async fn execute_web_fetch_tool(call: &AgentToolCall) -> String {
    match parse_web_fetch_args(&call.args_json) {
        Ok(args) => match web_fetch(args).await {
            Ok(result) => format!(
                "Tool result for web_fetch\nstatus: completed\n{}",
                serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string())
            ),
            Err(err) => format!("Tool result for web_fetch\nstatus: error\nerror: {err}"),
        },
        Err(err) => format!("Tool result for web_fetch\nstatus: error\nerror: {err}"),
    }
}

async fn execute_get_session_info_tool(
    call: &AgentToolCall,
    active_session_id: Option<&str>,
    latest_snapshot: Option<&AiSessionSnapshot>,
    sessions: SessionStore,
) -> String {
    match parse_get_session_info_args(&call.args_json, active_session_id) {
        Ok(requested_session_id) => {
            let connected = if let Some(session_id) = requested_session_id.as_deref() {
                let guard = sessions.lock().await;
                guard.contains_key(session_id)
            } else {
                false
            };
            let status = if connected {
                "connected"
            } else if requested_session_id.is_some() {
                "disconnected"
            } else {
                "unknown"
            };
            let session_id = requested_session_id
                .or_else(|| latest_snapshot.and_then(|snapshot| snapshot.session_id.clone()));
            let result = json!({
                "sessionId": session_id,
                "status": status,
                "connected": connected,
                "deviceId": latest_snapshot.and_then(|snapshot| snapshot.device_id.clone()),
                "name": latest_snapshot
                    .and_then(|snapshot| snapshot.terminal_title.clone())
                    .or_else(|| latest_snapshot.and_then(|snapshot| snapshot.hostname.clone())),
                "host": latest_snapshot.and_then(|snapshot| snapshot.host.clone()),
                "port": latest_snapshot.and_then(|snapshot| snapshot.port),
                "username": latest_snapshot.and_then(|snapshot| snapshot.username.clone()),
                "hostname": latest_snapshot.and_then(|snapshot| snapshot.hostname.clone()),
                "os": latest_snapshot.and_then(|snapshot| snapshot.os.clone()),
                "shell": latest_snapshot.and_then(|snapshot| snapshot.shell.clone()),
                "cwd": latest_snapshot.and_then(|snapshot| snapshot.cwd.clone()),
                "serverKey": latest_snapshot.map(|snapshot| snapshot.server_key.clone()),
                "snapshotCapturedAt": latest_snapshot.map(|snapshot| snapshot.captured_at),
                "source": "shelly_session_state_and_latest_snapshot"
            });
            format!(
                "Tool result for get_session_info\nstatus: completed\n{}",
                serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string())
            )
        }
        Err(err) => format!("Tool result for get_session_info\nstatus: error\nerror: {err}"),
    }
}

fn parse_get_session_info_args(
    args_json: &str,
    active_session_id: Option<&str>,
) -> Result<Option<String>, String> {
    let value: Value = if args_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(args_json)
            .map_err(|e| format!("invalid get_session_info arguments: {e}"))?
    };
    Ok(value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .or_else(|| active_session_id.map(ToString::to_string)))
}

async fn execute_list_remote_files_tool(
    call: &AgentToolCall,
    active_session_id: Option<&str>,
    sessions: SessionStore,
) -> String {
    match parse_list_remote_files_args(&call.args_json, active_session_id) {
        Ok(args) => {
            match list_remote_files_for_agent(
                Some(args.session_id.as_str()),
                &sessions,
                args.path.as_str(),
            )
            .await
            {
                Ok(entries) => {
                    let total_entries = entries.len();
                    let truncated = total_entries > args.limit;
                    let entries = entries
                        .into_iter()
                        .take(args.limit)
                        .map(remote_file_entry_json)
                        .collect::<Vec<_>>();
                    let returned_entries = entries.len();
                    let result = json!({
                        "sessionId": args.session_id,
                        "path": args.path,
                        "entries": entries,
                        "totalEntries": total_entries,
                        "returnedEntries": returned_entries,
                        "truncated": truncated,
                        "scope": "sftp_directory_listing_only"
                    });
                    format!(
                        "Tool result for list_remote_files\nstatus: completed\n{}",
                        serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string())
                    )
                }
                Err(err) => {
                    format!("Tool result for list_remote_files\nstatus: error\nerror: {err}")
                }
            }
        }
        Err(err) => format!("Tool result for list_remote_files\nstatus: error\nerror: {err}"),
    }
}

struct ListRemoteFilesArgs {
    session_id: String,
    path: String,
    limit: usize,
}

fn parse_list_remote_files_args(
    args_json: &str,
    active_session_id: Option<&str>,
) -> Result<ListRemoteFilesArgs, String> {
    let value: Value = serde_json::from_str(args_json)
        .map_err(|e| format!("invalid list_remote_files arguments: {e}"))?;
    let session_id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .or_else(|| active_session_id.map(ToString::to_string))
        .ok_or_else(|| "list_remote_files requires an active SSH session".to_string())?;
    let path = value
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(".")
        .to_string();
    let limit = value
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(REMOTE_FILE_LIST_DEFAULT_LIMIT)
        .clamp(1, REMOTE_FILE_LIST_MAX_LIMIT);
    Ok(ListRemoteFilesArgs {
        session_id,
        path,
        limit,
    })
}

fn remote_file_entry_json(entry: RemoteFileEntry) -> Value {
    json!({
        "name": entry.name,
        "path": entry.path,
        "isDir": entry.is_dir,
        "size": entry.size,
        "modifiedAt": entry.modified_at,
        "permissions": entry.permissions
    })
}

fn execute_search_command_history_tool(
    call: &AgentToolCall,
    latest_snapshot: Option<&AiSessionSnapshot>,
    db: &Db,
) -> String {
    match parse_search_command_history_args(&call.args_json, latest_snapshot) {
        Ok(args) => match db.search_command_history(
            args.device_id.as_deref(),
            args.query.as_deref(),
            args.limit,
        ) {
            Ok(entries) => {
                let result = json!({
                    "query": args.query,
                    "deviceId": args.device_id,
                    "entries": entries.iter().map(command_history_entry_json).collect::<Vec<_>>(),
                    "returnedEntries": entries.len(),
                    "scope": "shelly_local_command_history"
                });
                format!(
                    "Tool result for search_command_history\nstatus: completed\n{}",
                    serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string())
                )
            }
            Err(err) => {
                format!("Tool result for search_command_history\nstatus: error\nerror: {err}")
            }
        },
        Err(err) => {
            format!("Tool result for search_command_history\nstatus: error\nerror: {err}")
        }
    }
}

struct SearchCommandHistoryArgs {
    query: Option<String>,
    device_id: Option<String>,
    limit: u32,
}

fn parse_search_command_history_args(
    args_json: &str,
    latest_snapshot: Option<&AiSessionSnapshot>,
) -> Result<SearchCommandHistoryArgs, String> {
    let value: Value = if args_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(args_json)
            .map_err(|e| format!("invalid search_command_history arguments: {e}"))?
    };
    let query = value
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let device_id = value
        .get("deviceId")
        .or_else(|| value.get("device_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .or_else(|| latest_snapshot.and_then(|snapshot| snapshot.device_id.clone()));
    let limit = value
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(COMMAND_HISTORY_DEFAULT_LIMIT)
        .clamp(1, COMMAND_HISTORY_MAX_LIMIT);
    Ok(SearchCommandHistoryArgs {
        query,
        device_id,
        limit,
    })
}

fn command_history_entry_json(entry: &CommandHistoryEntry) -> Value {
    json!({
        "id": entry.id,
        "deviceId": entry.device_id,
        "command": entry.command,
        "createdAt": entry.created_at
    })
}

fn execute_list_snippets_tool(call: &AgentToolCall, db: &Db) -> String {
    match parse_list_snippets_args(&call.args_json) {
        Ok(args) => match db.list_snippets() {
            Ok(snippets) => {
                let query_lower = args.query.as_ref().map(|query| query.to_ascii_lowercase());
                let filtered = snippets
                    .into_iter()
                    .filter(|snippet| {
                        if let Some(query) = query_lower.as_ref() {
                            snippet.name.to_ascii_lowercase().contains(query)
                                || snippet.command.to_ascii_lowercase().contains(query)
                        } else {
                            true
                        }
                    })
                    .take(args.limit)
                    .map(snippet_json)
                    .collect::<Vec<_>>();
                let returned_entries = filtered.len();
                let result = json!({
                    "query": args.query,
                    "snippets": filtered,
                    "returnedEntries": returned_entries,
                    "scope": "shelly_local_snippets"
                });
                format!(
                    "Tool result for list_snippets\nstatus: completed\n{}",
                    serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string())
                )
            }
            Err(err) => format!("Tool result for list_snippets\nstatus: error\nerror: {err}"),
        },
        Err(err) => format!("Tool result for list_snippets\nstatus: error\nerror: {err}"),
    }
}

struct ListSnippetsArgs {
    query: Option<String>,
    limit: usize,
}

fn parse_list_snippets_args(args_json: &str) -> Result<ListSnippetsArgs, String> {
    let value: Value = if args_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(args_json)
            .map_err(|e| format!("invalid list_snippets arguments: {e}"))?
    };
    let query = value
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let limit = value
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(50)
        .clamp(1, 200);
    Ok(ListSnippetsArgs { query, limit })
}

#[derive(Debug)]
struct WriteSnippetArgs {
    id: Option<String>,
    name: String,
    command: String,
    purpose: Option<String>,
}

fn parse_write_snippet_args(args_json: &str) -> Result<WriteSnippetArgs, String> {
    let value: Value = serde_json::from_str(args_json)
        .map_err(|e| format!("invalid write_snippet arguments: {e}"))?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| value.trim_start_matches('/'))
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "write_snippet requires name".to_string())?;
    let command = value
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "write_snippet requires command".to_string())?;
    let purpose = value
        .get("purpose")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    Ok(WriteSnippetArgs {
        id,
        name,
        command,
        purpose,
    })
}

fn snippet_json(snippet: Snippet) -> Value {
    json!({
        "id": snippet.id,
        "name": snippet.name,
        "slashName": format!("/{}", snippet.name),
        "command": snippet.command,
        "createdAt": snippet.created_at,
        "updatedAt": snippet.updated_at
    })
}

async fn execute_approved_write_snippet_tool(
    input: AiExecuteToolInput,
    db: State<'_, Db>,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<AiToolRun, String> {
    let run = db.ai_tool_run(&input.tool_run_id)?;
    if run.approval_status != "approved" {
        return Err("tool run is not approved by the user".into());
    }
    let args = parse_write_snippet_args(&run.args_json)?;
    let started = db.start_ai_tool_run(&input.tool_run_id, &input.active_session_id)?;
    emit_status(&app, &started.conversation_id, "executing_tool", None);
    let saved = db.save_snippet(SaveSnippetInput {
        id: args.id,
        name: args.name,
        command: args.command,
    })?;
    let _ = app.emit(
        "snippet-updated",
        SnippetUpdatedEvent {
            id: saved.id.clone(),
            name: saved.name.clone(),
            command: saved.command.clone(),
            created_at: saved.created_at,
            updated_at: saved.updated_at,
        },
    );
    let output = format!(
        "Saved Shelly snippet /{}\ncommand:\n{}",
        saved.name, saved.command
    );
    let finished = db.finish_ai_tool_run(&input.tool_run_id, "completed", &output, None)?;
    let _ = app.emit(
        "ai-tool-output",
        AiToolOutputEvent {
            conversation_id: finished.conversation_id.clone(),
            tool_run_id: finished.id.clone(),
            output: output.clone(),
        },
    );
    let _ = app.emit(
        "ai-tool-result",
        AiToolResultEvent {
            conversation_id: finished.conversation_id.clone(),
            tool_run_id: finished.id.clone(),
            run_status: finished.run_status.clone(),
            output: output.clone(),
            timed_out: false,
        },
    );
    db.append_ai_message(
        &finished.conversation_id,
        "tool",
        Some(&format!(
            "Tool result for write_snippet\nstatus: completed\n{}",
            serde_json::to_string_pretty(&snippet_json(saved)).unwrap_or_else(|_| "{}".to_string())
        )),
    )?;
    let conversation = db.ai_conversation(&finished.conversation_id)?;
    let _ = run_agent_turn(
        &db,
        &app,
        &conversation,
        Some(&input.active_session_id),
        None,
        sessions.inner().clone(),
    )
    .await;
    Ok(finished)
}

struct WebFetchArgs {
    url: String,
    max_chars: usize,
    timeout_secs: u64,
}

fn parse_web_fetch_args(args_json: &str) -> Result<WebFetchArgs, String> {
    let value: Value =
        serde_json::from_str(args_json).map_err(|e| format!("invalid web_fetch arguments: {e}"))?;
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "web_fetch requires url".to_string())?;
    let max_chars = value
        .get("maxChars")
        .or_else(|| value.get("max_chars"))
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(WEB_FETCH_DEFAULT_MAX_CHARS)
        .clamp(1_000, WEB_FETCH_MAX_CHARS);
    let timeout_secs = value
        .get("timeoutSecs")
        .or_else(|| value.get("timeout_secs"))
        .and_then(Value::as_u64)
        .unwrap_or(WEB_FETCH_DEFAULT_TIMEOUT_SECS)
        .clamp(3, WEB_FETCH_MAX_TIMEOUT_SECS);
    Ok(WebFetchArgs {
        url,
        max_chars,
        timeout_secs,
    })
}

async fn web_fetch(args: WebFetchArgs) -> Result<Value, String> {
    let url = reqwest::Url::parse(&args.url).map_err(|e| format!("invalid URL: {e}"))?;
    validate_public_web_url(&url).await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(args.timeout_secs))
        .user_agent(format!("Shelly/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    validate_public_web_url(res.url()).await?;
    let status = res.status().as_u16();
    let final_url = res.url().to_string();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !is_supported_web_content_type(&content_type) {
        return Err(format!(
            "unsupported content type: {}",
            if content_type.is_empty() {
                "unknown"
            } else {
                content_type.as_str()
            }
        ));
    }
    let (body, body_truncated) = read_limited_response_body(res, WEB_FETCH_MAX_BODY_BYTES).await?;
    let raw_text = String::from_utf8_lossy(&body).to_string();
    let is_html = content_type.to_ascii_lowercase().contains("html")
        || raw_text.to_ascii_lowercase().contains("<html");
    let title = if is_html {
        extract_html_title(&raw_text)
    } else {
        None
    };
    let extractor = if is_html { "html_basic" } else { "raw_text" };
    let extracted = if is_html {
        html_to_markdownish_text(&raw_text)
    } else {
        raw_text.replace('\r', "")
    };
    let (text, text_truncated) = trim_text_to_chars(&extracted, args.max_chars);
    let text_chars = text.chars().count();
    Ok(json!({
        "url": args.url,
        "finalUrl": final_url,
        "status": status,
        "contentType": content_type,
        "title": title,
        "extractor": extractor,
        "text": text,
        "textChars": text_chars,
        "truncated": body_truncated || text_truncated
    }))
}

async fn read_limited_response_body(
    res: reqwest::Response,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), String> {
    let mut stream = res.bytes_stream();
    let mut body = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("failed reading response body: {e}"))?;
        if body.len() + chunk.len() > max_bytes {
            let remaining = max_bytes.saturating_sub(body.len());
            body.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, truncated))
}

async fn validate_public_web_url(url: &reqwest::Url) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("web_fetch only supports http and https URLs".to_string()),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL host is required".to_string())?;
    let host_lower = host.to_ascii_lowercase();
    if matches!(host_lower.as_str(), "localhost" | "localhost.localdomain")
        || host_lower.ends_with(".localhost")
    {
        return Err("web_fetch blocks localhost URLs".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err("web_fetch blocks private, local, and special-use IP addresses".to_string());
        }
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| "DNS lookup timed out".to_string())?
    .map_err(|e| format!("DNS lookup failed: {e}"))?;
    for addr in addrs {
        if is_blocked_ip(addr.ip()) {
            return Err(
                "web_fetch blocks hosts that resolve to private, local, or special-use IPs"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            ip.is_loopback()
                || ip.is_multicast()
                || ip.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

fn is_supported_web_content_type(content_type: &str) -> bool {
    if content_type.trim().is_empty() {
        return true;
    }
    let lower = content_type.to_ascii_lowercase();
    lower.starts_with("text/")
        || lower.contains("json")
        || lower.contains("xml")
        || lower.contains("xhtml")
        || lower.contains("markdown")
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after_start = lower[start..].find('>')? + start + 1;
    let end = lower[after_start..].find("</title>")? + after_start;
    let title = decode_basic_html_entities(&strip_html_tags(&html[after_start..end]))
        .trim()
        .to_string();
    (!title.is_empty()).then_some(title)
}

fn html_to_markdownish_text(html: &str) -> String {
    let without_layout = remove_html_sections(
        html,
        &[
            "script", "style", "noscript", "nav", "footer", "header", "aside", "svg", "form",
            "button", "iframe",
        ],
    );
    let with_breaks = add_html_text_breaks(&without_layout);
    normalize_text_whitespace(&decode_basic_html_entities(&strip_html_tags(&with_breaks)))
}

fn remove_html_sections(html: &str, tags: &[&str]) -> String {
    let mut text = html.to_string();
    for tag in tags {
        loop {
            let lower = text.to_ascii_lowercase();
            let Some(start) = lower.find(&format!("<{tag}")) else {
                break;
            };
            let end_tag = format!("</{tag}>");
            let end = lower[start..]
                .find(&end_tag)
                .map(|index| start + index + end_tag.len())
                .or_else(|| lower[start..].find('>').map(|index| start + index + 1))
                .unwrap_or(text.len());
            text.replace_range(start..end, "\n");
        }
    }
    text
}

fn add_html_text_breaks(html: &str) -> String {
    let mut text = html.to_string();
    let replacements = [
        ("<br", "\n<br"),
        ("</p>", "\n"),
        ("</div>", "\n"),
        ("</section>", "\n"),
        ("</article>", "\n"),
        ("</li>", "\n"),
        ("</tr>", "\n"),
        ("</h1>", "\n"),
        ("</h2>", "\n"),
        ("</h3>", "\n"),
        ("</h4>", "\n"),
        ("</h5>", "\n"),
        ("</h6>", "\n"),
    ];
    for (needle, replacement) in replacements {
        text = replace_ascii_case_insensitive(&text, needle, replacement);
    }
    text
}

fn replace_ascii_case_insensitive(text: &str, needle: &str, replacement: &str) -> String {
    let mut out = String::new();
    let mut remaining = text;
    let needle_lower = needle.to_ascii_lowercase();
    loop {
        let lower = remaining.to_ascii_lowercase();
        let Some(index) = lower.find(&needle_lower) else {
            out.push_str(remaining);
            break;
        };
        out.push_str(&remaining[..index]);
        out.push_str(replacement);
        remaining = &remaining[index + needle.len()..];
    }
    out
}

fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn decode_basic_html_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn normalize_text_whitespace(text: &str) -> String {
    text.replace('\r', "")
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn trim_text_to_chars(text: &str, max_chars: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max_chars {
        return (text.trim().to_string(), false);
    }
    (
        text.chars().take(max_chars).collect::<String>().trim().to_string(),
        true,
    )
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[derive(Debug)]
struct CommandCapture {
    output: String,
    timed_out: bool,
    exit_code: Option<i64>,
}

async fn capture_command_output(
    output: Arc<Mutex<String>>,
    start_byte: usize,
    marker: &str,
) -> CommandCapture {
    let started = Instant::now();
    loop {
        sleep(Duration::from_millis(180)).await;
        let text = output.lock().await.clone();
        let captured = slice_from_boundary(&text, start_byte);
        if let Some((clean, exit_code)) = split_marker_output(captured, marker) {
            return CommandCapture {
                output: clean,
                timed_out: false,
                exit_code,
            };
        }
        if started.elapsed() >= Duration::from_secs(30) {
            return CommandCapture {
                output: captured.to_string(),
                timed_out: true,
                exit_code: None,
            };
        }
    }
}

fn marker_for_tool_run(tool_run_id: &str) -> String {
    let clean = tool_run_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>();
    format!("__SHELLY_DONE_{clean}__")
}

fn wrap_command_with_marker(command: &str, marker: &str) -> String {
    format!(
        "{{\n{}\n}}\n__shelly_status=$?\nprintf '\\n{}:%s\\n' \"$__shelly_status\"\n",
        command.trim_end(),
        marker
    )
}

fn split_marker_output(captured: &str, marker: &str) -> Option<(String, Option<i64>)> {
    let needle = format!("{marker}:");
    let mut search_from = 0;
    while let Some(relative_index) = captured[search_from..].find(&needle) {
        let marker_index = search_from + relative_index;
        let rest = &captured[marker_index + needle.len()..];
        let code_text = rest
            .chars()
            .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
            .collect::<String>();
        if !code_text.is_empty() {
            let code = code_text.parse::<i64>().ok();
            return Some((captured[..marker_index].to_string(), code));
        }
        search_from = marker_index + needle.len();
    }
    None
}

fn slice_from_boundary(text: &str, start_byte: usize) -> &str {
    if start_byte >= text.len() {
        return "";
    }
    if text.is_char_boundary(start_byte) {
        &text[start_byte..]
    } else {
        let mut start = start_byte;
        while start < text.len() && !text.is_char_boundary(start) {
            start += 1;
        }
        &text[start..]
    }
}

fn trim_tool_output(output: &str, max_chars: usize) -> String {
    let normalized = clean_captured_output(output);
    let count = normalized.chars().count();
    if count <= max_chars {
        return normalized.trim().to_string();
    }
    let tail = normalized
        .chars()
        .skip(count.saturating_sub(max_chars))
        .collect::<String>();
    format!(
        "[output truncated to last {max_chars} chars]\n{}",
        tail.trim()
    )
}

fn format_model_tool_output(output: &str) -> String {
    let cleaned = clean_captured_output(output);
    let char_count = cleaned.chars().count();
    let line_count = cleaned.lines().count();
    if char_count <= TOOL_MODEL_OUTPUT_MAX_CHARS {
        return format!(
            "[output stats: {line_count} lines, {char_count} chars]\n{}",
            cleaned.trim()
        );
    }

    let head_chars = 5_000;
    let tail_chars = 5_000;
    let head = cleaned.chars().take(head_chars).collect::<String>();
    let tail = cleaned
        .chars()
        .skip(char_count.saturating_sub(tail_chars))
        .collect::<String>();
    let omitted = char_count.saturating_sub(head_chars + tail_chars);
    format!(
        "[output summarized for model context: {line_count} lines, {char_count} chars, {omitted} chars omitted]\n\
         [head]\n{}\n\n[tail]\n{}",
        head.trim(),
        tail.trim()
    )
}

fn clean_captured_output(output: &str) -> String {
    output
        .replace('\r', "")
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed != "{"
                && trimmed != "}"
                && trimmed != ">"
                && !trimmed.starts_with("> }")
                && !trimmed.contains("__shelly_status=$?")
                && !trimmed.contains("printf '\\n__SHELLY_DONE_")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn format_tool_result_message(run: &AiToolRun, command: &str) -> String {
    let model_output = run
        .output
        .as_deref()
        .map(format_model_tool_output)
        .unwrap_or_else(|| "[output stats: 0 lines, 0 chars]".to_string());
    format!(
        "Tool result for exec_command\ncommand: {}\nstatus: {}\nexit_code: {}\noutput:\n{}",
        command,
        run.run_status,
        run.exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        model_output
    )
}

fn should_reprompt_for_missing_tool(text: &str) -> bool {
    let normalized = text.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let command_intent = [
        "现在我再发",
        "我再发",
        "再来第二个",
        "再来一个",
        "接下来",
        "我来执行",
        "我来跑",
        "我来检查",
        "试试看",
        "try another",
        "run another",
        "i will run",
        "let me run",
        "next command",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));
    let command_words = [
        "命令", "检查", "执行", "运行", "网络", "磁盘", "内存", "command", "check", "inspect",
        "run",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));
    command_intent && command_words
}

fn last_message_is_tool_reprompt(messages: &[AiMessage]) -> bool {
    messages
        .last()
        .and_then(|msg| msg.content.as_deref())
        .is_some_and(|content| content.starts_with("Shelly internal note: You said you would run"))
}

#[derive(Debug)]
struct CommandRisk {
    level: String,
    reasons: Vec<String>,
}

fn analyze_command_risk(cmd: &str) -> CommandRisk {
    let lower = cmd.to_ascii_lowercase();
    let mut level = "safe".to_string();
    let mut reasons = Vec::new();

    if is_interactive_command(&lower) {
        return CommandRisk {
            level: "interactive".to_string(),
            reasons: vec!["needs user interaction or stdin; Shelly Agent will hand off the interactive part to you".to_string()],
        };
    }

    let critical_patterns = [
        "rm -rf /",
        "--no-preserve-root",
        ":(){",
        "mkfs",
        "dd if=",
        "dd of=/dev/",
        "fdisk",
        "parted",
    ];
    let high_patterns = [
        "reboot",
        "shutdown",
        "systemctl stop ssh",
        "systemctl stop sshd",
        "iptables -f",
        "ufw disable",
    ];
    let medium_patterns = [
        "sudo su",
        "sudo bash",
        "passwd",
        "/etc/shadow",
        "mysqldump",
        "pg_dump",
        "tar ",
    ];

    if critical_patterns
        .iter()
        .any(|pattern| lower.contains(pattern))
    {
        level = "critical".to_string();
        reasons.push("matches destructive command pattern".to_string());
    } else if high_patterns.iter().any(|pattern| lower.contains(pattern)) {
        level = "high".to_string();
        reasons.push("may disrupt the SSH session or host availability".to_string());
    } else if medium_patterns
        .iter()
        .any(|pattern| lower.contains(pattern))
    {
        level = "medium".to_string();
        reasons
            .push("may involve privilege changes, credentials, or large data access".to_string());
    }

    if reasons.is_empty() {
        reasons.push("no high-risk pattern detected".to_string());
    }
    CommandRisk { level, reasons }
}

fn is_interactive_command(lower_cmd: &str) -> bool {
    let cmd = lower_cmd.trim();
    if cmd.is_empty() {
        return false;
    }
    let head = cmd
        .split([' ', '\t', '\n', ';', '&', '|', '(', ')'])
        .find(|part| !part.is_empty())
        .unwrap_or("");
    let interactive_heads = [
        "read",
        "passwd",
        "vi",
        "vim",
        "nvim",
        "nano",
        "emacs",
        "top",
        "htop",
        "less",
        "more",
        "ssh",
        "sftp",
        "ftp",
        "telnet",
        "mysql",
        "psql",
        "redis-cli",
        "sqlite3",
        "python",
        "python3",
        "node",
        "irb",
        "pry",
        "rails",
        "bash",
        "sh",
        "zsh",
        "fish",
        "su",
    ];
    if interactive_heads.contains(&head) {
        if matches!(
            head,
            "python" | "python3" | "node" | "bash" | "sh" | "zsh" | "fish"
        ) {
            return !cmd.contains(" -c ") && !cmd.contains(" --command ");
        }
        if head == "mysql" || head == "psql" || head == "redis-cli" || head == "sqlite3" {
            return !cmd.contains(" -e ") && !cmd.contains(" -c ");
        }
        return true;
    }
    if cmd == "cat" || cmd.starts_with("cat >") || cmd.contains("| cat >") || cmd.contains("; cat")
    {
        return true;
    }
    if cmd.contains(" tail -f ")
        || cmd.starts_with("tail -f ")
        || cmd.contains(" journalctl -f")
        || cmd.starts_with("journalctl -f")
    {
        return true;
    }
    if cmd.starts_with("watch ") || cmd.contains("; watch ") || cmd.contains("&& watch ") {
        return true;
    }
    if cmd.starts_with("ping ") && !cmd.contains(" -c ") && !cmd.contains(" -n ") {
        return true;
    }
    false
}

fn build_prompt(
    provider: &AiProvider,
    server_key: &str,
    active_session_id: Option<&str>,
    terminal_context: Option<&str>,
    latest_snapshot: Option<&AiSessionSnapshot>,
    messages: &[AiMessage],
) -> AgentPrompt {
    let mut system = String::new();
    system.push_str(STATIC_SYSTEM_PROMPT);
    if let Some(extra) = provider.system_prompt.as_deref() {
        system.push_str("\n\n[Provider Custom Instructions]\n");
        system.push_str(extra);
    }

    let mut context = String::new();
    context.push_str("## Current Session\n");
    context.push_str(&format!("- Server Key: {server_key}\n"));
    if let Some(active_session_id) = active_session_id {
        context.push_str(&format!("- Active Session ID: {active_session_id}\n"));
    }
    if let Some(snapshot) = latest_snapshot {
        context.push_str(&format!(
            "- Snapshot Session ID: {}\n",
            snapshot.session_id.as_deref().unwrap_or("unknown")
        ));
        context.push_str(&format!(
            "- Device ID: {}\n",
            snapshot.device_id.as_deref().unwrap_or("unknown")
        ));
        context.push_str(&format!(
            "- Hostname: {}\n",
            snapshot.hostname.as_deref().unwrap_or("unknown")
        ));
        context.push_str(&format!(
            "- User: {}\n",
            snapshot.username.as_deref().unwrap_or("unknown")
        ));
        context.push_str(&format!(
            "- Host: {}:{}\n",
            snapshot.host.as_deref().unwrap_or("unknown"),
            snapshot
                .port
                .map(|port| port.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ));
        context.push_str(&format!(
            "- OS: {}\n",
            snapshot.os.as_deref().unwrap_or("unknown")
        ));
        context.push_str(&format!(
            "- Shell: {}\n",
            snapshot.shell.as_deref().unwrap_or("unknown")
        ));
        context.push_str(&format!(
            "- Working Directory: {}\n",
            snapshot.cwd.as_deref().unwrap_or("unknown")
        ));
        context.push_str(&format!(
            "- Terminal Title: {}\n",
            snapshot.terminal_title.as_deref().unwrap_or("unknown")
        ));
        context.push_str(&format!(
            "- Snapshot Captured At: {}\n",
            snapshot.captured_at
        ));
    } else {
        context.push_str("- Session details: no snapshot has been captured yet.\n");
    }
    if let Some(terminal_context) = terminal_context.filter(|v| !v.trim().is_empty()) {
        context.push_str("\n## Current Terminal Context\n");
        context.push_str(terminal_context);
        context.push('\n');
    }

    let mut prompt_messages = Vec::new();
    for msg in messages
        .iter()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        if let Some(content) = msg.content.as_deref() {
            prompt_messages.push(AgentPromptMessage {
                role: provider_message_role(&msg.role).to_string(),
                content: provider_message_content(&msg.role, content),
            });
        }
    }
    if messages.last().is_some_and(|msg| msg.role == "tool") {
        context.push_str("\n## Tool Result Follow-up\n");
        context.push_str("The latest message is a real Shelly tool result. Continue from that result now. Do not copy its format or write a new tool result yourself. If the next step requires another shell command, call exec_command in this response with the exact command. Do not say you will run a command unless you are calling exec_command now.\n");
    }

    AgentPrompt {
        system,
        context,
        messages: prompt_messages,
    }
}

fn provider_message_role(role: &str) -> &'static str {
    match role {
        "assistant" => "assistant",
        _ => "user",
    }
}

fn provider_message_content(role: &str, content: &str) -> String {
    match role {
        "tool" => format!("[Shelly real tool result]\n{content}"),
        _ => content.to_string(),
    }
}

fn openai_input_messages(prompt: &AgentPrompt) -> Vec<Value> {
    let mut input = vec![json!({
        "role": "user",
        "content": format!("[Shelly current context]\n{}", prompt.context)
    })];
    input.extend(prompt.messages.iter().map(|msg| {
        json!({
            "role": msg.role,
            "content": msg.content
        })
    }));
    input
}

fn claude_messages(prompt: &AgentPrompt) -> Vec<Value> {
    let mut merged: Vec<AgentPromptMessage> = Vec::new();
    let mut all = vec![AgentPromptMessage {
        role: "user".to_string(),
        content: format!("[Shelly current context]\n{}", prompt.context),
    }];
    all.extend(prompt.messages.clone());

    for msg in all {
        if let Some(last) = merged.last_mut() {
            if last.role == msg.role {
                last.content.push_str("\n\n");
                last.content.push_str(&msg.content);
                continue;
            }
        }
        merged.push(msg);
    }

    merged
        .into_iter()
        .map(|msg| json!({ "role": msg.role, "content": msg.content }))
        .collect()
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
    prompt: &AgentPrompt,
    app: &AppHandle,
    conversation_id: &str,
) -> Result<AgentStreamResult, String> {
    let url = endpoint(&provider.base_url, "responses");
    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({
            "model": provider.model,
            "instructions": prompt.system,
            "input": openai_input_messages(prompt),
            "stream": true,
            "tools": agent_tool_schemas_openai(),
            "tool_choice": "auto",
            "temperature": provider.temperature,
            "max_output_tokens": provider.max_tokens
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!(
            "OpenAI request failed: {}",
            res.text().await.unwrap_or_default()
        ));
    }
    stream_openai_sse(res, app, conversation_id).await
}

async fn stream_claude(
    provider: &AiProvider,
    api_key: &str,
    prompt: &AgentPrompt,
    app: &AppHandle,
    conversation_id: &str,
) -> Result<AgentStreamResult, String> {
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
            "tools": agent_tool_schemas_claude(),
            "system": prompt.system,
            "messages": claude_messages(prompt)
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!(
            "Claude request failed: {}",
            res.text().await.unwrap_or_default()
        ));
    }
    stream_claude_sse(res, app, conversation_id).await
}

fn endpoint(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with(path) {
        base.to_string()
    } else {
        format!("{base}/{path}")
    }
}

fn agent_tool_schemas_openai() -> Vec<Value> {
    vec![
        read_terminal_tail_tool_schema_openai(),
        list_terminal_commands_tool_schema_openai(),
        read_terminal_command_output_tool_schema_openai(),
        web_fetch_tool_schema_openai(),
        get_session_info_tool_schema_openai(),
        list_remote_files_tool_schema_openai(),
        search_command_history_tool_schema_openai(),
        list_snippets_tool_schema_openai(),
        write_snippet_tool_schema_openai(),
        exec_command_tool_schema_openai(),
    ]
}

fn agent_tool_schemas_claude() -> Vec<Value> {
    vec![
        read_terminal_tail_tool_schema_claude(),
        list_terminal_commands_tool_schema_claude(),
        read_terminal_command_output_tool_schema_claude(),
        web_fetch_tool_schema_claude(),
        get_session_info_tool_schema_claude(),
        list_remote_files_tool_schema_claude(),
        search_command_history_tool_schema_claude(),
        list_snippets_tool_schema_claude(),
        write_snippet_tool_schema_claude(),
        exec_command_tool_schema_claude(),
    ]
}

fn read_terminal_tail_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "read_terminal_tail",
        "description": "Read the current SSH terminal tail. Use this first when you need recent terminal state, the latest command output, prompt, cwd, or visible errors. This is read-only and does not require approval.",
        "parameters": {
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Optional SSH session id. Omit to use the active session." },
                "lines": { "type": "integer", "description": "Number of recent terminal lines to read. Defaults to 80, capped at 500." },
                "maxChars": { "type": "integer", "description": "Maximum returned characters. Defaults to 12000, capped at 50000." }
            },
            "additionalProperties": false
        }
    })
}

fn read_terminal_tail_tool_schema_claude() -> Value {
    json!({
        "name": "read_terminal_tail",
        "description": "Read the current SSH terminal tail. Use this first when you need recent terminal state, the latest command output, prompt, cwd, or visible errors. This is read-only and does not require approval.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Optional SSH session id. Omit to use the active session." },
                "lines": { "type": "integer", "description": "Number of recent terminal lines to read. Defaults to 80, capped at 500." },
                "maxChars": { "type": "integer", "description": "Maximum returned characters. Defaults to 12000, capped at 50000." }
            }
        }
    })
}

fn list_terminal_commands_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "list_terminal_commands",
        "description": "List recent command output records captured by Shelly Agent for the current SSH session. Current scope: only commands requested through exec_command and approved in Shelly Agent, plus completed interactive handoffs. It does not include arbitrary commands manually typed by the user in the SSH terminal. Use this after read_terminal_tail when the tail is insufficient, truncated, interleaved, or the user asks about a specific earlier Agent-run command. This returns an index with previews, not full output.",
        "parameters": {
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Optional SSH session id. Omit to use the active session." },
                "limit": { "type": "integer", "description": "Maximum command records to return. Defaults to 20, capped at 50." }
            },
            "additionalProperties": false
        }
    })
}

fn list_terminal_commands_tool_schema_claude() -> Value {
    json!({
        "name": "list_terminal_commands",
        "description": "List recent command output records captured by Shelly Agent for the current SSH session. Current scope: only commands requested through exec_command and approved in Shelly Agent, plus completed interactive handoffs. It does not include arbitrary commands manually typed by the user in the SSH terminal. Use this after read_terminal_tail when the tail is insufficient, truncated, interleaved, or the user asks about a specific earlier Agent-run command. This returns an index with previews, not full output.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Optional SSH session id. Omit to use the active session." },
                "limit": { "type": "integer", "description": "Maximum command records to return. Defaults to 20, capped at 50." }
            }
        }
    })
}

fn read_terminal_command_output_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "read_terminal_command_output",
        "description": "Read captured output for one Shelly Agent command by commandId. Use this after list_terminal_commands identifies the relevant commandId, or when the commandId is already available from a previous tool result. Current scope: only Shelly Agent approved exec_command runs and completed interactive handoffs. It cannot read arbitrary manually typed shell history.",
        "parameters": {
            "type": "object",
            "properties": {
                "commandId": { "type": "string", "description": "Command id from list_terminal_commands or a previous Shelly tool result." },
                "offset": { "type": "integer", "description": "Character offset for window mode. Defaults to 0." },
                "maxChars": { "type": "integer", "description": "Maximum returned characters. Defaults to 20000, capped at 80000." },
                "mode": {
                    "type": "string",
                    "enum": ["window", "head", "tail", "full"],
                    "description": "Read mode. Defaults to window. Full is still capped by maxChars."
                }
            },
            "required": ["commandId"],
            "additionalProperties": false
        }
    })
}

fn read_terminal_command_output_tool_schema_claude() -> Value {
    json!({
        "name": "read_terminal_command_output",
        "description": "Read captured output for one Shelly Agent command by commandId. Use this after list_terminal_commands identifies the relevant commandId, or when the commandId is already available from a previous tool result. Current scope: only Shelly Agent approved exec_command runs and completed interactive handoffs. It cannot read arbitrary manually typed shell history.",
        "input_schema": {
            "type": "object",
            "properties": {
                "commandId": { "type": "string", "description": "Command id from list_terminal_commands or a previous Shelly tool result." },
                "offset": { "type": "integer", "description": "Character offset for window mode. Defaults to 0." },
                "maxChars": { "type": "integer", "description": "Maximum returned characters. Defaults to 20000, capped at 80000." },
                "mode": {
                    "type": "string",
                    "enum": ["window", "head", "tail", "full"],
                    "description": "Read mode. Defaults to window. Full is still capped by maxChars."
                }
            },
            "required": ["commandId"]
        }
    })
}

fn web_fetch_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "web_fetch",
        "description": "Fetch a public HTTP/HTTPS URL and return bounded cleaned text plus metadata. Use for public documentation, GitHub projects, Docker images, install guides, release notes, API docs, or errors likely answered by current external docs. Blocks localhost/private network targets and unsupported binary content.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Public HTTP or HTTPS URL to fetch. Prefer official or user-provided URLs." },
                "maxChars": { "type": "integer", "description": "Maximum returned text characters. Defaults to 20000, capped at 80000." },
                "timeoutSecs": { "type": "integer", "description": "Request timeout in seconds. Defaults to 15, capped at 30." }
            },
            "required": ["url"],
            "additionalProperties": false
        }
    })
}

fn web_fetch_tool_schema_claude() -> Value {
    json!({
        "name": "web_fetch",
        "description": "Fetch a public HTTP/HTTPS URL and return bounded cleaned text plus metadata. Use for public documentation, GitHub projects, Docker images, install guides, release notes, API docs, or errors likely answered by current external docs. Blocks localhost/private network targets and unsupported binary content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Public HTTP or HTTPS URL to fetch. Prefer official or user-provided URLs." },
                "maxChars": { "type": "integer", "description": "Maximum returned text characters. Defaults to 20000, capped at 80000." },
                "timeoutSecs": { "type": "integer", "description": "Request timeout in seconds. Defaults to 15, capped at 30." }
            },
            "required": ["url"]
        }
    })
}

fn get_session_info_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "get_session_info",
        "description": "Return Shelly's current known SSH session metadata and connection status without running remote commands. Use when the user asks which server/session/device is active, or before command execution when the target session may be ambiguous. This is connection metadata and latest snapshot data, not proof of remote command output.",
        "parameters": {
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Optional SSH session id. Omit to use the active session." }
            },
            "additionalProperties": false
        }
    })
}

fn get_session_info_tool_schema_claude() -> Value {
    json!({
        "name": "get_session_info",
        "description": "Return Shelly's current known SSH session metadata and connection status without running remote commands. Use when the user asks which server/session/device is active, or before command execution when the target session may be ambiguous. This is connection metadata and latest snapshot data, not proof of remote command output.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Optional SSH session id. Omit to use the active session." }
            }
        }
    })
}

fn list_remote_files_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "list_remote_files",
        "description": "List entries in a remote directory through Shelly's existing SFTP connection. Read-only metadata only: names, paths, type, size, modified time, permissions. Does not read file contents or modify files.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Remote directory path to list. Defaults to '.'." },
                "sessionId": { "type": "string", "description": "Optional SSH session id. Omit to use the active session." },
                "limit": { "type": "integer", "description": "Maximum entries to return. Defaults to 100, capped at 500." }
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

fn list_remote_files_tool_schema_claude() -> Value {
    json!({
        "name": "list_remote_files",
        "description": "List entries in a remote directory through Shelly's existing SFTP connection. Read-only metadata only: names, paths, type, size, modified time, permissions. Does not read file contents or modify files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Remote directory path to list. Defaults to '.'." },
                "sessionId": { "type": "string", "description": "Optional SSH session id. Omit to use the active session." },
                "limit": { "type": "integer", "description": "Maximum entries to return. Defaults to 100, capped at 500." }
            },
            "required": ["path"]
        }
    })
}

fn search_command_history_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "search_command_history",
        "description": "Search Shelly's saved local command history, optionally scoped to the current device. Use when the user asks for a previous command or wants to reuse a workflow. This is not the remote shell's full history file.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Optional substring to search for. Omit to list recent command history." },
                "deviceId": { "type": "string", "description": "Optional Shelly device id. Omit to use the current device when available." },
                "limit": { "type": "integer", "description": "Maximum entries to return. Defaults to 20, capped at 100." }
            },
            "additionalProperties": false
        }
    })
}

fn search_command_history_tool_schema_claude() -> Value {
    json!({
        "name": "search_command_history",
        "description": "Search Shelly's saved local command history, optionally scoped to the current device. Use when the user asks for a previous command or wants to reuse a workflow. This is not the remote shell's full history file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Optional substring to search for. Omit to list recent command history." },
                "deviceId": { "type": "string", "description": "Optional Shelly device id. Omit to use the current device when available." },
                "limit": { "type": "integer", "description": "Maximum entries to return. Defaults to 20, capped at 100." }
            }
        }
    })
}

fn list_snippets_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "list_snippets",
        "description": "List or search Shelly snippets. Snippets are user-defined long commands mapped to short names for quick terminal insertion. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Optional substring to match against snippet name or command." },
                "limit": { "type": "integer", "description": "Maximum snippets to return. Defaults to 50, capped at 200." }
            },
            "additionalProperties": false
        }
    })
}

fn list_snippets_tool_schema_claude() -> Value {
    json!({
        "name": "list_snippets",
        "description": "List or search Shelly snippets. Snippets are user-defined long commands mapped to short names for quick terminal insertion. Read-only.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Optional substring to match against snippet name or command." },
                "limit": { "type": "integer", "description": "Maximum snippets to return. Defaults to 50, capped at 200." }
            }
        }
    })
}

fn write_snippet_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "write_snippet",
        "description": "Create or update one Shelly snippet. Requires user approval before saving because it writes local Shelly snippet data. Use only when the user explicitly asks to save, create, update, or remember a reusable command shortcut.",
        "parameters": {
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Optional existing snippet id when updating a known snippet." },
                "name": { "type": "string", "description": "Snippet name, with or without leading slash." },
                "command": { "type": "string", "description": "Exact command text to save in the snippet." },
                "purpose": { "type": "string", "description": "Short explanation of why this snippet should be saved." }
            },
            "required": ["name", "command"],
            "additionalProperties": false
        }
    })
}

fn write_snippet_tool_schema_claude() -> Value {
    json!({
        "name": "write_snippet",
        "description": "Create or update one Shelly snippet. Requires user approval before saving because it writes local Shelly snippet data. Use only when the user explicitly asks to save, create, update, or remember a reusable command shortcut.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Optional existing snippet id when updating a known snippet." },
                "name": { "type": "string", "description": "Snippet name, with or without leading slash." },
                "command": { "type": "string", "description": "Exact command text to save in the snippet." },
                "purpose": { "type": "string", "description": "Short explanation of why this snippet should be saved." }
            },
            "required": ["name", "command"]
        }
    })
}

fn exec_command_tool_schema_openai() -> Value {
    json!({
        "type": "function",
        "name": "exec_command",
        "description": "Request approval to write a command into the user's visible SSH terminal.",
        "parameters": {
            "type": "object",
            "properties": {
                "cmd": { "type": "string", "description": "The exact shell command to run." },
                "purpose": { "type": "string", "description": "Short explanation of why this command is needed." },
                "interaction_tip": { "type": "string", "description": "For interactive commands only: a concise tip telling the user what prompt or choice they may see and how to proceed safely." }
            },
            "required": ["cmd"],
            "additionalProperties": false
        }
    })
}

fn exec_command_tool_schema_claude() -> Value {
    json!({
        "name": "exec_command",
        "description": "Request approval to write a command into the user's visible SSH terminal.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cmd": { "type": "string", "description": "The exact shell command to run." },
                "purpose": { "type": "string", "description": "Short explanation of why this command is needed." },
                "interaction_tip": { "type": "string", "description": "For interactive commands only: a concise tip telling the user what prompt or choice they may see and how to proceed safely." }
            },
            "required": ["cmd"]
        }
    })
}

async fn stream_openai_sse(
    res: reqwest::Response,
    app: &AppHandle,
    conversation_id: &str,
) -> Result<AgentStreamResult, String> {
    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    let mut result = AgentStreamResult::default();
    let mut calls: Vec<AgentToolCall> = Vec::new();
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
                if let Some(delta) = parse_openai_delta(&value) {
                    if let Some(append) = append_normalized_delta(&mut result.text, &delta) {
                        emit_delta(app, conversation_id, &append);
                    }
                    continue;
                }
                parse_openai_tool_event(&value, &mut calls);
            }
        }
    }
    result.tool_calls = calls
        .into_iter()
        .filter(|call| !call.name.is_empty() && !call.args_json.trim().is_empty())
        .collect();
    Ok(result)
}

async fn stream_claude_sse(
    res: reqwest::Response,
    app: &AppHandle,
    conversation_id: &str,
) -> Result<AgentStreamResult, String> {
    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    let mut result = AgentStreamResult::default();
    let mut calls: Vec<AgentToolCall> = Vec::new();
    let mut current_tool_index: Option<usize> = None;
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
                if let Some(delta) = parse_claude_delta(&value) {
                    if let Some(append) = append_normalized_delta(&mut result.text, &delta) {
                        emit_delta(app, conversation_id, &append);
                    }
                    continue;
                }
                parse_claude_tool_event(&value, &mut calls, &mut current_tool_index);
            }
        }
    }
    result.tool_calls = calls
        .into_iter()
        .filter(|call| !call.name.is_empty() && !call.args_json.trim().is_empty())
        .collect();
    Ok(result)
}

fn parse_openai_delta(value: &Value) -> Option<String> {
    if value.get("type")?.as_str()? == "response.output_text.delta" {
        value.get("delta")?.as_str().map(ToString::to_string)
    } else {
        None
    }
}

fn append_normalized_delta(full: &mut String, incoming: &str) -> Option<String> {
    if incoming.is_empty() {
        return None;
    }
    if full.is_empty() {
        full.push_str(incoming);
        return Some(incoming.to_string());
    }
    if incoming.starts_with(full.as_str()) {
        let append = incoming[full.len()..].to_string();
        if append.is_empty() {
            return None;
        }
        full.push_str(&append);
        return Some(append);
    }
    if full.ends_with(incoming) {
        return None;
    }
    let overlap = max_suffix_prefix_overlap(full, incoming);
    let append = incoming[overlap..].to_string();
    if append.is_empty() {
        return None;
    }
    full.push_str(&append);
    Some(append)
}

fn max_suffix_prefix_overlap(existing: &str, incoming: &str) -> usize {
    let max = existing.len().min(incoming.len());
    for len in (1..=max).rev() {
        if existing.is_char_boundary(existing.len() - len)
            && incoming.is_char_boundary(len)
            && existing[existing.len() - len..] == incoming[..len]
        {
            return len;
        }
    }
    0
}

fn parse_openai_tool_event(value: &Value, calls: &mut Vec<AgentToolCall>) {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "response.output_item.added" | "response.output_item.done" => {
            let item = match value.get("item") {
                Some(item) => item,
                None => return,
            };
            if item.get("type").and_then(Value::as_str) != Some("function_call") {
                return;
            }
            let id = item
                .get("id")
                .or_else(|| item.get("call_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if id.is_empty() && name.is_empty() {
                return;
            }
            let args = item
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let call = upsert_tool_call(calls, id, name);
            if !args.is_empty() {
                call.args_json = args;
            }
        }
        "response.function_call_arguments.delta" => {
            let id = value
                .get("item_id")
                .or_else(|| value.get("call_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if id.is_empty() {
                return;
            }
            let delta = value
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                return;
            }
            let call = upsert_tool_call(calls, id, String::new());
            call.args_json.push_str(delta);
        }
        "response.function_call_arguments.done" => {
            let id = value
                .get("item_id")
                .or_else(|| value.get("call_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if id.is_empty() {
                return;
            }
            let args = value
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if args.is_empty() {
                return;
            }
            let call = upsert_tool_call(calls, id, String::new());
            call.args_json = args;
        }
        _ => {}
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

fn parse_claude_tool_event(
    value: &Value,
    calls: &mut Vec<AgentToolCall>,
    current_tool_index: &mut Option<usize>,
) {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "content_block_start" => {
            let block = match value.get("content_block") {
                Some(block) => block,
                None => return,
            };
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                *current_tool_index = None;
                return;
            }
            let id = block
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let input = block
                .get("input")
                .filter(|input| !input.is_null())
                .map(Value::to_string)
                .unwrap_or_default();
            let call = AgentToolCall {
                id,
                name,
                args_json: input,
            };
            calls.push(call);
            *current_tool_index = Some(calls.len() - 1);
        }
        "content_block_delta" => {
            let delta = match value.get("delta") {
                Some(delta) => delta,
                None => return,
            };
            if delta.get("type").and_then(Value::as_str) != Some("input_json_delta") {
                return;
            }
            let partial = delta
                .get("partial_json")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if partial.is_empty() {
                return;
            }
            if let Some(index) = value
                .get("index")
                .and_then(Value::as_u64)
                .map(|v| v as usize)
            {
                if index < calls.len() {
                    calls[index].args_json.push_str(partial);
                    *current_tool_index = Some(index);
                    return;
                }
            }
            if let Some(index) = *current_tool_index {
                if index < calls.len() {
                    calls[index].args_json.push_str(partial);
                }
            }
        }
        "content_block_stop" => {
            *current_tool_index = None;
        }
        _ => {}
    }
}

fn upsert_tool_call(
    calls: &mut Vec<AgentToolCall>,
    id: String,
    name: String,
) -> &mut AgentToolCall {
    if let Some(index) = calls.iter().position(|call| call.id == id) {
        if !name.is_empty() && calls[index].name.is_empty() {
            calls[index].name = name;
        }
        return &mut calls[index];
    }
    calls.push(AgentToolCall {
        id,
        name,
        args_json: String::new(),
    });
    calls.last_mut().expect("tool call was just pushed")
}
