mod ai;
mod db;
mod file_jobs;
mod local_term;
mod ssh;
use ai::{ai_read_terminal, ai_send_message};
use db::{
    db_bind_ai_conversation_session, db_create_ai_conversation, db_delete_ai_conversation,
    db_delete_ai_provider, db_get_ai_conversation, db_list_ai_conversations,
    db_list_ai_messages, db_list_ai_providers, db_list_ai_session_snapshots,
    db_add_command_history, db_delete_device, db_delete_device_password, db_delete_snippet,
    db_get_device_password, db_list_command_history, db_list_devices, db_list_snippets,
    db_save_ai_provider, db_save_device, db_save_device_password, db_save_snippet,
    db_set_default_ai_provider, db_update_device_session, Db,
};
use file_jobs::{
    file_cancel_job, file_list_jobs, file_queue_create_file, file_queue_delete,
    file_queue_download, file_queue_list_dir, file_queue_mkdir, file_queue_preview,
    file_queue_rename, file_queue_upload, FileJobStore,
};
use local_term::{local_input, local_resize, local_start, local_stop, LocalStore};
use ssh::{ssh_connect, ssh_disconnect, ssh_input, ssh_resize, SessionStore};
use std::{collections::HashMap, sync::Arc};
use tauri::Manager;
use tokio::sync::Mutex;

pub fn run() {
    tauri::Builder::default()
        .manage(SessionStore::new(Mutex::new(HashMap::new())))
        .manage(Arc::new(Mutex::new(HashMap::new())) as LocalStore)
        .manage(Arc::new(Mutex::new(HashMap::new())) as FileJobStore)
        .setup(|app| {
            let db = Db::open(app.handle()).map_err(std::io::Error::other)?;
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_input,
            ssh_resize,
            ssh_disconnect,
            local_start,
            local_input,
            local_resize,
            local_stop,
            db_list_devices,
            db_save_device,
            db_update_device_session,
            db_delete_device,
            db_get_device_password,
            db_save_device_password,
            db_delete_device_password,
            db_add_command_history,
            db_list_command_history,
            db_list_snippets,
            db_save_snippet,
            db_delete_snippet,
            db_list_ai_providers,
            db_save_ai_provider,
            db_delete_ai_provider,
            db_set_default_ai_provider,
            db_create_ai_conversation,
            db_list_ai_conversations,
            db_get_ai_conversation,
            db_delete_ai_conversation,
            db_bind_ai_conversation_session,
            db_list_ai_session_snapshots,
            db_list_ai_messages,
            ai_read_terminal,
            ai_send_message,
            file_queue_list_dir,
            file_queue_preview,
            file_queue_download,
            file_queue_upload,
            file_queue_delete,
            file_queue_rename,
            file_queue_mkdir,
            file_queue_create_file,
            file_list_jobs,
            file_cancel_job,
        ])
        .run(tauri::generate_context!())
        .expect("error running shelly");
}
