"""Response shapes for models, the task, the prompt, the report and price estimates, built
from a Run and the job list."""

import hashlib
from dataclasses import asdict

from shrewd_studio import rows, sandbox
from shrewd_studio.workspace import num, pct, read_json, short_name

METHOD_NAMES = {"tfidf": "tf-idf", "embed": "embeddings", "setfit": "SetFit",
                "encoder": "encoder"}
METHODS = {"classifier": ("tfidf", "embed", "setfit", "encoder"),
           "panel": ("tfidf", "embed", "encoder")}
GPU = {"setfit", "encoder"}
COUNT = ["No", "One", "Two", "Three", "Four", "Five", "Six"]
TIMES = {2: "twice", 3: "three times", 5: "five times"}


def installed(method):
    """Whether this install can train a method (or export to a format), checked without
    importing anything heavy."""
    import importlib.util

    from shrewd.students import REQUIRES

    needs = REQUIRES.get(method) or EXPORT_NEEDS.get(method, ())
    return all(importlib.util.find_spec(m) is not None for m in needs)


# shrewd's optional extras, as Settings lists them: (extra, name, roughly how much it downloads)
EXTRAS = [("embed", "Embeddings", "about 50 MB"),
          ("encoder", "Encoder and zero-shot", "about 1 GB, mostly PyTorch"),
          ("setfit", "SetFit", "about 1 GB, mostly PyTorch")]

# what shrewd.export (0.5 and later) can write for each kind of shipped method
EXPORT_FORMATS = {("classifier", "tfidf"): ("plain",), ("classifier", "embed"): ("plain", "onnx"),
                  ("classifier", "encoder"): ("onnx", "hf"), ("classifier", "setfit"): ("onnx",),
                  ("panel", "tfidf"): ("plain",), ("panel", "embed"): ("plain",)}
EXPORT_NEEDS = {"onnx": ("onnx", "onnxruntime"), "hf": ("transformers",)}


def can_export():
    import shrewd

    return hasattr(shrewd, "export")


if can_export():
    EXTRAS.append(("onnx", "ONNX export", "about 80 MB"))


def export_options(run):
    """The formats the shipped method can be exported to, and whether each is installed."""
    meta = read_json(run.file("student/meta.json")) or {}
    panel = meta.get("type") == "decisions"
    features = meta.get("features", "tfidf") if panel else meta.get("type")
    formats = () if panel and meta.get("stacks") else EXPORT_FORMATS.get(
        ("panel" if panel else "classifier", features), ())
    return {"supported": can_export(),
            "formats": [{"id": f, "ready": installed(f) if f in EXPORT_NEEDS else True}
                        for f in formats],
            "half": features == "embed"}


def install_command(extra):
    """How to install one of shrewd's extras into the Python running Studio: its own pip, or
    uv's when it has none (venvs made by uv don't), pinned to the shrewd already here so
    only the extra's packages are added."""
    import importlib.util
    import shutil
    import sys

    import shrewd

    spec = f"shrewd[{extra}]=={shrewd.__version__}"
    if importlib.util.find_spec("pip") is not None:
        return [sys.executable, "-m", "pip", "install", "--progress-bar", "off", spec]
    uv = shutil.which("uv")
    if uv:
        return [uv, "pip", "install", "--python", sys.executable, spec]
    return [sys.executable, "-m", "pip", "install", spec]


def pip_trouble(lines):
    """One plain sentence for why an install failed, from the end of its output."""
    text = "\n".join(lines).lower()
    for needle, why in (
        ("externally-managed-environment", "This Python is managed by the system or a package "
         "manager (Homebrew, apt), so pip won't install into it. Run Studio from a virtual "
         "environment, or install it with pipx."),
        ("no module named pip", "This Python has no pip, and uv isn't on the PATH to install "
         "with instead. Install uv (docs.astral.sh/uv), or reinstall Studio with every method "
         "included: shrewd-studio[all]."),
        ("permission denied", "Studio can't write to this Python's packages."),
        ("no matching distribution", "pip couldn't find a version of these packages for "
         "this Python."),
        ("could not find a version", "pip couldn't find a version of these packages for "
         "this Python."),
        ("failed to establish a new connection", "pip couldn't reach the package index. "
         "Check the network connection, or a proxy."),
        ("max retries exceeded", "pip couldn't reach the package index. Check the network "
         "connection, or a proxy."),
        ("no space left", "The disk is full."),
    ):
        if needle in text:
            return why
    return lines[-1] if lines else "the installer stopped without saying why"


# ---------------------------------------------------------------- teachers


_PER1K = {}


def rough_price(texts, prompt, model, votes, conn):
    """shrewd's estimate_calls, with the system prompt priced as a cached read after the first
    call on Anthropic models, which honor the cache marker shrewd adds (mark_prefix_cache) once
    the prompt is long enough. A long prompt, such as an optimized one, is otherwise quoted
    several times over. Other providers are priced in full, which measured right for them.
    shrewd 0.5.1 and later price it this way themselves."""
    import inspect

    from shrewd.teacher import estimate_calls, litellm

    if "cached_prompt" in inspect.signature(estimate_calls).parameters:     # shrewd 0.5.1+
        return estimate_calls(texts, prompt, model, votes, conn, cached_prompt=True)
    calls, usd = estimate_calls(texts, prompt, model, votes, conn)
    tokens = len(prompt) / 4
    if not calls or usd is None or calls < 2 or tokens < 1024:
        return calls, usd
    try:
        if litellm.get_llm_provider(model)[1] != "anthropic":
            return calls, usd
        info = litellm.get_model_info(model)
        full, read = info.get("input_cost_per_token"), info.get("cache_read_input_token_cost")
        prompt_usd, _ = litellm.cost_per_token(model=model, prompt_tokens=int(tokens * calls),
                                               completion_tokens=0)
    except Exception:
        return calls, usd
    if not (full and read and read < full):
        return calls, usd
    saved = prompt_usd * (1 - read / full) * (calls - 1) / calls
    return calls, max(0.0, usd - saved)


def per1k(run, model):
    """Roughly what 1,000 documents cost with this teacher, from shrewd's own estimate on
    your tuning examples (the sandbox's simulated price in the sandbox)."""
    if sandbox.ACTIVE:
        return round(sandbox.tier(model)[1] * 1000, 2)
    dev = run.seed("tuning")
    texts = dev["text"].tolist()[:200] if dev is not None and len(dev) else ["x" * 1500]
    prompt = run.prompt_text()
    key = (model, hashlib.sha1((prompt + "\0".join(texts)).encode()).hexdigest())
    if key not in _PER1K:

        n, usd = rough_price(texts, prompt, model, 1, None)
        _PER1K[key] = None if usd is None or not n else usd / n * 1000
    scale = calibration(run)
    return None if _PER1K[key] is None or scale is None else round(_PER1K[key] * scale, 2)


def calibration(run):
    """How far shrewd's rough price (characters / 4 in, a few tokens out) was from what this
    model's teachers really cost on its last paid teacher check: real over estimated, kept
    between 1 and 5. Tokenizers and reasoning tokens make real calls dearer, by about twice
    for reasoning models, so before a check has measured that there's no price to show: None.
    1 in the sandbox."""
    if sandbox.ACTIVE:
        return 1.0
    paid = [s for s in run.stages() if s["name"] == "check_teachers" and s.get("cost_usd")]
    dev = run.seed("tuning")
    if not paid or dev is None or not len(dev):
        return None
    guess = 0.0
    for model in run.teachers():
        _, usd = rough_price(dev["text"].tolist(), run.prompt_text(), model, 1, None)
        if usd is None:
            return None
        guess += usd
    return min(5.0, max(1.0, paid[-1]["cost_usd"] / guess)) if guess else None


# litellm's provider -> the variable Settings stores its key under
_KEY_VARIABLE = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY",
                 "gemini": "GEMINI_API_KEY", "mistral": "MISTRAL_API_KEY",
                 "openrouter": "OPENROUTER_API_KEY", "deepseek": "DEEPSEEK_API_KEY",
                 "groq": "GROQ_API_KEY", "together_ai": "TOGETHERAI_API_KEY"}


def key_variable(model):
    """The environment variable a teacher's key goes in, wherever it runs, or None (a local
    server, or a provider Settings doesn't list)."""
    try:
        import litellm

        litellm.suppress_debug_info = True
        return _KEY_VARIABLE.get(litellm.get_llm_provider(model)[1])
    except Exception:
        return None


def key_set(model):
    if sandbox.ACTIVE:
        return True
    try:
        import litellm

        return bool(litellm.validate_environment(model).get("keys_in_environment"))
    except Exception:
        return False


# servers on this computer: litellm lists their base URL as missing, but each has a default
_LOCAL = {"ollama", "ollama_chat", "lm_studio", "hosted_vllm", "llamafile"}


def teacher_key(model, offered=()):
    """What a teacher name needs before it can be called, from litellm, which knows the
    provider of a bare name too (gpt-… is OpenAI). `status` is "set", "missing" (with the
    variables in `needs`), "local" (a server on this computer, no key) or "unknown" (litellm
    can't tell the provider). Where litellm accepts either of several variables, the one
    Settings offers is named."""
    model = (model or "").strip()
    if not model:
        return {"provider": None, "status": "unknown", "needs": []}
    import litellm

    litellm.suppress_debug_info = True
    try:
        provider = litellm.get_llm_provider(model)[1]
    except Exception:
        return {"provider": None, "status": "unknown", "needs": []}
    if provider in _LOCAL:
        return {"provider": provider, "status": "local", "needs": []}
    try:
        found = litellm.validate_environment(model)
    except Exception:
        found = {"keys_in_environment": False, "missing_keys": []}
    if found.get("keys_in_environment"):
        return {"provider": provider, "status": "set", "needs": []}
    missing = list(found.get("missing_keys") or [])
    either = [v for v in missing if v in offered]
    return {"provider": provider, "status": "missing", "needs": either[:1] or missing}


# ---------------------------------------------------------------- stage


def stage(run, jobs):
    if jobs.of(run.id, kind="label"):
        return "labeling"
    if run.has("report.json"):
        return "shipped"
    if run.labeled() is not None:
        # documents left unlabeled (added later, or a run stopped early) show up in
        # changes(), not as a stage: the labels there are still usable
        return "review" if run.review_count() else "labeled"
    if run.has("teacher_check.json"):
        return "checked"
    return "examples"


def how(run, jobs, where):
    n = len(run.teachers())
    task = run.task()
    head = f"{COUNT[n] if n < len(COUNT) else n} teacher{'s' if n != 1 else ''}"
    if task["votes"] > 1:
        head += f" asked {TIMES.get(task['votes'], str(task['votes']) + ' times')}"
    parts = [head]
    if task["combine"] == "majority":
        parts.append("majority vote")
    elif task["combine"] == "weighted" and run.kind == "classifier":
        parts.append("weighted")
    if task["escalate"]:
        parts.append("cheapest first")
    if where == "examples":
        has = run.has("seed_test.csv")
        return "Examples imported, nothing else yet" if has else "No examples yet"
    if jobs.of(run.id, kind="compare"):
        parts.append("comparing methods")
    elif where == "shipped":
        parts.append("shipped with teacher backup" if rows.backup_on(run) else "shipped")
        if archived(run):
            parts.append("archived")
    else:
        parts.append({"checked": "checked, ready to label",
                      "labeling": "labeling under a budget" if task["limit"]["mode"] != "all"
                      else "labeling",
                      "review": "in review", "labeled": "labeled"}[where])
    return ", ".join(parts)


def method_name(method):
    """'tf-idf', or 'tf-idf, as compared' for the shipped method's candidate."""
    if method.startswith("compared-"):
        base = method.removeprefix("compared-")
        return f"{METHOD_NAMES.get(base, base)}, as compared"
    return METHOD_NAMES.get(method, method)


# what training uses: your tuning examples, the labels and your answers. The locked test set
# isn't here: no step but the final test reads it, so adding to it changes nothing upstream.
DATA = ("seed_dev.csv", "reviewed.csv")
INPUTS = "studio_inputs.json"


def _mtime(run, *names):
    times = [run.file(n).stat().st_mtime for n in names if run.has(n)]
    return max(times) if times else None


def data_time(run):
    """When what training uses last changed: the examples, the labels or your answers."""
    return _mtime(run, *DATA, run.pool_file().name)


def digest(run, *names):
    """A fingerprint of these files' contents. shrewd rewrites both seed files whenever either
    changes, so their times can't say which one did."""
    h = hashlib.sha1()
    for name in names:
        path = run.file(name)
        h.update(name.encode() + b"\0" + (path.read_bytes() if path.exists() else b"-") + b"\0")
    return h.hexdigest()


def tuning_digest(run):
    """What the teacher check used: the tuning examples."""
    return digest(run, "seed_dev.csv")


def training_digest(run):
    """What comparing and shipping train on: the tuning examples, the labels, your answers."""
    return digest(run, "seed_dev.csv", run.pool_file().name, "reviewed.csv")


def prompt_digest(run):
    """What the teachers are sent: the prompt, or a panel's header and questions."""
    try:
        text = run.prompt_text() or ""
    except OSError:
        text = ""
    return hashlib.sha1(text.encode()).hexdigest()


def _prompt_changed(run, made, step):
    """Whether the prompt changed since `step` ("check_prompt" or "label_prompt") ran. Labels
    made before Studio kept this fall back to the hash shrewd records for classifiers."""
    if step in made:
        return made[step] != prompt_digest(run)
    if step == "check_prompt":
        name = "prompt_header.txt" if run.kind == "panel" else "prompt.txt"
        prompt, check = _mtime(run, name), _mtime(run, "teacher_check.json")
        return bool(prompt and check and prompt > check)
    if step == "label_prompt" and run.kind == "classifier" and run.has("prompt.txt"):
        recorded = run.manifest.get("label_prompt_sha256")
        current = hashlib.sha256(run.file("prompt.txt").read_text().encode()).hexdigest()
        return bool(recorded) and current != recorded
    return False


def inputs(run):
    """studio_inputs.json, which the worker writes after each step: the fingerprint of what
    the check, each compared method and the shipped model were made from. Missing for steps
    run before Studio kept it, or from Python; changes() falls back to file times then."""
    return read_json(run.file(INPUTS)) or {}


def unlabeled(run):
    """Pool documents labeling would still take, within a limit on how many: the ones added
    after labeling, or left by a run that stopped early. 0 before the pool is labeled."""
    labeled = run.labeled()
    if labeled is None:
        return 0
    done = set(labeled["text"])
    new = [t for t in run.pool_texts() if t not in done]
    limit = run.task()["limit"]
    if limit["mode"] == "n":
        new = new[:max(0, int(limit["value"]) - len(done))]
    return len(new)


def _weighs(run):
    """Whether the teachers' answers are combined using the teacher check: several teachers,
    weighted by how often each matches your examples (panels always are)."""
    return len(run.teachers()) > 1 and (run.kind == "panel" or run.task()["combine"] == "weighted")


def changes(run):
    """Which finished steps are out of date because something they used changed later, from
    file times. `check`: your examples changed since the teacher check that weights the
    teachers. `labels`: the labels were combined before the latest check (recombining is
    free, the answers are cached). `shipped`: the shipped model was trained before the data
    changed. Methods compared before then are marked `stale` in methods()."""
    if archived(run):
        return {"unlabeled": 0, "check": False, "labels": False, "shipped": False,
                "prompt": False}
    check = _mtime(run, "teacher_check.json")
    labels = _mtime(run, run.pool_file().name)
    report = _mtime(run, "report.json")
    weighs = _weighs(run)
    made = inputs(run)
    if not (weighs and check):
        checked = False
    elif "check" in made:
        checked = made["check"] != tuning_digest(run)
    else:
        seeds = _mtime(run, "seed_dev.csv")
        checked = bool(seeds and seeds > check)
    if not report:
        shipped = False
    elif "ship" in made:
        shipped = made["ship"] != training_digest(run)
    else:
        data = data_time(run)
        shipped = bool(data and data > report)
    # a new prompt (optimized, or another candidate picked) means the teachers answer again
    prompt_labels = bool(labels and _prompt_changed(run, made, "label_prompt"))
    prompt_check = bool(weighs and check and _prompt_changed(run, made, "check_prompt"))
    return {
        "unlabeled": unlabeled(run),
        "check": checked or prompt_check,
        "labels": bool(labels and ((weighs and check and check > labels) or prompt_labels)),
        "shipped": shipped,
        "prompt": prompt_labels or prompt_check,
    }


def archived(run):
    """Pruned down to the shipped model (shrewd.prune): it can be used, not labeled or retrained.
    Shipping always splits off a test set, and prune always removes it."""
    return run.has("student/meta.json") and not run.has("seed_test.csv")


def model_row(run, jobs):
    where = stage(run, jobs)
    return {"id": run.id, "name": run.name, "kind": run.kind, "how": how(run, jobs, where),
            "stage": where, "review": run.review_count(),
            "paused": bool(jobs.of(run.id, states=("paused",))), "archived": archived(run)}


# ---------------------------------------------------------------- the model


def _accuracy(source, question, who):
    entry = ((source or {}).get("questions") or {}).get(question) or {}
    return pct((entry.get("dev_accuracy") or {}).get(who))


def _queued(run):
    """{question id: documents queued for review on it} for a panel, so review can open on the
    question most of them wait on. Empty for a classifier."""
    if run.kind == "classifier":
        return {}
    queue = run.review_rows()
    if queue.empty or "question" not in queue:
        return {}
    return {str(q): int(n) for q, n in queue.groupby("question")["text"].nunique().items()}


def _majority_accuracy(run):
    """How often a majority vote of the teachers (the first breaking ties, as shrewd does)
    matches your tuning labels. The teacher check reports the weighted combination, which
    isn't what labels the pool under a majority vote."""
    from collections import Counter

    dev = run.seed("tuning")
    if dev is None or not len(dev) or not run.has("cache.db"):
        return None
    question = run.questions()[0]
    teachers = rows.Teachers(run, votes=run.task()["votes"])
    right = n = 0
    try:
        for text, label in zip(dev["text"], dev["label"], strict=True):
            said = [cell["answers"][0] for model in run.teachers()
                    if (cell := teachers.cell(model, text))["state"] == "ok"
                    and cell["answers"][0] is not None]
            if not said:
                continue
            counts = Counter(said)
            top = max(counts.values())
            n += 1
            right += next(v for v in said if counts[v] == top) == rows._shown(run, question, label)
    finally:
        teachers.close()
    return [pct(right / n)] if n else None


def methods(run, jobs):
    compared = run.compared()
    shipped = run.shipped()
    report = run.report_json() if run.has("report.json") else None
    questions = run.questions()
    active = {}
    for job in jobs.of(run.id, kind="compare"):
        active[job.params.get("method")] = job
    order = list(compared) + [m for m in (shipped, *active) if m and m not in compared]
    data = None if archived(run) else data_time(run)
    made_from = inputs(run).get("compare") or {}
    now = training_digest(run) if made_from and data else None
    out = []
    for method in dict.fromkeys(order):
        row = compared.get(method)
        has_files = run.has(f"candidates/{method}/meta.json") or method == shipped
        job = active.get(method)
        if job is None and not has_files:
            continue
        dev = None
        if row and run.kind == "classifier":
            dev = [pct(row.get("dev_accuracy"))]
        elif row:
            dev = [pct((row.get("questions", {}).get(q["id"]) or {}).get("dev_accuracy"))
                   for q in questions]
        # when it was compared: the shipped one too, since shipping again is changes()'s
        made = _mtime(run, f"candidates/{method}/meta.json") or (
            _mtime(run, "student/meta.json") if method == shipped else None)
        if job is not None or not data:
            stale = False
        elif method in made_from:
            stale = made_from[method] != now
        else:
            stale = bool(made and data > made)
        test = zero_shot = None
        if method == shipped and report:
            if run.kind == "classifier":
                test = [pct(report["metrics"]["student"].get("accuracy"))]
            else:
                test = [pct(((report["questions"].get(q["id"]) or {}).get("student") or {})
                            .get("accuracy")) for q in questions]
                kept = [k for k, r in (report.get("stacking") or {}).items() if r.get("kept")]
                zero_shot = kept or None
        out.append({
            "id": method, "name": METHOD_NAMES.get(method, method),
            "state": ("running" if job.state == "running" else job.state) if job else "done",
            "job": job.id if job else None, "progress": job.progress if job else None,
            "note": job.message if job else None, "dev": dev,
            "ms": (row or {}).get("ms_per_item"), "mb": (row or {}).get("size_mb"),
            "base": base_model(run, method, shipped),
            "test": test, "shipped": method == shipped, "zero_shot": zero_shot,
            "stale": stale, "original": False,
        })
    # the shipped method as compared, before shipping retrained it on more data: kept in
    # candidates/ so it can be tried next to the shipped one, but not shipped or removed
    if shipped and run.has(f"candidates/{shipped}/meta.json"):
        at = next((i for i, x in enumerate(out) if x["id"] == shipped), None)
        if at is not None:
            entry = out[at]
            out.insert(at + 1, {
                **entry, "id": f"compared-{shipped}", "name": f"{entry['name']}, as compared",
                "state": "done", "job": None, "progress": None, "note": None,
                "base": base_model(run, shipped, None), "test": None, "shipped": False,
                "zero_shot": None, "original": True})
    return out


def base_model(run, method, shipped):
    """The Hugging Face model a method loads by name rather than keeping in its folder (the
    embeddings method keeps only its classifier head and loads potion-base-8M), as
    {name, mb}: its size in the download cache, None until it has been downloaded. None for
    methods that keep everything in their folder."""
    folder = run.file("student" if method == shipped else f"candidates/{method}")
    name = (read_json(folder / "meta.json") or {}).get("embedder")
    if not name:
        return None
    return {"name": name, "mb": _cached_mb(name)}


def _cached_mb(repo):
    """A model's size in the Hugging Face cache (its newest snapshot), or None."""
    import os
    from pathlib import Path

    try:
        from huggingface_hub.constants import HF_HUB_CACHE as hub
    except ImportError:
        home = os.environ.get("HF_HOME") or Path(os.environ.get("XDG_CACHE_HOME")
                                                 or Path.home() / ".cache") / "huggingface"
        hub = Path(home) / "hub"
    snapshots = Path(hub) / f"models--{repo.replace('/', '--')}" / "snapshots"
    if not snapshots.is_dir():
        return None
    newest = max(snapshots.iterdir(), key=lambda p: p.stat().st_mtime, default=None)
    if newest is None:
        return None
    total = sum(f.stat().st_size for f in newest.rglob("*") if f.is_file())  # follows links
    return round(total / 1e6, 1)


def model_view(run, jobs):
    questions = run.questions()
    task = run.task()
    several = len(run.teachers()) > 1
    source = run.teacher_check() or run.agreement()
    teachers = []
    for model in run.teachers():
        accuracy = [_accuracy(source, q["id"], model) for q in questions]
        teachers.append({"name": model, "short": short_name(model), "per1k": per1k(run, model),
                         "key_set": key_set(model), "key": key_variable(model),
                         "accuracy": accuracy if any(a is not None for a in accuracy) else None})
    # the Combined column shows the labels on disk, so score how those were combined
    labeled_with = run.labeled_combine()
    combined = None
    if several and (labeled_with or task["combine"]) == "majority":
        combined = _majority_accuracy(run)
    elif several and source:
        combined = [_accuracy(source, q["id"], "combined") for q in questions]
        combined = combined if any(a is not None for a in combined) else None
    escalate = None
    if task["escalate"]:
        agreement = run.agreement() or {}
        done = agreement.get("escalation")
        if done and done.get("documents"):
            share = done["escalated"] / done["documents"]
        else:
            share = (agreement.get("cascade") or {}).get("escalate_share")
        escalate = {**task["escalate"], "share": pct(share)}
    splits = run.manifest.get("splits") or {}
    labeled = run.labeled()
    log = run.label_log()
    budget = None
    if log or task["limit"]["mode"] != "all":
        budget = {"n": task["limit"]["value"] if task["limit"]["mode"] == "n" else None,
                  "usd": task["limit"]["value"] if task["limit"]["mode"] == "usd" else None,
                  "labeled": 0 if labeled is None else len(labeled),
                  "rounds": [[r["round"], r["n_labeled"], pct(r.get("dev_accuracy")),
                              r["cost_usd"]] for r in log or []]}
    return {
        **model_row(run, jobs),
        "path": str(run.path),
        "instructions": run.manifest.get("instructions"),
        "questions": [{k: q[k] for k in ("id", "type", "options", "text")} for q in questions],
        "descriptions": dict(run.manifest["labels"]) if run.kind == "classifier" else None,
        "teachers": teachers, "combine": task["combine"], "combined_accuracy": combined,
        "priced": calibration(run) is not None,
        "relabel": labeled_with is not None and labeled_with != task["combine"],
        "changes": changes(run),
        "queued": _queued(run),
        "votes": task["votes"], "escalate": escalate,
        "counts": {"tuning": splits.get("n_dev", 0), "test": splits.get("n_test", 0),
                   "pool": len(run.pool_texts()),
                   "labeled": 0 if labeled is None else len(labeled),
                   "review": run.review_count()},
        "final_tests": run.final_tests(), "spent": run.spent(),
        "methods": methods(run, jobs),
        "routing": rows.routing(run),
        "budget": budget,
        "prompt_optimized": any(s["name"] == "optimize" for s in run.stages()),
    }


# ---------------------------------------------------------------- task and prompt


def task_view(run, concurrency=8):
    task = run.task(concurrency)
    out = {"instructions": run.manifest.get("instructions")}
    if run.kind == "classifier":
        out["labels"] = [{"name": k, "description": v} for k, v in run.manifest["labels"].items()]
    else:
        out["questions"] = [{k: q[k] for k in ("id", "type", "text", "options")}
                            for q in run.questions()]
    out["teachers"] = [{"name": m, "per1k": per1k(run, m)} for m in run.teachers()]
    return {**out, **task}


def prompt_view(run):
    from shrewd import decide

    panel = run.kind == "panel"
    if panel:
        text = run.header() or decide.default_header(run.manifest.get("instructions"))
    else:
        text = run.prompt_text()
    log = read_json(run.file("optimize_log.json"))
    last = None
    if log and log.get("candidates"):
        candidates = [{"score": num(c.get("val_score")),
                       "prompt": c.get("header") if panel else c.get("prompt")}
                      for c in log["candidates"]]
        scores = [c["score"] if c["score"] is not None else -1 for c in candidates]
        last = {"candidates": candidates, "best": scores.index(max(scores)),
                "in_use": next((i for i, c in enumerate(candidates)
                                if (c["prompt"] or "").strip() == text.strip()), None)}
    splits = run.manifest.get("splits") or {}
    return {"text": text, "optimized": any(s["name"] == "optimize" for s in run.stages()),
            "metric": "1 − Brier/2" if panel else "accuracy",
            "scored_on": splits.get("n_dev", 0), "against": short_name(run.teachers()[0]),
            "last_run": last}


def use_prompt(run, index):
    log = read_json(run.file("optimize_log.json")) or {}
    candidates = log.get("candidates") or []
    if not 0 <= index < len(candidates):
        raise ValueError("no such candidate")
    if run.kind == "panel":
        run.file("prompt_header.txt").write_text(candidates[index]["header"])
    else:
        run.file("prompt.txt").write_text(candidates[index]["prompt"])


# ---------------------------------------------------------------- report and estimates


def report_view(run):
    report = run.report_json()
    if report is None:
        return None
    if run.kind == "panel":
        from shrewd.decisions import decision_findings

        findings = [asdict(f) for f in decision_findings(report)]
    else:
        findings = report.get("findings", [])
    return {**report, "findings": findings, "method": run.shipped(),
            "final_tests": run.final_tests()}


def estimate(run, kind):
    """What a check or a labeling run would cost per teacher, from shrewd's estimate_calls
    (the estimate its dry_run prints) scaled by `calibration`, counting only answers not
    already cached."""
    from shrewd.teacher import open_cache

    task = run.task()
    dev = run.seed("tuning")
    dev_texts = [] if dev is None else dev["text"].tolist()
    if kind == "check":
        texts = dev_texts
        counted = len(dict.fromkeys(texts))
    elif kind == "label":
        texts = run.pool_texts()
        labeled = run.labeled()
        if task["limit"]["mode"] == "n":
            done = set() if labeled is None else set(labeled["text"])
            room = max(0, int(task["limit"]["value"]) - len(done))
            texts = [t for t in texts if t not in done][:room]
        # not the tuning examples that weight teachers; once some are labeled, only the
        # documents still to label (labeling the rest again comes from the cache)
        known = set() if labeled is None else set(labeled["text"])
        fresh = [t for t in texts if t not in known]
        counted = len(dict.fromkeys(fresh or texts))
        if len(run.teachers()) > 1 and (run.kind == "panel" or task["combine"] == "weighted"):
            texts = texts + dev_texts
    elif kind == "test":
        # what shipping asks: the locked test set, which the final test has every teacher answer
        test = run.seed("test")
        texts = [] if test is None else test["text"].tolist()
        counted = len(dict.fromkeys(texts))
    else:
        raise ValueError("kind is check, label or test")
    votes = task["votes"] if run.kind == "classifier" else 1
    share = None
    if kind == "label" and task["escalate"]:
        agreement = run.agreement() or {}
        share = (agreement.get("cascade") or {}).get("escalate_share")
    conn = open_cache(run.file("cache.db")) if run.has("cache.db") else None
    scale = calibration(run)
    out, total = [], 0.0
    try:
        documents = counted
        for i, model in enumerate(run.teachers()):
            calls, usd = rough_price(texts, run.prompt_text(), model, votes, conn) \
                if texts else (0, 0.0)
            if sandbox.ACTIVE:
                usd = calls * sandbox.tier(model)[1]
            elif not calls:
                usd = 0.0                      # all cached: that one is exact
            elif usd is not None:
                usd = None if scale is None else usd * scale
            asked = documents
            if share is not None and i > 0:
                asked = int(round(documents * share))
                usd = None if usd is None else usd * share
            out.append({"teacher": model, "documents": asked, "calls": calls,
                        "usd": None if usd is None else round(usd, 4)})
            total = None if total is None or usd is None else total + usd
    finally:
        if conn is not None:
            conn.close()
    if total is not None and task["limit"]["mode"] == "usd" and kind == "label":
        total = min(total, float(task["limit"]["value"]))
    return {"rows": out, "total": None if total is None else round(total, 4)}
