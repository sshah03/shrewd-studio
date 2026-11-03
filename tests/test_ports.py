"""shrewd-studio serves on 8765, or the next free port when something else is listening there."""

import socket

import pytest

from shrewd_studio import __main__ as cli


def listening():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen()
    return s


def test_default_port_moves_on_when_taken(monkeypatch):
    with listening() as taken:
        busy = taken.getsockname()[1]
        monkeypatch.setattr(cli, "DEFAULT_PORT", busy)
        port = cli.pick_port(None)
        assert port != busy
        assert cli.port_open(port)


def test_default_port_used_when_free(monkeypatch):
    free = cli.free_port()
    monkeypatch.setattr(cli, "DEFAULT_PORT", free)
    assert cli.pick_port(None) == free


def test_a_port_asked_for_must_be_free():
    with listening() as taken, pytest.raises(SystemExit, match="already in use"):
        cli.pick_port(taken.getsockname()[1])


def test_zero_is_any_free_port():
    assert cli.pick_port(0) > 0
