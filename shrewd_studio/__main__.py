"""`shrewd-studio`: serve Studio on this computer and open it in the browser."""

import argparse
import contextlib
import os
import socket
import subprocess
import sys
import threading
import time
import warnings
import webbrowser

from shrewd_studio import NOISE
from shrewd_studio.settings import DEFAULT_WORKSPACE


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main(argv=None):
    if sys.platform == "win32" and not sys.flags.utf8_mode:
        # Windows Python reads and writes text in the ANSI code page unless UTF-8 mode is on,
        # which can't hold every prompt, label or document; shrewd's files are UTF-8. Run
        # Studio in UTF-8 mode (the desktop app starts it that way already).
        args = sys.argv[1:] if argv is None else argv
        done = subprocess.run([sys.executable, "-X", "utf8", "-m", "shrewd_studio", *args],
                              check=False)
        sys.exit(done.returncode)
    warnings.filterwarnings("ignore", message=NOISE, category=UserWarning)
    parser = argparse.ArgumentParser(prog="shrewd-studio", description=__doc__)
    parser.add_argument("--workspace", default=None,
                        help="folder holding your model folders (default: "
                             "$SHREWD_STUDIO_WORKSPACE, else the folder chosen in Settings, "
                             "else shrewd-models in your home folder)")
    parser.add_argument("--port", type=int, default=8765, help="0 picks a free port")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    parser.add_argument("--sandbox", action="store_true",
                        help="simulated teachers: no API keys, no spending (for trying Studio)")
    parser.add_argument("--samples", action="store_true",
                        help="add the sample models to the workspace (needs --sandbox)")
    args = parser.parse_args(argv)
    if args.samples and not args.sandbox:
        parser.error("--samples are built with simulated teachers; add --sandbox")

    from shrewd_studio.settings import Settings

    settings = Settings()
    workspace, source = where(args, settings)
    # the desktop app reads the line announcing the URL as UTF-8; Windows pipes default to
    # the ANSI code page, which can't print every folder name
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8", errors="replace")

    if args.sandbox:
        from shrewd_studio import sandbox

        sandbox.install(workspace)

    import uvicorn

    from shrewd_studio.server import create_app

    if args.samples:
        from shrewd_studio import samples

        print("building the sample models with simulated teachers...", flush=True)
        made = samples.build(workspace)
        print(f"added {len(made)} sample models" if made else "sample models already there")

    port = args.port or free_port()
    again = []

    def restart():
        """Stop serving, then start again on the same port (below), so open windows reconnect
        and the folders saved in Settings are opened."""
        again.append(True)
        server.should_exit = True

    app = create_app(workspace, sandbox=args.sandbox, settings=settings, workspace_source=source,
                     default_workspace=DEFAULT_WORKSPACE, restart=restart)
    url = f"http://127.0.0.1:{port}/"
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                           timeout_graceful_shutdown=3))

    def announce():
        # the desktop shell opens its window on this exact line, so it's printed only once
        # the server accepts connections
        while not server.started:
            time.sleep(0.05)
        print(f"Shrewd Studio on {url} (workspace {app.state.root})", flush=True)
        if not args.no_browser:
            webbrowser.open(url)

    threading.Thread(target=announce, daemon=True).start()
    if os.environ.get("SHREWD_STUDIO_DESKTOP"):
        threading.Thread(target=orphaned, args=(desktop_app(), server), daemon=True).start()
    server.run()
    if again:
        argv = ["--port", str(port), "--no-browser"]
        argv += ["--workspace", args.workspace] if args.workspace else []
        argv += ["--sandbox"] if args.sandbox else []
        os.execv(sys.executable, [sys.executable, "-m", "shrewd_studio", *argv])


def desktop_app():
    """The desktop app's process id: it passes its own in SHREWD_STUDIO_DESKTOP (on Windows
    the server's parent can be a launcher in between); else the parent's."""
    value = os.environ.get("SHREWD_STUDIO_DESKTOP", "")
    return int(value) if value.isdigit() and int(value) > 1 else os.getppid()


def orphaned(app, server):
    """Stop once the desktop app that started this server is gone. It stops the server when it
    quits, but a force-quit or crash skips that, and the server would keep holding its port."""
    parent = os.getppid()
    while running(app) and not (app == parent and os.getppid() != parent):
        time.sleep(1)
    server.should_exit = True


def running(pid):
    """Whether a process is still there (an orphan on macOS and Linux is also handed to a new
    parent, checked above, which catches it sooner)."""
    if sys.platform == "win32":
        import ctypes

        kernel = ctypes.windll.kernel32
        handle = kernel.OpenProcess(0x00100000, False, pid)        # SYNCHRONIZE
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT: running
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)                                           # signal 0 only checks
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def where(args, settings):
    """The workspace and what chose it: the --workspace flag, $SHREWD_STUDIO_WORKSPACE, the
    folder saved in Settings, or the default."""
    if args.workspace:
        return args.workspace, "flag"
    if os.environ.get("SHREWD_STUDIO_WORKSPACE"):
        return os.environ["SHREWD_STUDIO_WORKSPACE"], "env"
    if settings["storage"].get("workspace"):
        return settings["storage"]["workspace"], "settings"
    return str(DEFAULT_WORKSPACE), "default"


if __name__ == "__main__":
    main()
