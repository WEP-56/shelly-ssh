mod ssh;
mod local_term;
use ssh::{SessionStore, ssh_connect, ssh_input, ssh_resize, ssh_disconnect};
use local_term::{LocalStore, local_start, local_input, local_resize, local_stop};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

pub fn run() {
    tauri::Builder::default()
        .manage(SessionStore::new(Mutex::new(HashMap::new())))
        .manage(Arc::new(Mutex::new(HashMap::new())) as LocalStore)
        .invoke_handler(tauri::generate_handler![
            ssh_connect, ssh_input, ssh_resize, ssh_disconnect,
            local_start, local_input, local_resize, local_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error running shelly");
}
