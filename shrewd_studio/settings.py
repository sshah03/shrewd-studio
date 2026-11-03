"""Studio's settings: a JSON file in ~/.shrewd-studio (or $SHREWD_STUDIO_HOME), and API keys
in the system keychain through `keyring`.

Keys are put into the server's environment at start, and workers inherit it, so shrewd and
litellm read them the usual way. A key your shell already sets wins and is never replaced.
The settings file holds the names of the stored keys, never their values.
"""

import contextlib
import copy
import json
import os
import re
from pathlib import Path

SERVICE = "shrewd-studio"
PROVIDERS = [
    ("Anthropic", "ANTHROPIC_API_KEY"), ("OpenAI", "OPENAI_API_KEY"),
    ("Google Gemini", "GEMINI_API_KEY"), ("Mistral", "MISTRAL_API_KEY"),
    ("OpenRouter", "OPENROUTER_API_KEY"), ("DeepSeek", "DEEPSEEK_API_KEY"),
    ("Groq", "GROQ_API_KEY"), ("Together AI", "TOGETHERAI_API_KEY"),
]
ENDPOINT_VARS = {"ollama": "OLLAMA_API_BASE", "openai_compatible": "HOSTED_VLLM_API_BASE"}
DEFAULTS = {
    "keychain": [],
    "endpoints": {"ollama": None, "openai_compatible": None},
    "prices": [],
    "defaults": {"teachers": ["anthropic/claude-haiku-5-5"], "concurrency": 8, "test_frac": 35,
                 "seed": 42},
    "compute": {"device": "auto", "cpu_jobs": 2, "gpu_jobs": 1},
    # where models are kept and where Hugging Face downloads go; None is the default
    "storage": {"workspace": None, "models_dir": None},
}
DEVICES = ("auto", "cuda", "mps", "cpu")
# where models are kept unless Settings, --workspace or $SHREWD_STUDIO_WORKSPACE say otherwise:
# the same on every system and however Studio is started, so the app and the command line
# always show the same models
DEFAULT_WORKSPACE = Path.home() / "shrewd-models"


def home():
    return Path(os.environ.get("SHREWD_STUDIO_HOME") or Path.home() / ".shrewd-studio")


class Settings:
    def __init__(self, path=None):
        self.path = Path(path) if path else home() / "settings.json"
        self.data = copy.deepcopy(DEFAULTS)
        if self.path.exists():
            stored = json.loads(self.path.read_text())
            for key, value in stored.items():
                if isinstance(value, dict) and isinstance(self.data.get(key), dict):
                    self.data[key].update(value)
                else:
                    self.data[key] = value
        # what the shell set before Studio added anything, so a shell key always wins
        self.shell = {k for k, v in os.environ.items() if v}
        self._set_by_us = set()

    def __getitem__(self, key):
        return self.data[key]

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2))

    # -- keys ------------------------------------------------------------------------

    def load_keys(self):
        """Put every stored key the shell doesn't set into this process's environment."""
        import keyring

        for variable in self.data["keychain"]:
            if variable in self.shell:
                continue
            try:
                value = keyring.get_password(SERVICE, variable)
            except Exception:
                value = None
            if value:
                os.environ[variable] = value

    def set_key(self, variable, value):
        import keyring

        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", variable or ""):
            raise ValueError("a key variable is upper case, like ANTHROPIC_API_KEY")
        if not value:
            raise ValueError("the key is empty")
        keyring.set_password(SERVICE, variable, value)
        if variable not in self.data["keychain"]:
            self.data["keychain"].append(variable)
            self.save()
        if variable not in self.shell:
            os.environ[variable] = value

    def delete_key(self, variable):
        import keyring

        if variable not in self.data["keychain"]:
            raise KeyError(variable)
        with contextlib.suppress(keyring.errors.PasswordDeleteError):
            keyring.delete_password(SERVICE, variable)
        self.data["keychain"].remove(variable)
        self.save()
        if variable not in self.shell:
            os.environ.pop(variable, None)

    def keys(self):
        provider = {v: p for p, v in PROVIDERS}
        variables = list(provider) + [v for v in self.data["keychain"] if v not in provider]
        out = []
        for variable in variables:
            source = ("shell" if variable in self.shell else
                      "keychain" if variable in self.data["keychain"] else None)
            out.append({"provider": provider.get(variable, variable.removesuffix("_API_KEY")
                                                 .replace("_", " ").title()),
                        "variable": variable, "source": source})
        return out

    # -- everything else ---------------------------------------------------------------

    def update(self, patch):
        """Merge a partial change from the app, checked before anything is stored."""
        data = copy.deepcopy(self.data)
        for name, value in (patch.get("endpoints") or {}).items():
            if name not in ENDPOINT_VARS:
                raise ValueError(f"unknown endpoint {name!r}")
            value = (value or "").strip() or None
            if value and not re.match(r"https?://", value):
                raise ValueError(f"{name}: a base URL starts with http:// or https://")
            data["endpoints"][name] = value
        if "prices" in patch:
            prices = []
            for row in patch["prices"] or []:
                model = (row.get("model") or "").strip()
                if not model:
                    raise ValueError("a price needs a model name")
                prices.append({"model": model, "input": float(row.get("input") or 0),
                               "output": float(row.get("output") or 0)})
            data["prices"] = prices
        defaults = patch.get("defaults") or {}
        if "teachers" in defaults:
            teachers = defaults["teachers"]
            teachers = teachers.split(",") if isinstance(teachers, str) else teachers
            data["defaults"]["teachers"] = [t.strip() for t in teachers if t.strip()]
        for key, low, high in (("concurrency", 1, 256), ("test_frac", 5, 80),
                               ("seed", 0, 2**31 - 1)):
            if key in defaults:
                data["defaults"][key] = _bounded(defaults[key], low, high, key)
        compute = patch.get("compute") or {}
        if "device" in compute:
            if compute["device"] not in DEVICES:
                raise ValueError(f"device is one of {', '.join(DEVICES)}")
            data["compute"]["device"] = compute["device"]
        for key in ("cpu_jobs", "gpu_jobs"):
            if key in compute:
                data["compute"][key] = _bounded(compute[key], 1, 32, key)
        self.data = data
        self.save()
        self.apply()

    def set_storage(self, which, path):
        """Save a folder (None for the default). It's used from the next start, since running
        processes keep the folders they opened."""
        if which not in ("workspace", "models_dir"):
            raise ValueError(f"unknown folder {which!r}")
        self.data["storage"][which] = str(path) if path else None
        self.save()

    def apply(self):
        """Endpoints into the environment, prices into litellm. Run in the server and in
        every worker, since litellm's price table lives in the process."""
        for name, variable in ENDPOINT_VARS.items():
            value = self.data["endpoints"].get(name)
            if variable in self.shell:
                continue
            if value:
                os.environ[variable] = value
                self._set_by_us.add(variable)
            elif variable in self._set_by_us:
                os.environ.pop(variable, None)
        models_dir = self.data["storage"].get("models_dir")
        if "HF_HOME" not in self.shell:
            if models_dir:
                os.environ["HF_HOME"] = models_dir
                self._set_by_us.add("HF_HOME")
            elif "HF_HOME" in self._set_by_us:
                os.environ.pop("HF_HOME", None)
        if self.data["prices"]:
            import litellm

            litellm.register_model({
                p["model"]: {"input_cost_per_token": p["input"] / 1e6,
                             "output_cost_per_token": p["output"] / 1e6,
                             "litellm_provider": p["model"].split("/", 1)[0]
                             if "/" in p["model"] else "openai",
                             "mode": "chat"}
                for p in self.data["prices"]})


def _bounded(value, low, high, name):
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} is a whole number") from None
    if not low <= value <= high:
        raise ValueError(f"{name} is between {low} and {high}")
    return value
