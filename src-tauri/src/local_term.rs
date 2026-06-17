use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Arc,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

pub type LocalStore = Arc<Mutex<HashMap<String, LocalHandle>>>;

pub struct LocalHandle {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    // Mutex makes Box<dyn MasterPty+Send> Sync, so Arc<Mutex<...>> is Send+Sync
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
}

#[derive(Serialize, Clone)]
pub struct LocalDataEvent {
    pub id: String,
    pub data: Vec<u8>,
}

#[tauri::command]
pub async fn local_start(
    cols: u16,
    rows: u16,
    store: State<'_, LocalStore>,
    app: AppHandle,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = if cfg!(windows) {
        "powershell.exe"
    } else {
        "bash"
    };
    pair.slave
        .spawn_command(CommandBuilder::new(shell))
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = Arc::new(Mutex::new(pair.master));

    let id = Uuid::new_v4().to_string();
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(64);

    // Read output → emit events
    let sid = id.clone();
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app2.emit(
                        "local-data",
                        LocalDataEvent {
                            id: sid.clone(),
                            data: buf[..n].to_vec(),
                        },
                    );
                }
            }
        }
        let _ = app2.emit("local-closed", &sid);
    });

    // Write input from channel
    tokio::task::spawn_blocking(move || {
        while let Some(data) = input_rx.blocking_recv() {
            if writer.write_all(&data).is_err() {
                break;
            }
        }
    });

    store
        .lock()
        .await
        .insert(id.clone(), LocalHandle { input_tx, master });
    Ok(id)
}

#[tauri::command]
pub async fn local_input(
    id: String,
    data: Vec<u8>,
    store: State<'_, LocalStore>,
) -> Result<(), String> {
    if let Some(h) = store.lock().await.get(&id) {
        h.input_tx.send(data).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn local_resize(
    id: String,
    cols: u16,
    rows: u16,
    store: State<'_, LocalStore>,
) -> Result<(), String> {
    if let Some(h) = store.lock().await.get(&id) {
        let _ = h.master.lock().await.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn local_stop(id: String, store: State<'_, LocalStore>) -> Result<(), String> {
    store.lock().await.remove(&id);
    Ok(())
}
