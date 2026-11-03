"""Tests never touch the real settings file or keychain, and make no network calls."""

import os
import tempfile

os.environ["SHREWD_STUDIO_HOME"] = tempfile.mkdtemp(prefix="shrewd-studio-home-")
os.environ["HF_HUB_OFFLINE"] = "1"

import keyring  # noqa: E402
import keyring.errors  # noqa: E402
from keyring.backend import KeyringBackend  # noqa: E402


class MemoryKeyring(KeyringBackend):
    priority = 1

    def __init__(self):
        super().__init__()
        self.store = {}

    def get_password(self, service, username):
        return self.store.get((service, username))

    def set_password(self, service, username, password):
        self.store[(service, username)] = password

    def delete_password(self, service, username):
        if (service, username) not in self.store:
            raise keyring.errors.PasswordDeleteError(username)
        del self.store[(service, username)]


keyring.set_keyring(MemoryKeyring())
