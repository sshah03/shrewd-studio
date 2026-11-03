"""`python -m shrewd_studio.worker`: run one Studio job in its own process.

The job arrives as JSON on stdin: {root, model, kind, params, sandbox, job}. Progress goes
back as JSON lines on stdout: {"progress", "message"} from shrewd's tqdm bars, {"log"} for
each printed line, then {"done": {...}} or {"error": ...}. Anything else written to the
stdout file descriptor (a native library, say) is sent to stderr instead, so it can't break
the channel. Pausing or cancelling a job ends this process; resuming starts a new one, and
labeling continues from the teachers' cache and encoder fine-tunes from <run>/checkpoints.
"""

import contextlib
import io
import json
import os
import shutil
import sys
import threading
import time
import traceback
import warnings
from pathlib import Path

from shrewd_studio import NO_WINDOW, NOISE, UTF8


def _channel():
    fd = os.dup(1)
    os.dup2(2, 1)
    out = os.fdopen(fd, "w", buffering=1)
    lock = threading.Lock()

    def send(message):
        with lock:
            out.write(json.dumps(message) + "\n")
            out.flush()

    return send


class _Lines(io.TextIOBase):
    """sys.stdout for the worker: every printed line becomes a {"log"} message."""

    def __init__(self, send):
        self.send, self.buffer_ = send, ""

    def write(self, text):
        self.buffer_ += text
        *lines, self.buffer_ = self.buffer_.split("\n")
        for line in lines:
            if line.strip():
                self.send({"log": line.rstrip()})
        return len(text)


def _report_bars(send):
    """Swap tqdm for one that reports its position. Done before shrewd is imported, since
    its modules take tqdm by name at import."""
    import tqdm
    import tqdm.auto

    class Reporter(tqdm.tqdm):
        def __init__(self, *args, **kwargs):
            kwargs["file"] = io.StringIO()
            super().__init__(*args, **kwargs)
            self._last = 0.0
            self._send(force=True)

        def update(self, n=1):
            out = super().update(n)
            self._send()
            return out

        def close(self):
            self._send(force=True)
            super().close()

        def _send(self, force=False):
            if self.disable:  # a disabled bar never set its position up
                return
            now = time.monotonic()
            if force or now - self._last >= 0.2:
                self._last = now
                send({"progress": round(self.n / self.total, 4) if self.total else None,
                      "message": self.desc or None})

    tqdm.tqdm = tqdm.auto.tqdm = Reporter


# ---------------------------------------------------------------- jobs


def _features(method, run, ctx):
    """A panel featurization. The encoder goes in as a factory named `encoder` so it keeps
    shrewd's built-in name (and reloads like one) while resuming from <run>/checkpoints."""
    if method != "encoder":
        return method

    def encoder():
        from shrewd.encoder import EncoderFeatures

        return EncoderFeatures(seed=run.manifest["seed"], device=ctx["device"],
                               checkpoint_dir=str(run.file("checkpoints")))

    return encoder


def _pool(run):
    import pandas as pd

    texts = run.pool_texts()
    if not texts:
        raise ValueError("add documents to the pool first")
    return pd.DataFrame({"text": texts})


def check(run, p, ctx):
    from shrewd_studio.views import prompt_digest, tuning_digest

    run.ensure_prompt()
    used, prompt = tuning_digest(run), prompt_digest(run)
    lib = run.project()
    if run.kind == "panel":
        lib.check_teachers()
    else:
        lib.check_teachers(votes=int(p.get("votes") or 1))
    _record(run, Path(ctx["root"]), "check", used)
    _record(run, Path(ctx["root"]), "check_prompt", prompt)
    return {"message": "Teachers checked"}


def label(run, p, ctx):
    from shrewd_studio.views import prompt_digest

    pool = _pool(run)
    lib = run.project()
    concurrency = int(p.get("concurrency") or 8)
    if run.kind == "panel":
        escalate = p.get("escalate")
        prompt = prompt_digest(run)
        lib.judge(pool, overwrite=True, concurrency=concurrency,
                  escalate=escalate["budget"] / 100 if escalate else None,
                  escalate_delta=float((escalate or {}).get("delta") or 0.05))
        _record(run, Path(ctx["root"]), "label_prompt", prompt)
        return {"message": f"Labeled {len(pool):,} documents"}
    run.ensure_prompt()
    prompt = prompt_digest(run)
    limit = p.get("limit") or {}
    kwargs = {}
    if limit.get("mode") == "n":
        kwargs["n"] = int(limit["value"])
    elif limit.get("mode") == "usd":
        kwargs["budget_usd"] = float(limit["value"])
    several = len(run.teachers()) > 1
    lib.label(pool, votes=int(p.get("votes") or 1), concurrency=concurrency,
              combine=p.get("combine") if several else None, **kwargs)
    _record(run, Path(ctx["root"]), "label_prompt", prompt)
    return {"message": f"Labeled {len(run.labeled()):,} documents"}


def reask(run, p, ctx):
    # answers are cached per question, so re-judging asks again only about questions whose
    # wording or options changed; everything else comes back from the cache
    label(run, p, ctx)
    return {"message": f"Asked again about {p.get('question')}"}


# SetFit's default trains on pairs of every two documents, about 190,000 for 600 of them: half
# an hour on an M-series Mac, and days on a pool of thousands. shrewd's SetFitStudent docstring
# caps the steps instead (2,000 batches of 16 pairs) and the encoder window, as here.
SETFIT = {"train_args": {"max_steps": 2000}, "max_seq_length": 256}


def compare(run, p, ctx):
    from shrewd_studio.views import training_digest

    method = p["method"]
    used = training_digest(run)
    before = run.compared()
    lib = run.project()
    if run.kind == "panel":
        rows = lib.compare(features=[_features(method, run, ctx)], soft=bool(p.get("soft", True)))
        key = "features"
    else:
        student = method
        if method == "encoder":
            from shrewd.students import EncoderStudent

            student = EncoderStudent(seed=run.manifest["seed"],
                                     checkpoint_dir=str(run.file("checkpoints")))
        elif method == "setfit":
            from shrewd.students import SetFitStudent

            student = SetFitStudent(seed=run.manifest["seed"], **SETFIT)
        rows = lib.compare(students=[student])
        key = "student"
    _merge_compare(run, before, rows, key, Path(ctx["root"]))
    _record(run, Path(ctx["root"]), "compare", used, method)
    return {"message": f"Compared {method}"}


def _merge_compare(run, before, rows, key, root):
    """compare() writes compare.json with only the methods it was given. Studio runs one
    job per method, so the rows are merged, under a lock, into studio_compare.json and
    compare.json is rewritten from it with every method that still has a candidate."""
    from shrewd_studio.workspace import read_json

    with _locked(run, root):
        merged = {name: row for name, row in before.items()}
        merged.update(read_json(run.file("studio_compare.json")) or {})
        merged.update({r[key]: r for r in rows})
        merged = {name: row for name, row in merged.items()
                  if run.file(f"candidates/{name}/meta.json").exists()}
        run.file("studio_compare.json").write_text(json.dumps(merged, indent=2))

        def score(row):
            if key == "student":
                return row.get("dev_macro_f1") or 0
            values = [q.get("dev_accuracy") or 0 for q in row.get("questions", {}).values()]
            return sum(values) / len(values) if values else 0

        ordered = sorted(merged.values(), key=score, reverse=True)
        run.file("compare.json").write_text(json.dumps({"candidates": ordered}, indent=2))


@contextlib.contextmanager
def _locked(run, root):
    """One worker at a time on this model's Studio files (compare jobs run side by side)."""
    locks = root / ".studio" / "locks"
    locks.mkdir(parents=True, exist_ok=True)
    with open(locks / f"{run.id}.lock", "a+") as lock:
        if sys.platform == "win32":
            import msvcrt

            lock.seek(0)
            while True:
                try:
                    msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)   # retries for ~10 s
                    break
                except OSError:
                    continue
            try:
                yield
            finally:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock, fcntl.LOCK_EX)
            yield


def _record(run, root, step, used, method=None):
    """Note what a step was made from (views.inputs), so later edits show it's out of date."""
    from shrewd_studio.views import INPUTS
    from shrewd_studio.workspace import read_json

    with _locked(run, root):
        blob = read_json(run.file(INPUTS)) or {}
        if method:
            blob.setdefault(step, {})[method] = used
        else:
            blob[step] = used
        run.file(INPUTS).write_text(json.dumps(blob, indent=2))


def ship(run, p, ctx):
    from shrewd_studio.views import training_digest

    used = training_digest(run)
    method = p["method"]
    routing = p.get("routing")
    route = {}
    if routing:
        route = {"route_budget": float(routing["budget"]) / 100,
                 "route_delta": float(routing.get("delta") or 0.05)}
    lib = run.project()
    if run.kind == "panel":
        lib.distill(features=_features(method, run, ctx), soft=bool(p.get("soft", True)),
                    calibration=p.get("calibration") or "auto",
                    calibrate_teacher=bool(p.get("calibrate_teacher")),
                    zero_shot=bool(p.get("zero_shot")), **route)
    else:
        extra = {"encoder": {"checkpoint_dir": str(run.file("checkpoints"))},
                 "setfit": SETFIT}.get(method, {})
        lib.distill(student=method, min_confidence=float(p.get("min_confidence") or 0),
                    **route, **extra)
    _record(run, Path(ctx["root"]), "ship", used)
    return {"message": f"Shipped {method}"}


def optimize(run, p, ctx):
    run.ensure_prompt()
    kwargs = {"budget": int(p.get("budget") or 800), "overwrite": True,
              "reflection_model": p.get("reflection_model") or None}
    if p.get("target") not in (None, ""):
        target = float(p["target"])
        kwargs["target"] = target / 100 if target > 1 else target
    if run.kind == "panel" and p.get("max_header_words"):
        kwargs["max_header_words"] = int(p["max_header_words"])
    run.project().optimize(**kwargs)
    return {"message": "Prompt optimized"}


def label_file(run, p, ctx):
    import pandas as pd
    import shrewd

    from shrewd_studio.rows import answer_of, label_proba, vector_of

    frame = pd.read_csv(p["input"], dtype=str, keep_default_na=False)
    texts = frame["text"].astype(str).tolist()
    print(f"answering {len(texts):,} documents")
    model = shrewd.load(run.path)
    questions = run.questions()
    out = frame.copy()
    proba = model.predict_proba(texts)
    for q in questions:
        values = proba.get(q["id"]) if run.kind == "panel" else label_proba(model, q, proba)
        if values is not None:
            pairs = [answer_of(q, v) for v in values]
            out[q["id"]] = [a for a, _ in pairs]
            out[f"{q['id']}_p"] = [v for _, v in pairs]
    if getattr(model, "routing", None):
        local = [bool(x) for x in model.local(texts)]
        out["answered"] = ["locally" if x else "teachers" for x in local]
        rest = [t for t, x in zip(texts, local, strict=True) if not x]
        if p.get("mode") == "teachers" and rest:
            print(f"the teachers answer the {len(rest):,} the model isn't sure of")
            asked = dict(zip(rest, run.project().ask(rest), strict=True))
            for i, text in enumerate(texts):
                if asked.get(text) is None:
                    continue
                for q in questions:
                    vector = vector_of(q, asked[text])
                    if vector is not None:
                        out.loc[out.index[i], [q["id"], f"{q['id']}_p"]] = answer_of(q, vector)
        else:
            out["answered"] = ["locally" if x else "below the routing limit" for x in local]
    path = run.file(f"labeled_files/{ctx['job']}.csv")
    path.parent.mkdir(exist_ok=True)
    out.to_csv(path, index=False)
    return {"message": f"Labeled {len(texts):,} documents", "output": str(path)}


def install(params, send):
    """pip install one of shrewd's extras into this Python. Not about a model, so it runs
    before one is opened."""
    import subprocess

    from shrewd_studio.views import EXTRAS, install_command, pip_trouble

    extra = params.get("extra")
    if extra not in {e for e, _, _ in EXTRAS}:
        raise ValueError(f"unknown extra {extra!r}")
    command = install_command(extra)
    print("$ " + " ".join(command))
    tail = []
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", bufsize=1,
                                env=dict(os.environ, **UTF8), **NO_WINDOW)
    except OSError as exc:
        raise RuntimeError(f"couldn't start the installer: {exc}") from None
    for line in proc.stdout:
        line = line.rstrip()
        if not line.strip():
            continue
        print(line)
        tail = [*tail[-39:], line]
        if line.lstrip().startswith(("Collecting", "Downloading", "Installing", "Building",
                                     "Resolved", "Prepared", "Installed", "Successfully")):
            send({"message": line.strip()[:120]})
    if proc.wait():
        raise RuntimeError(pip_trouble(tail))
    return {"message": "Installed"}


KINDS = {"check": check, "label": label, "reask": reask, "compare": compare, "ship": ship,
         "optimize": optimize, "label-file": label_file}


def main():
    warnings.filterwarnings("ignore", message=NOISE, category=UserWarning)
    spec = json.loads(sys.stdin.read())
    send = _channel()
    _report_bars(send)
    sys.stdout = _Lines(send)

    from shrewd_studio.settings import Settings
    from shrewd_studio.workspace import Run

    settings = Settings()
    root = Path(spec["root"])
    try:
        settings.apply()
        if spec["kind"] == "install":
            send({"done": {**install(spec.get("params") or {}, send), "cost": 0.0}})
            return
        if spec.get("sandbox"):
            from shrewd_studio import sandbox

            sandbox.install(root)
        if spec["kind"] in ("compare", "ship"):
            yield_to_the_desktop()
        run = Run(root / spec["model"])
        device = settings["compute"]["device"]
        ctx = {"root": str(root), "job": spec["job"], "device": None if device == "auto"
               else device}
        before = len(run.stages())
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            warnings.filterwarnings("ignore", message=NOISE, category=UserWarning)
            result = KINDS[spec["kind"]](run, spec.get("params") or {}, ctx)
        for w in caught:
            if issubclass(w.category, UserWarning):
                print(f"note: {w.message}")
        after = Run(run.path).stages()
        result["cost"] = round(sum(s.get("cost_usd", 0.0) for s in after[before:]), 4)
        send({"done": result})
    except Exception as exc:  # the user sees this in the app, so keep it whole
        traceback.print_exc()
        send({"error": plain(exc)})
        sys.exit(1)


def yield_to_the_desktop():
    """Training takes every core it's given and can make the whole computer stall. Run it at
    a lower priority, with two cores left over, so the app, the terminal and everything else
    stay responsive; it finishes a little later. Set before torch is imported, which reads
    these once."""
    if hasattr(os, "nice"):
        with contextlib.suppress(OSError):
            os.nice(10)
    elif sys.platform == "win32":
        import ctypes

        below_normal = 0x4000
        kernel = ctypes.windll.kernel32
        kernel.SetPriorityClass(kernel.GetCurrentProcess(), below_normal)
    spare = str(max(1, (os.cpu_count() or 4) - 2))
    for variable in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS",
                     "RAYON_NUM_THREADS"):
        os.environ.setdefault(variable, spare)


def plain(exc):
    """The error as the user sees it. A full disk surfaces from deep inside torch, safetensors
    or the Hugging Face hub in a dozen wordings; say it once, plainly."""
    text = str(exc) or type(exc).__name__
    # torch's own wording for a save cut short, which on a nearly full disk is the disk
    cut_short = "inline_container.cc" in text and shutil.disk_usage(Path.home()).free < 2**30
    # errno 28 is ENOSPC everywhere; Windows says it its own way when the errno is lost
    full = ("No space left on device" in text or "not enough space on the disk" in text
            or getattr(exc, "winerror", None) == 112)
    if getattr(exc, "errno", None) == 28 or full or cut_short:
        return ("The disk is full, so this couldn't be saved. Free some space (Settings shows "
                "what Studio keeps where), then run it again.")
    return text


if __name__ == "__main__":
    main()
