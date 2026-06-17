use crate::db::{AiMessage, AiProvider, AiToolRun, Db};
use crate::ssh::SessionStore;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration, Instant};

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
- You can only request execution. The user decides whether the command is actually approved and run.
- Do not attempt to bypass approval, hide commands, run background persistence, or operate in a solo/autonomous mode.
- Destructive, privilege-changing, credential-related, network-disruptive, or data-exfiltration commands require extra caution and a clear explanation.
- Do not silently discard conversation history. If context is close to the model limit and Shelly suggests a new session, tell the user clearly.
- Do not present guesses about host identity, cwd, OS, command results, or file contents as facts. Use available context or tools.
- Never write, simulate, quote, or invent a tool result block in an assistant message. Only Shelly-generated tool messages may contain command output.
- Never turn a suggested command into an executed command in prose. If you did not receive a real tool result, say it is only a suggestion.

[Tools]
You may request command execution with exec_command(cmd, purpose). Shelly will show the command to the user for approval before anything is written to the visible SSH terminal.
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
    run_agent_turn(
        &db,
        &app,
        &conversation,
        input.active_session_id.as_deref(),
        input.terminal_context.as_deref(),
    )
    .await
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

async fn run_agent_turn(
    db: &Db,
    app: &AppHandle,
    conversation: &crate::db::AiConversation,
    active_session_id: Option<&str>,
    terminal_context: Option<&str>,
) -> Result<(), String> {
    let mut messages = db.ai_messages(&conversation.id)?;
    let (provider, api_key) = select_provider_with_key(db, conversation)?;

    let prompt = build_prompt(
        &provider,
        &conversation.server_key,
        active_session_id,
        terminal_context,
        &messages,
    );
    let estimated_tokens = ((prompt.chars().count() as f64) / 4.0).ceil() as i64;
    db.touch_ai_conversation_tokens(&conversation.id, estimated_tokens)?;
    if estimated_tokens >= provider.context_window_tokens {
        return Err("Context is over the configured model limit. Create a new session or reduce context.".into());
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
        "openai_responses" => stream_openai(&provider, &api_key, &prompt, app, &conversation.id).await,
        "claude_messages" => stream_claude(&provider, &api_key, &prompt, app, &conversation.id).await,
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
                    emit_status(app, &conversation.id, "streaming", Some("retrying fake tool result"));
                    return Box::pin(run_agent_turn(
                        db,
                        app,
                        conversation,
                        active_session_id,
                        terminal_context,
                    ))
                    .await;
                }
                emit_status(app, &conversation.id, "error", Some(guard_message));
                return Ok(());
            }
            let assistant = if stream.text.trim().is_empty() {
                None
            } else {
                let assistant = db.append_ai_message(&conversation.id, "assistant", Some(&stream.text))?;
                messages.push(assistant.clone());
                Some(assistant)
            };
            if stream.tool_calls.is_empty() {
                if should_reprompt_for_missing_tool(&stream.text) && !last_message_is_tool_reprompt(&messages) {
                    db.append_ai_message(
                        &conversation.id,
                        "user",
                        Some("Shelly internal note: You said you would run or try another command, but no exec_command tool call was emitted. If a command is needed, call exec_command now with the exact command. If no command is needed, continue with a direct answer and do not say you will run one."),
                    )?;
                    emit_status(app, &conversation.id, "streaming", Some("retrying tool request"));
                    return Box::pin(run_agent_turn(
                        db,
                        app,
                        conversation,
                        active_session_id,
                        terminal_context,
                    ))
                    .await;
                }
                emit_status(app, &conversation.id, "done", None);
                return Ok(());
            }
            let mut approval_count = 0;
            for call in stream.tool_calls {
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
                    let blocked = db.finish_ai_tool_run(&tool_run.id, "blocked", &blocked_output, None)?;
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
                    continue;
                }
                approval_count += 1;
            }
            if approval_count > 0 {
                emit_status(app, &conversation.id, "waiting_approval", None);
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
pub fn ai_deny_tool(input: AiToolDecisionInput, db: State<'_, Db>) -> Result<AiToolRun, String> {
    db.set_ai_tool_approval(&input.tool_run_id, "denied")
}

#[tauri::command]
pub async fn ai_execute_approved_tool(
    input: AiExecuteToolInput,
    db: State<'_, Db>,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<AiToolRun, String> {
    let run = db.ai_tool_run(&input.tool_run_id)?;
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
    let (input_tx, output, before_len) = {
        let guard = sessions.lock().await;
        let session = guard
            .get(&input.active_session_id)
            .ok_or_else(|| "SSH session is not connected".to_string())?;
        let before = session.output.lock().await.clone();
        (session.input_tx.clone(), session.output.clone(), before.len())
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
    let cleaned = trim_tool_output(&strip_ansi(&captured.output), 20_000);
    let run_status = if captured.timed_out { "timeout" } else { "completed" };
    let finished = db.finish_ai_tool_run(&input.tool_run_id, run_status, &cleaned, captured.exit_code)?;
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
    )
    .await;
    Ok(finished)
}

#[tauri::command]
pub async fn ai_complete_interactive_tool(
    input: AiCompleteInteractiveToolInput,
    db: State<'_, Db>,
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
        return Err("Only interactive tool runs can be completed with an interactive handoff result.".into());
    }
    let command = run
        .command
        .clone()
        .ok_or_else(|| "tool run has no command".to_string())?;
    let cleaned = trim_tool_output(&strip_ansi(&input.output), 20_000);
    let output = if cleaned.trim().is_empty() {
        "Interactive handoff completed by user. No terminal output was captured.".to_string()
    } else {
        format!("Interactive handoff completed by user.\n{}", cleaned)
    };

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
        .is_some_and(|content| content.starts_with("Shelly internal safety note: You wrote or simulated"))
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
    Ok(ExecCommandArgs { cmd, purpose, interaction_tip })
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
    format!("[output truncated to last {max_chars} chars]\n{}", tail.trim())
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
    format!(
        "Tool result for exec_command\ncommand: {}\nstatus: {}\nexit_code: {}\noutput:\n{}",
        command,
        run.run_status,
        run.exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        run.output.as_deref().unwrap_or("")
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
        "命令",
        "检查",
        "执行",
        "运行",
        "网络",
        "磁盘",
        "内存",
        "command",
        "check",
        "inspect",
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

    let critical_patterns = ["rm -rf /", "--no-preserve-root", ":(){", "mkfs", "dd if=", "dd of=/dev/", "fdisk", "parted"];
    let high_patterns = ["reboot", "shutdown", "systemctl stop ssh", "systemctl stop sshd", "iptables -f", "ufw disable"];
    let medium_patterns = ["sudo su", "sudo bash", "passwd", "/etc/shadow", "mysqldump", "pg_dump", "tar "];

    if critical_patterns.iter().any(|pattern| lower.contains(pattern)) {
        level = "critical".to_string();
        reasons.push("matches destructive command pattern".to_string());
    } else if high_patterns.iter().any(|pattern| lower.contains(pattern)) {
        level = "high".to_string();
        reasons.push("may disrupt the SSH session or host availability".to_string());
    } else if medium_patterns.iter().any(|pattern| lower.contains(pattern)) {
        level = "medium".to_string();
        reasons.push("may involve privilege changes, credentials, or large data access".to_string());
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
        "read", "passwd", "vi", "vim", "nvim", "nano", "emacs", "top", "htop", "less", "more",
        "ssh", "sftp", "ftp", "telnet", "mysql", "psql", "redis-cli", "sqlite3", "python",
        "python3", "node", "irb", "pry", "rails", "bash", "sh", "zsh", "fish", "su",
    ];
    if interactive_heads.contains(&head) {
        if matches!(head, "python" | "python3" | "node" | "bash" | "sh" | "zsh" | "fish") {
            return !cmd.contains(" -c ") && !cmd.contains(" --command ");
        }
        if head == "mysql" || head == "psql" || head == "redis-cli" || head == "sqlite3" {
            return !cmd.contains(" -e ") && !cmd.contains(" -c ");
        }
        return true;
    }
    if cmd == "cat" || cmd.starts_with("cat >") || cmd.contains("| cat >") || cmd.contains("; cat") {
        return true;
    }
    if cmd.contains(" tail -f ") || cmd.starts_with("tail -f ") || cmd.contains(" journalctl -f") || cmd.starts_with("journalctl -f") {
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
    if messages.last().is_some_and(|msg| msg.role == "tool") {
        out.push_str("\n## Tool Result Follow-up\n");
        out.push_str("The latest message is a real Shelly tool result. Continue from that result now. Do not copy its format or write a new tool result yourself. If the next step requires another shell command, call exec_command in this response with the exact command. Do not say you will run a command unless you are calling exec_command now.\n");
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
) -> Result<AgentStreamResult, String> {
    let url = endpoint(&provider.base_url, "responses");
    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({
            "model": provider.model,
            "input": prompt,
            "stream": true,
            "tools": [exec_command_tool_schema_openai()],
            "tool_choice": "auto",
            "temperature": provider.temperature,
            "max_output_tokens": provider.max_tokens
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("OpenAI request failed: {}", res.text().await.unwrap_or_default()));
    }
    stream_openai_sse(res, app, conversation_id).await
}

async fn stream_claude(
    provider: &AiProvider,
    api_key: &str,
    prompt: &str,
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
            "tools": [exec_command_tool_schema_claude()],
            "messages": [{ "role": "user", "content": prompt }]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Claude request failed: {}", res.text().await.unwrap_or_default()));
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
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
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
            let delta = value.get("delta").and_then(Value::as_str).unwrap_or_default();
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
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
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
            if let Some(index) = value.get("index").and_then(Value::as_u64).map(|v| v as usize) {
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

fn upsert_tool_call(calls: &mut Vec<AgentToolCall>, id: String, name: String) -> &mut AgentToolCall {
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
