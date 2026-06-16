use std::{collections::HashMap, sync::Arc, time::Duration};
use async_trait::async_trait;
use russh::{client, ChannelMsg};
use russh_keys::ssh_key::PublicKey;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

pub type SessionStore = Arc<Mutex<HashMap<String, SessionHandle>>>;

pub struct SessionHandle {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub resize_tx: mpsc::Sender<(u32, u32)>,
    pub _handle: client::Handle<ShellyHandler>,
}

#[derive(Serialize, Clone)]
pub struct SshDataEvent {
    pub id: String,
    pub data: Vec<u8>,
}

pub struct ShellyHandler;

#[async_trait]
impl client::Handler for ShellyHandler {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(true) // MVP: accept all host keys
    }
}

#[tauri::command]
pub async fn ssh_connect(
    host: String,
    port: u16,
    username: String,
    password: String,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<String, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let mut handle = client::connect(config, (host.as_str(), port), ShellyHandler)
        .await
        .map_err(|e| e.to_string())?;

    let ok = handle.authenticate_password(&username, &password).await.map_err(|e| e.to_string())?;
    if !ok { return Err("Authentication failed".into()); }

    let mut channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_pty(false, "xterm-256color", 80, 24, 0, 0, &[]).await.map_err(|e| e.to_string())?;
    channel.request_shell(false).await.map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u32, u32)>(8);

    let sid = id.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        let _ = app.emit("ssh-data", SshDataEvent { id: sid.clone(), data: data.to_vec() });
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        let _ = app.emit("ssh-data", SshDataEvent { id: sid.clone(), data: data.to_vec() });
                    }
                    None | Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
                    _ => {}
                },
                Some(data) = input_rx.recv() => { let _ = channel.data(data.as_slice()).await; }
                Some((cols, rows)) = resize_rx.recv() => { let _ = channel.window_change(cols, rows, 0, 0).await; }
            }
        }
        let _ = app.emit("ssh-closed", &sid);
    });

    sessions.lock().await.insert(id.clone(), SessionHandle { input_tx, resize_tx, _handle: handle });
    Ok(id)
}

#[tauri::command]
pub async fn ssh_input(id: String, data: Vec<u8>, sessions: State<'_, SessionStore>) -> Result<(), String> {
    if let Some(s) = sessions.lock().await.get(&id) {
        s.input_tx.send(data).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(id: String, cols: u32, rows: u32, sessions: State<'_, SessionStore>) -> Result<(), String> {
    if let Some(s) = sessions.lock().await.get(&id) {
        let _ = s.resize_tx.send((cols, rows)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(id: String, sessions: State<'_, SessionStore>) -> Result<(), String> {
    sessions.lock().await.remove(&id);
    Ok(())
}
