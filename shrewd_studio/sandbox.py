"""Simulated teachers, so Studio can be tried, demoed and tested without API keys or spending.

`install()` replaces the LLM call shrewd makes with a local function. A simulated teacher
answers from the true answer when it knows one (the sample models register theirs) and
otherwise from word overlap between the document and the options, and it is wrong at a
rate set by how capable its model name sounds, mostly on documents marked hard. Its
mistakes are deterministic per (model, document, question), lean toward a plausible
neighbor (the next rating level, a label that shares words), and come with a stated
confidence that is only loosely related to whether it was right, much like a real model's.

Nothing here is used unless Studio is started with --sandbox (the server and every worker
install it then), and the app says so on every screen.
"""

import hashlib
import json
import re
import types
from pathlib import Path

ACTIVE = False  # set by install(); simulated teachers need no API keys
TRUTH = {}  # text -> {question id (or "label"): answer}, filled by register()
_ASKED = {}  # (model, text) -> times asked at a sampling temperature, so repeat votes vary

# (accuracy, price per call in dollars) by what the model name suggests
TIERS = [
    (("opus", "fable", "gpt-5.1", "gpt-6", "sonnet"), 0.95, 0.0031),
    (("gpt-5-mini", "mini", "flash"), 0.86, 0.0004),
    (("haiku",), 0.85, 0.0006),
]
DEFAULT_TIER = (0.82, 0.0005)


def tier(model):
    name = model.lower()
    for words, accuracy, price in TIERS:
        if any(w in name for w in words):
            return accuracy, price
    return DEFAULT_TIER


def _roll(*parts):
    return int(hashlib.sha256("|".join(parts).encode()).hexdigest(), 16) % 10_000 / 10_000


def _words(text):
    return set(re.findall(r"[a-z]+", text.lower()))


def _guess(text, options):
    """The option whose name and description share the most words with the text."""
    words = _words(text)
    scores = [len(words & _words(f"{name} {desc}")) for name, desc in options]
    return max(range(len(options)), key=lambda i: (scores[i], -i))


def register(truth):
    """Teach the simulated teachers the right answers for some documents."""
    TRUTH.update(truth)


def load_truth(workspace):
    path = Path(workspace) / ".sandbox_truth.json"
    if path.exists():
        TRUTH.update(json.loads(path.read_text()))


def _pick(model, key, text, options, truth_index, ordinal, draw=""):
    accuracy, _ = tier(model)
    # documents the samples mark as hard (two topics in one, a harsh word in a harmless
    # comment) get most of the mistakes, as with a real model, so a local model's doubt and
    # the teacher's mistakes land on the same documents
    if TRUTH.get(text, {}).get("_hard"):
        accuracy -= 0.3
    elif text in TRUTH:
        accuracy = min(0.99, accuracy + 0.05)
    right = truth_index if truth_index is not None else _guess(text, options)
    if _roll(model, key, text, draw) < accuracy:
        said = right
    elif ordinal:
        step = 1 if _roll("dir", model, key, text) < 0.5 else -1
        said = min(len(options) - 1, max(0, right + step))
        said = said if said != right else min(len(options) - 1, max(0, right - step))
    else:
        others = [i for i in range(len(options)) if i != right]
        overlap = [len(_words(options[i][0] + " " + options[i][1]) & _words(text)) for i in others]
        said = others[max(range(len(others)),
                          key=lambda i: (overlap[i], _roll("o", model, key, text, str(i))))]
    # stated confidence: usually higher when right, with enough overlap that a threshold
    # can't separate right from wrong perfectly
    r = _roll("c", model, key, text)
    sure = 0.78 + 0.21 * r if said == right else 0.5 + 0.35 * r
    return said, sure


def _index(options, answer):
    if answer is None:
        return None
    lookup = {name.lower(): i for i, (name, _) in enumerate(options)}
    for i, (_, desc) in enumerate(options):
        lookup.setdefault(desc.lower(), i)
    return lookup.get(str(answer).strip().lower())


def completion(model, messages, **kwargs):
    system = messages[0]["content"]
    if not isinstance(system, str):
        system = system[0]["text"]
    text = messages[1]["content"]
    truth = TRUTH.get(text, {})
    # shrewd asks at temperature 0.7 when it wants several votes; each is a fresh draw
    draw = ""
    if kwargs.get("temperature"):
        n = _ASKED.get((model, text), 0)
        _ASKED[(model, text)] = n + 1
        # a model mostly repeats itself; about a third of re-asks are a fresh draw
        draw = str(n) if n and _roll("fresh", model, text, str(n)) < 0.35 else ""
    if "Questions:" in system:
        answers = {}
        for block in system.split('\n- id "')[1:]:
            key = block.split('"', 1)[0]
            if "type: noul" in block:
                options = [("no", "not"), ("yes", block.split("instructions:", 1)[-1])]
                said, sure = _pick(model, key, text, options, _index(options, truth.get(key)),
                                   ordinal=False)
                answers[key] = round(sure if said == 1 else 1 - sure, 3)
                continue
            options = re.findall(r"^    - ([^:]+): ?(.*)$", block, re.M)
            said, sure = _pick(model, key, text, options, _index(options, truth.get(key)),
                               ordinal="type: score" in block)
            rest = (1 - sure) / (len(options) - 1)
            answers[key] = {"probabilities": {name: round(sure if i == said else rest, 4)
                                              for i, (name, _) in enumerate(options)}}
        body = {"answers": answers}
    else:
        options = re.findall(r"^- ([^:]+): ?(.*)$", system, re.M)
        said, _ = _pick(model, "label", text, options, _index(options, truth.get("label")),
                        ordinal=False, draw=draw)
        body = {"label": options[said][0]}
    message = types.SimpleNamespace(content=json.dumps(body))
    response = types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])
    response._sandbox_price = tier(model)[1]
    return response


def _cost(completion_response=None, **kwargs):
    return getattr(completion_response, "_sandbox_price", 0.0)


def install(workspace=None):
    """Route every teacher call shrewd makes to the simulated teachers. Downloads are off
    too: the sandbox makes no network calls, so embeddings work only if already cached."""
    import os

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    import shrewd.teacher

    global ACTIVE
    ACTIVE = True
    shrewd.teacher.litellm.completion = completion
    shrewd.teacher.litellm.completion_cost = _cost
    if workspace is not None:
        load_truth(workspace)
