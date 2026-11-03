"""Starting the server: what it watches when the desktop app starts it, and UTF-8 on Windows."""

import os
import subprocess
import sys
import types

import pytest

from shrewd_studio import __main__ as start


def test_the_server_watches_the_app_that_started_it(monkeypatch):
    monkeypatch.setenv("SHREWD_STUDIO_DESKTOP", "4242")
    assert start.desktop_app() == 4242
    monkeypatch.setenv("SHREWD_STUDIO_DESKTOP", "1")      # older apps passed only a flag
    assert start.desktop_app() == os.getppid()
    assert start.running(os.getpid())
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    assert not start.running(gone.pid)


def test_on_windows_studio_runs_in_utf8_mode(monkeypatch):
    ran = []
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "flags", types.SimpleNamespace(utf8_mode=0))
    monkeypatch.setattr(subprocess, "run",
                        lambda args, check: ran.append(args) or types.SimpleNamespace(returncode=0))
    with pytest.raises(SystemExit):
        start.main(["--sandbox"])
    assert ran == [[sys.executable, "-X", "utf8", "-m", "shrewd_studio", "--sandbox"]]
