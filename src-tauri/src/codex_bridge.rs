use crate::{agents::*, core_base_dir, usage, GuiConfigState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;
static IMPORT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct BridgeConfig {
    pub enabled: bool,
    pub start_on_launch: bool,
    pub port: u16,
    pub api_key: String,
    pub node_path: String,
    pub codex_path: String,
    pub codex_home: String,
    pub cpa_marker: String,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self { enabled: false, start_on_launch: false, port: 8320, api_key: String::new(),
            node_path: String::new(), codex_path: String::new(), codex_home: String::new(), cpa_marker: String::new() }
    }
}

#[derive(Default)]
pub(crate) struct BridgeState {
    operation: Mutex<()>,
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
    shutdown: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeStatus {
    config: BridgeConfig,
    running: bool,
    pid: Option<u32>,
    node_available: bool,
    codex_available: bool,
    last_error: Option<String>,
    base_url: String,
}

fn root() -> Result<PathBuf, String> { Ok(core_base_dir()?.join("codex-bridge")) }

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn executable(configured: &str, names: &[&str]) -> Option<PathBuf> {
    if !configured.trim().is_empty() {
        let path = PathBuf::from(configured.trim());
        return (path.is_absolute() && agent_cli_executable(&path)).then_some(path);
    }
    find_named_agent_executable(&home(), names).or_else(|| find_named_agent_executable_in_directories(&[home().join(".local/node/bin")], names))
}

fn validate(config: &BridgeConfig, core_port: u16) -> Result<(), String> {
    if config.port == 0 || config.port == core_port { return Err("Bridge port must be nonzero and different from the CPA port.".into()); }
    if config.enabled && (config.api_key.is_empty() || !config.api_key.bytes().all(|b| (0x21..=0x7e).contains(&b))) {
        return Err("An enabled bridge requires a nonempty API key containing only visible ASCII characters without spaces.".into());
    }
    if config.api_key.len() > 4096 { return Err("Bridge API key is too long.".into()); }
    if !config.codex_home.trim().is_empty() && !Path::new(&config.codex_home).is_absolute() {
        return Err("Codex home must be an absolute directory path.".into());
    }
    Ok(())
}

fn scripts(directory: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    for (name, content) in [
        ("server.mjs", include_str!("../../scripts/codex-bridge/server.mjs")),
        ("app-server.mjs", include_str!("../../scripts/codex-bridge/app-server.mjs")),
        ("tool-sessions.mjs", include_str!("../../scripts/codex-bridge/tool-sessions.mjs")),
        ("usage.mjs", include_str!("../../scripts/codex-bridge/usage.mjs")),
    ] {
        fs::write(directory.join(name), content).map_err(|e| e.to_string())?;
    }
    Ok(directory.join("server.mjs"))
}

fn health_matches(port: u16, instance: &str) -> bool {
    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else { return false; };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
    if stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut bytes = Vec::new();
    if stream.take(16384).read_to_end(&mut bytes).is_err() { return false; }
    let text = String::from_utf8_lossy(&bytes);
    text.split_once("\r\n\r\n").and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
        .is_some_and(|body| body.get("instance_id").and_then(Value::as_str) == Some(instance))
}

fn stop_inner(state: &BridgeState) -> Result<(), String> {
    let mut lock = state.child.lock().map_err(|_| "Bridge process lock poisoned")?;
    if let Some(mut child) = lock.take() {
        // The Node parent guard treats EOF as a graceful shutdown request.
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            thread::sleep(Duration::from_millis(30));
        }
    }
    Ok(())
}

fn start_inner(app: &tauri::AppHandle, config: &BridgeConfig) -> Result<(), String> {
    let state = app.state::<BridgeState>();
    if state.shutdown.load(Ordering::Acquire) { return Err("Application is exiting.".into()); }
    validate(config, app.state::<GuiConfigState>().snapshot()?.port)?;
    stop_inner(&state)?;
    if !config.enabled {
        *state.last_error.lock().map_err(|_| "Bridge status lock poisoned")? = None;
        return Ok(());
    }
    let node = executable(&config.node_path, &["node"]).ok_or("Node.js 22+ was not found. Install Node or configure its absolute path.")?;
    let codex = executable(&config.codex_path, &["codex"]).ok_or("Codex CLI was not found. Install and sign in to Codex, or configure its absolute path.")?;
    let output = Command::new(&node).arg("--version").output().map_err(|e| e.to_string())?;
    let version = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || version.trim().trim_start_matches('v').split('.').next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0) < 22 {
        return Err("The bridge requires Node.js 22 or newer.".into());
    }
    let port_check = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)).map_err(|_| format!("Bridge port {} is already in use. Stop the standalone bridge or choose another port.", config.port))?;
    let base = root()?;
    let script = scripts(&base.join("runtime"))?;
    let instance = new_marker()?;
    let mut command = Command::new(node.clone());
    command.arg(script).current_dir(&base).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
        .env("PATH", agent_command_path(&home(), &node)?)
        .env("CODEX_BRIDGE_HOST", "127.0.0.1").env("CODEX_BRIDGE_PORT", config.port.to_string())
        .env("CODEX_BRIDGE_API_KEY", &config.api_key).env("CODEX_BRIDGE_COMMAND", codex)
        .env("CODEX_BRIDGE_PARENT_GUARD", "1").env("CODEX_BRIDGE_INSTANCE_ID", &instance)
        .env("CODEX_BRIDGE_CPA_MARKER", &config.cpa_marker)
        .env("CODEX_BRIDGE_USAGE_DIR", base.join("usage-inbox"));
    if config.codex_home.trim().is_empty() { command.env_remove("CODEX_BRIDGE_CODEX_HOME"); }
    else { command.env("CODEX_BRIDGE_CODEX_HOME", &config.codex_home); }
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    drop(port_check);
    let mut child = command.spawn().map_err(|e| format!("Cannot start bridge: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { return Err("Bridge exited during startup. Check Node.js, the port, and the configured paths.".into()); }
        if health_matches(config.port, &instance) {
            *state.child.lock().map_err(|_| "Bridge process lock poisoned")? = Some(child);
            *state.last_error.lock().map_err(|_| "Bridge status lock poisoned")? = None;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    drop(child.stdin.take());
    let _ = child.kill();
    let _ = child.wait();
    Err("Bridge startup timed out.".into())
}

fn new_marker() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "System randomness unavailable".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn status(app: &tauri::AppHandle) -> Result<BridgeStatus, String> {
    let config = app.state::<GuiConfigState>().snapshot()?.codex_bridge;
    let state = app.state::<BridgeState>();
    let mut child = state.child.lock().map_err(|_| "Bridge process lock poisoned")?;
    let mut pid = None;
    if let Some(process) = child.as_mut() {
        if process.try_wait().map_err(|e| e.to_string())?.is_none() { pid = Some(process.id()); }
        else { *child = None; *state.last_error.lock().map_err(|_| "Bridge status lock poisoned")? = Some("Bridge process exited.".into()); }
    }
    let last_error = state.last_error.lock().map_err(|_| "Bridge status lock poisoned")?.clone();
    Ok(BridgeStatus { running: pid.is_some(), pid, node_available: executable(&config.node_path, &["node"]).is_some(),
        codex_available: executable(&config.codex_path, &["codex"]).is_some(),
        last_error,
        base_url: format!("http://127.0.0.1:{}/v1", config.port), config })
}

#[tauri::command]
pub(crate) async fn get_codex_bridge(app: tauri::AppHandle) -> Result<BridgeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_codex_bridge(app: tauri::AppHandle, mut config: BridgeConfig) -> Result<BridgeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BridgeState>();
        let _operation = state.operation.lock().map_err(|_| "Bridge operation lock poisoned")?;
        let settings = app.state::<GuiConfigState>();
        validate(&config, settings.snapshot()?.port)?;
        if config.cpa_marker.is_empty() { config.cpa_marker = new_marker()?; }
        settings.update(|current| { current.codex_bridge = config.clone(); Ok(()) })?;
        if let Err(error) = start_inner(&app, &config) {
            *state.last_error.lock().map_err(|_| "Bridge status lock poisoned")? = Some(error.clone());
            return Err(error);
        }
        status(&app)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn control_codex_bridge(app: tauri::AppHandle, action: String) -> Result<BridgeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BridgeState>();
        let _operation = state.operation.lock().map_err(|_| "Bridge operation lock poisoned")?;
        match action.as_str() {
            "start" | "restart" => {
                let config = app.state::<GuiConfigState>().snapshot()?.codex_bridge;
                if !config.enabled { return Err("Enable and save the bridge configuration first.".into()); }
                start_inner(&app, &config)?;
            }
            "stop" => stop_inner(&state)?,
            _ => return Err("Unknown bridge action.".into()),
        }
        status(&app)
    }).await.map_err(|e| e.to_string())?
}

fn import_usage(app: &tauri::AppHandle) -> Result<(), String> {
    let _import = IMPORT_LOCK.lock().map_err(|_| "Bridge usage import lock poisoned")?;
    let directory = root()?.join("usage-inbox");
    if !directory.exists() { return Ok(()); }
    let enabled = app.state::<GuiConfigState>().snapshot()?.usage_statistics_enabled;
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())?
        .filter(|entry| entry.as_ref().is_ok_and(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))).take(500) {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file() || metadata.len() > 65536 { continue; }
        let event: Value = match serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?) {
            Ok(event) => event,
            Err(_) => { let _ = fs::rename(&path, path.with_extension("bad")); continue; }
        };
        if enabled { usage::persist_local_usage_event(app, "codex_bridge", event)?; }
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn initialize(app: tauri::AppHandle) {
    thread::spawn(move || {
        let result = (|| {
            let config = app.state::<GuiConfigState>().snapshot()?.codex_bridge;
            if config.enabled && config.start_on_launch {
                let state = app.state::<BridgeState>();
                let _operation = state.operation.lock().map_err(|_| "Bridge operation lock poisoned")?;
                start_inner(&app, &config)?;
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            let state = app.state::<BridgeState>();
            if let Ok(mut last) = state.last_error.lock() { *last = Some(error); };
        }
        while !app.state::<BridgeState>().shutdown.load(Ordering::Acquire) {
            if let Err(error) = import_usage(&app) { eprintln!("Cannot import bridge usage: {error}"); }
            thread::sleep(Duration::from_secs(1));
        }
        let _ = import_usage(&app);
    });
}

pub(crate) fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<BridgeState>();
    state.shutdown.store(true, Ordering::Release);
    if let Ok(_operation) = state.operation.lock() { let _ = stop_inner(&state); }
    let _ = import_usage(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_is_opt_in_and_requires_authentication() {
        let mut config = BridgeConfig::default();
        assert!(!config.enabled && !config.start_on_launch);
        assert!(validate(&config, 8317).is_ok());
        config.enabled = true;
        assert!(validate(&config, 8317).is_err());
        config.api_key = "test-key".into();
        assert!(validate(&config, 8317).is_ok());
        config.port = 8317;
        assert!(validate(&config, 8317).is_err());
    }
    #[test]
    fn embedded_runtime_includes_all_imports() {
        let directory = crate::unique_test_temp_path("codex-bridge-runtime");
        scripts(&directory).unwrap();
        for name in ["server.mjs", "app-server.mjs", "tool-sessions.mjs", "usage.mjs"] { assert!(directory.join(name).is_file()); }
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn bridge_configuration_round_trips_through_the_real_writer() {
        let directory = crate::unique_test_temp_path("codex-bridge-config");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.toml");
        let mut config = crate::GuiConfigFile::default();
        config.management_secret_key = "bridge-test-management-key".into();
        config.codex_bridge.enabled = true;
        config.codex_bridge.start_on_launch = true;
        config.codex_bridge.api_key = "bridge-test-key".into();
        config.codex_bridge.cpa_marker = "test-marker".into();
        crate::write_gui_config_to_path(&config, &path).unwrap();
        let loaded: crate::GuiConfigFile = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(loaded.codex_bridge.enabled && loaded.codex_bridge.start_on_launch);
        assert_eq!(loaded.codex_bridge.api_key, "bridge-test-key");
        assert_eq!(loaded.codex_bridge.cpa_marker, "test-marker");
        fs::remove_dir_all(directory).unwrap();
    }
}
