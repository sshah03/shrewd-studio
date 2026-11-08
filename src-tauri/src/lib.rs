//! The desktop shell. Studio itself is a Python server (`shrewd-studio`), because shrewd is a
//! Python library; this shell starts it on a free port, waits for the line it prints when it
//! is listening, points the window at it, and stops it when the window closes.
//!
//! Which server to start: `SHREWD_STUDIO_CMD` if set (a full command line), else
//! `shrewd-studio` found on the PATH a Terminal window would have. An app opened from Finder
//! gets only launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which misses where pip, pipx and
//! uv put commands, so the shell asks the login shell for its PATH and gives the server that
//! too (the server runs pip and uv). Windows and Linux desktops pass apps the user's PATH, so
//! there the PATH the app was given is used, plus the usual install folders. The server picks
//! the workspace itself ($SHREWD_STUDIO_WORKSPACE, else the folder chosen in Settings, else
//! shrewd-models in the home folder), the same as from a terminal. Changing a folder in
//! Settings restarts the server in place (same process, same port); it prints its URL again
//! and the window follows it.
//!
//! The View menu's "Always Show Search" keeps the page's search field open instead of folded to
//! a magnifying glass. The shell remembers it (view.txt in the app's config folder) and tells
//! the page: in the URL it opens, so the first paint is right, and by calling its studioView.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, Url};

struct Server(Mutex<Option<Child>>);
/// Why the server didn't start, kept so the splash page can show it whenever it finishes
/// loading: the message, and the command that installs Studio when that's what's missing.
struct StartupError(Mutex<Option<(String, Option<String>)>>);

/// The View menu item that keeps the search field open, and how view.txt says it's on.
const SHOW_SEARCH: &str = "always-show-search";

fn view_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("view.txt"))
}

fn search_pinned(app: &tauri::AppHandle) -> bool {
    view_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .is_some_and(|text| text.lines().any(|l| l.trim() == SHOW_SEARCH))
}

fn save_search_pinned(app: &tauri::AppHandle, on: bool) {
    let Some(file) = view_file(app) else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, if on { format!("{SHOW_SEARCH}\n") } else { String::new() });
}

/// Tell the page (if it's Studio's, not the splash page) whether to keep search open.
fn tell_view(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let on = search_pinned(app);
        let _ = window.eval(format!("window.studioView && window.studioView({{alwaysShowSearch: {on}}})"));
    }
}

/// The platform's usual menu with "Always Show Search" at the top of View. macOS's menu has a
/// View menu (Enter Full Screen); elsewhere one is added before Window and Help.
fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let item = CheckMenuItem::with_id(app, SHOW_SEARCH, "Always Show Search", true, search_pinned(app), None::<&str>)?;
    let view = menu.items()?.into_iter().find_map(|kind| match kind {
        MenuItemKind::Submenu(sub) if sub.text().ok().as_deref() == Some("View") => Some(sub),
        _ => None,
    });
    match view {
        Some(view) => {
            view.insert(&item, 0)?;
            view.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        }
        None => {
            let view = Submenu::with_items(app, "View", true, &[&item])?;
            let at = menu.items()?.len().saturating_sub(2);
            menu.insert(&view, at)?;
        }
    }
    Ok(menu)
}

/// How the splash page says to install Studio's Python package when it isn't found. uv puts
/// the command in ~/.local/bin, which the shell searches on every system (see search_path).
const INSTALL: &str = "uv tool install git+https://github.com/sshah03/shrewd-studio";

/// Why the server can't be started: Studio isn't installed (the splash page offers the install
/// command and a way to try again), or anything else, said in a sentence.
#[derive(Debug, PartialEq)]
enum Problem {
    NotInstalled,
    Other(String),
}

impl Problem {
    fn message(&self) -> String {
        match self {
            Problem::NotInstalled => "Studio's Python package isn't installed yet. Install it from a \
                                      terminal, then try again."
                .into(),
            Problem::Other(why) => why.clone(),
        }
    }
}

fn home() -> String {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default()
}

/// The PATH a Terminal window has. `-i` reads .zshrc/.bashrc, where installers usually add
/// their folders; the markers skip anything those files print. A shell that takes more than
/// three seconds is given up on.
#[cfg(unix)]
fn shell_path() -> Option<OsString> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-ilc", "printf '__PATH__%s__PATH__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    for _ in 0..60 {
        if child.try_wait().ok()?.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if child.try_wait().ok()?.is_none() {
        let _ = child.kill();
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let start = out.find("__PATH__")? + "__PATH__".len();
    let end = start + out[start..].find("__PATH__")?;
    Some(out[start..end].into())
}

#[cfg(not(unix))]
fn shell_path() -> Option<OsString> {
    None
}

/// The shell's PATH (or our own), plus the usual install folders in case the shell's
/// config doesn't add them: where pipx and `uv tool` put commands, and Homebrew's folders.
fn search_path() -> OsString {
    let base = shell_path().or_else(|| std::env::var_os("PATH")).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&base).collect();
    let mut extras = vec![PathBuf::from(home()).join(".local").join("bin")];
    if cfg!(unix) {
        extras.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    for extra in extras {
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    std::env::join_paths(dirs).unwrap_or(base)
}

/// Split SHREWD_STUDIO_CMD into words: spaces separate them, except inside "double" or
/// 'single' quotes, so a path with spaces in it can be quoted. No escapes: Windows paths are
/// full of backslashes.
fn words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let (mut quote, mut started) = (None, false);
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started || !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
                started = false;
            }
            (None, c) => word.push(c),
        }
    }
    if started || !word.is_empty() {
        out.push(word);
    }
    out
}

fn find(program: &str, path: &OsString) -> Option<PathBuf> {
    let names = if cfg!(windows) { vec![format!("{program}.exe"), program.into()] } else { vec![program.into()] };
    std::env::split_paths(path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

fn command() -> Result<Command, Problem> {
    let line = std::env::var("SHREWD_STUDIO_CMD").ok().filter(|l| !l.trim().is_empty());
    let mut parts = words(line.as_deref().unwrap_or("shrewd-studio")).into_iter();
    let program = parts.next().unwrap_or_else(|| "shrewd-studio".into());
    let path = search_path();
    let resolved = if program.contains('/') || program.contains(std::path::MAIN_SEPARATOR) {
        PathBuf::from(&program)
    } else {
        find(&program, &path).ok_or_else(|| match &line {
            Some(_) => Problem::Other(format!("Couldn't find {program}, from SHREWD_STUDIO_CMD.")),
            None => Problem::NotInstalled,
        })?
    };
    let mut cmd = Command::new(resolved);
    // SHREWD_STUDIO_DESKTOP: this app's process id, so the server stops by itself if the app
    // is force-quit. PYTHONUTF8: text files and pipes in UTF-8 on Windows too, which
    // otherwise uses the ANSI code page (the URL line is read as UTF-8).
    cmd.args(parts)
        .env("PATH", &path)
        .env("SHREWD_STUDIO_DESKTOP", std::process::id().to_string())
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
    cmd.args(["--port", "0", "--no-browser"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // a console program started from a windowed app opens a console window without this
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    Ok(cmd)
}

/// The URL from the server's "Shrewd Studio on http://127.0.0.1:PORT/ ..." line.
fn url_in(line: &str) -> Option<Url> {
    let start = line.find("http://127.0.0.1:")?;
    let rest = &line[start..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    Url::parse(&rest[..end]).ok()
}

/// Wait (up to ten seconds) until the server accepts connections, so the window never opens
/// on a port that isn't listening yet.
fn wait_for(url: &Url) {
    let Some(port) = url.port() else { return };
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    for _ in 0..200 {
        if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn show_error(app: &tauri::AppHandle, problem: &Problem) {
    let install = (*problem == Problem::NotInstalled).then(|| INSTALL.to_string());
    app.state::<StartupError>().0.lock().unwrap().replace((problem.message(), install));
    eval_error(app);
}

/// Put the error on the splash page; called again when the page finishes loading, since the
/// server can fail before the page has defined showStartupError.
fn eval_error(app: &tauri::AppHandle) {
    let Some((message, install)) = app.state::<StartupError>().0.lock().unwrap().clone() else { return };
    if let Some(window) = app.get_webview_window("main") {
        let text = serde_escape(&message);
        let install = install.as_deref().map(serde_escape).unwrap_or_else(|| "null".into());
        let _ = window.eval(format!("window.showStartupError && window.showStartupError({text}, {install})"));
    }
}

fn serde_escape(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Pass the server's stderr through, keeping its last lines in case it stops before it's ready.
fn keep_tail(stderr: impl Read + Send + 'static) -> (Arc<Mutex<VecDeque<String>>>, std::thread::JoinHandle<()>) {
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let kept = tail.clone();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
            if line.trim().is_empty() {
                continue;
            }
            let mut tail = kept.lock().unwrap();
            if tail.len() == 6 {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
    (tail, reader)
}

fn start(app: &tauri::AppHandle) -> Result<(), Problem> {
    let mut child = command()?
        .spawn()
        .map_err(|err| Problem::Other(format!("Couldn't start the Studio server ({err}).")))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let (tail, reader) = keep_tail(child.stderr.take().expect("piped stderr"));
    app.state::<Server>().0.lock().unwrap().replace(child);
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut started = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(mut url) = url_in(&line) {
                started = true;
                wait_for(&url);
                // tells the page it is inside the app window, which draws its own frame and
                // title bar, and whether to keep search open
                url.set_query(Some(if search_pinned(&handle) { "desktop=1&search=pinned" } else { "desktop=1" }));
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.navigate(url);
                }
            }
        }
        // stdout closed: the server exited. Before it was ready, say why.
        if !started {
            let _ = reader.join();
            let why = tail.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
            show_error(&handle, &Problem::Other(format!("The Studio server stopped before it was ready.\n\n{why}")));
        }
    });
    Ok(())
}

/// Start the server off the main thread: finding the shell's PATH can take a moment, and the
/// window shouldn't wait for it.
fn spawn_start(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        if let Err(problem) = start(&handle) {
            show_error(&handle, &problem);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(Server(Mutex::new(None)))
        .manage(StartupError(Mutex::new(None)))
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let app = webview.app_handle();
            // the splash page's "Try again" reloads it with ?retry: start the server again if
            // it isn't running, after Studio has been installed, say
            let retry = payload.url().query_pairs().any(|(k, _)| k == "retry");
            let stopped = {
                let state = app.state::<Server>();
                let mut server = state.0.lock().unwrap();
                let exited = server.as_mut().map_or(true, |c| c.try_wait().ok().flatten().is_some());
                if exited {
                    server.take();
                }
                exited
            };
            if retry && stopped {
                app.state::<StartupError>().0.lock().unwrap().take();
                spawn_start(app.clone());
            } else {
                eval_error(app);
            }
            tell_view(app);
        })
        .menu(menu)
        .on_menu_event(|app, event| {
            if event.id() != SHOW_SEARCH {
                return;
            }
            // the item has already toggled itself. Menu::get looks only at the top level, and the
            // item is inside View, so look in each submenu.
            let item = app.menu().and_then(|m| m.items().ok()).into_iter().flatten().find_map(|kind| match kind {
                MenuItemKind::Submenu(sub) => sub.get(SHOW_SEARCH),
                _ => None,
            });
            if let Some(MenuItemKind::Check(item)) = item {
                save_search_pinned(app, item.is_checked().unwrap_or(false));
                tell_view(app);
            }
        })
        .setup(|app| {
            spawn_start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Shrewd Studio");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{find, serde_escape, url_in, words, Problem, INSTALL};

    #[test]
    fn says_studio_is_missing_and_how_to_install_it() {
        assert!(Problem::NotInstalled.message().contains("isn't installed"));
        assert_eq!(Problem::Other("boom".into()).message(), "boom");
        assert!(INSTALL.starts_with("uv tool install "));
        // the message and command go into the page as JavaScript string literals
        assert_eq!(serde_escape("a \"b\" c\\d\ne"), "\"a \\\"b\\\" c\\\\d\\ne\"");
    }

    #[test]
    fn reads_the_url_from_the_server_line() {
        let url = url_in("Shrewd Studio on http://127.0.0.1:53111/ (workspace /tmp/runs)").unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:53111/");
        assert!(url_in("starting").is_none());
    }

    #[test]
    fn splits_a_command_line_with_quoted_paths() {
        assert_eq!(words("shrewd-studio --sandbox"), ["shrewd-studio", "--sandbox"]);
        assert_eq!(
            words(r#""C:\Program Files\Py\shrewd-studio.exe"  --sandbox"#),
            [r"C:\Program Files\Py\shrewd-studio.exe", "--sandbox"]
        );
        assert_eq!(words("'/Users/a b/venv/bin/shrewd-studio'"), ["/Users/a b/venv/bin/shrewd-studio"]);
        assert!(words("   ").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn finds_a_program_on_a_path() {
        let path = std::env::join_paths(["/nonexistent", "/bin"]).unwrap();
        assert_eq!(find("sh", &path), Some("/bin/sh".into()));
        assert_eq!(find("no-such-program-here", &path), None);
    }
}
