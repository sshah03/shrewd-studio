"""The document table: every pool, tuning and test document with your answers, each
teacher's, the combined answer and each local method's.

Teacher answers come from the run's files and its cache (cache.db) only; nothing here asks
a teacher. Local answers come from loading each compared candidate and the shipped model,
cached until their folders change.
"""

import collections
import functools
import hashlib
import importlib
import json
import math
import threading
import time
import warnings
from pathlib import Path

import numpy as np

from shrewd_studio.workspace import num, read_json

INVALID = "__invalid__"
_TABLES = {}       # run path -> (stamp, rows, every method loaded, when built)
_MODELS = {}       # model folder -> (stamp, model)
_PREDICTED = {}    # model folder -> (stamp, texts digest, {text: cell})
# requests are served on several threads. transformers can't load two models at once (one
# load's weights end up on its "meta" device mid-copy), and building a table twice in
# parallel only does that work twice
_LOADING = threading.Lock()
_BUILDING = collections.defaultdict(threading.Lock)
WATCHED = ("manifest.json", "studio.json", "pool_input.csv", "pool_labeled.csv",
           "pool_judged.csv", "reviewed.csv", "needs_review.csv", "seed_dev.csv",
           "seed_test.csv", "cache.db", "report.json", "compare.json", "agreement.json",
           "prompt.txt", "prompt_header.txt", "student/meta.json", "student/routing.json")


def row_key(split, text):
    return f"{split}:{hashlib.sha1(text.encode()).hexdigest()[:12]}"


# ---------------------------------------------------------------- answers


def answer_of(question, vector):
    """(the option a person reads, its number): a choice's probability, P(yes) for a yes/no
    question, the probability-weighted mean level for a score."""
    if vector is None:
        return None, None
    v = np.asarray(vector, dtype=float)
    if v.size != len(question["options"]) or np.isnan(v).any() or v.sum() <= 0:
        return None, None
    v = v / v.sum()
    top = int(v.argmax())
    if question["type"] == "yes/no":
        p = v[1]
    elif question["type"] == "score":
        p = float((v * np.arange(len(v))).sum())
    else:
        p = v[top]
    return question["options"][top], num(p)


def vector_of(question, answer):
    """A teacher's answer from shrewd's .ask() (a label, or an Answer) as a probability
    vector over the question's options."""
    if answer is None:
        return None
    if isinstance(answer, str):
        if answer not in question["keys"]:
            return None
        return [1.0 if k == answer else 0.0 for k in question["keys"]]
    if isinstance(answer, dict):
        answer = answer.get(question["id"])
        if answer is None:
            return None
    if answer.kind == "noul":
        return [1 - answer.payload["noul"], answer.payload["noul"]]
    return [answer.probabilities.get(k, 0.0) for k in question["keys"]]


def label_proba(model, question, proba):
    """A classifier's probabilities, from its classes_ order to the label order."""
    classes = list(model.classes_)
    out = np.zeros((len(proba), len(question["keys"])))
    for j, label in enumerate(question["keys"]):
        if label in classes:
            out[:, j] = proba[:, classes.index(label)]
    return out


@functools.lru_cache(maxsize=4096)
def _parsed(response, labels):
    """shrewd's parse_label, remembered: most responses are the same few short strings."""
    from shrewd.teacher import parse_label

    return parse_label(response, list(labels))


def _vector(stored, n_options):
    """What shrewd's _answer_get returns for a stored answer."""
    if stored is None:
        return None
    try:
        values = np.array(json.loads(stored), dtype=float)
    except (ValueError, TypeError):
        return None
    if values.shape != (n_options,) or not np.isfinite(values).all():
        return None
    total = values.sum()
    return values / total if total > 0 else None


class Teachers:
    """Each teacher's answers, read from the cache under the keys shrewd stored them with."""

    def __init__(self, run, votes=1, preload=False):
        """`preload` reads the whole cache in one query, for building the table: one lookup
        per row and teacher is far slower once there are tens of thousands of rows."""
        from shrewd.teacher import open_cache

        self.run, self.votes = run, votes
        self.questions = run.questions()
        self.models = run.teachers()
        self.conn = open_cache(run.file("cache.db")) if run.has("cache.db") else None
        self.prompt = run.prompt_text() if run.kind == "classifier" else None
        self.header = run.header()
        self.loaded = None
        if preload and self.conn is not None:
            table, column = (("calls", "response") if run.kind == "classifier"
                             else ("answers", "probs"))
            exists = self.conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            self.loaded = (dict(self.conn.execute(f"SELECT key, {column} FROM {table}"))
                           if exists else {})

    def close(self):
        if self.conn is not None:
            self.conn.close()

    def cell(self, model, text, votes=None):
        """{state, answers, p, votes, alt} for one teacher on one document."""
        n = len(self.questions)
        empty = {"state": "none", "answers": [None] * n, "p": [None] * n, "votes": None,
                 "alt": None}
        if self.conn is None:
            return empty
        if self.run.kind == "classifier":
            return self._label_cell(model, text, votes or self.votes) or empty
        from shrewd.judge import _answer_get, _answer_key

        answers, ps, any_ = [], [], False
        for q in self.questions:
            if self.loaded is None:
                vector = _answer_get(self.conn, model, q["id"], q["spec"], text, q["keys"],
                                     self.header)
            else:
                stored = self.loaded.get(_answer_key(model, q["id"], q["spec"], text,
                                                     self.header))
                vector = _vector(stored, len(q["keys"]))
            shown, p = answer_of(q, vector)
            any_ |= shown is not None
            answers.append(shown)
            ps.append(p)
        return {**empty, "state": "ok", "answers": answers, "p": ps} if any_ else empty

    def _label_cell(self, model, text, votes):
        from shrewd.teacher import _cache_get, _key, _temperature

        labels = self.questions[0]["keys"]
        temperature = _temperature(votes)
        said = []
        for v in range(votes):
            key = _key(model, self.prompt, text, temperature, v, 0)
            hit = self.loaded.get(key) if self.loaded is not None else _cache_get(self.conn, key)
            if hit is not None:
                said.append(_parsed(hit, tuple(labels)))
        if not said:
            return None
        valid = [s for s in said if s is not None]
        counts = {s: valid.count(s) for s in dict.fromkeys(valid)}
        ranked = sorted(counts, key=lambda s: -counts[s])
        top = ranked[0] if ranked else None
        cell = {"state": "ok", "answers": [top], "p": [None], "votes": None, "alt": None}
        if votes > 1:
            cell["votes"] = [f"{counts.get(top, 0)}/{votes}"]
            cell["alt"] = [ranked[1] if len(ranked) > 1 else None]
        return cell


# ---------------------------------------------------------------- local methods


def method_folders(run):
    """{method id: (folder, shipped)} for every compared candidate and the shipped model. The
    shipped method's candidate, as it was compared before shipping retrained it, is
    `compared-<method>` (views.methods)."""
    out = {}
    shipped = run.shipped()
    for meta in sorted(run.path.glob("candidates/*/meta.json")):
        name = meta.parent.name
        out[f"compared-{name}" if name == shipped else name] = (meta.parent, False)
    if shipped:
        out[shipped] = (run.file("student"), True)
    return out


def _stamp(folder):
    return max((f.stat().st_mtime for f in folder.iterdir()), default=0)


def _load(run, folder, shipped):
    stamp = _stamp(folder)
    with _LOADING:
        return _load_one(run, folder, shipped, stamp)


def _heavy(folder):
    """Whether a method runs on PyTorch (encoder, SetFit, an encoder panel): hundreds of MB,
    often on the GPU. Light ones (tf-idf, embeddings) stay loaded."""
    meta = read_json(Path(folder) / "meta.json") or {}
    return meta.get("type") in ("encoder", "setfit") or meta.get("features") == "encoder"


def release_heavy(keep=None):
    """Drop PyTorch methods from memory, except `keep`. Their answers to the table's documents
    are cached, so they're only loaded again for new text (a typed row, the Playground)."""
    dropped = [f for f in _MODELS if f != keep and _heavy(f)]
    for folder in dropped:
        del _MODELS[folder]
    if dropped:
        from shrewd.encoder import release_memory

        release_memory()


# how long a PyTorch method stays loaded after its last use, as Ollama keeps models: long
# enough for the Playground or typed rows to stay quick, short enough to free the memory
KEEP_ALIVE = 300
_RELEASE = None


def _keep_alive():
    global _RELEASE
    if _RELEASE is not None:
        _RELEASE.cancel()
    _RELEASE = threading.Timer(KEEP_ALIVE, _release_idle)
    _RELEASE.daemon = True
    _RELEASE.start()


def _release_idle():
    with _LOADING:
        release_heavy()


def _load_one(run, folder, shipped, stamp):
    cached = _MODELS.get(folder)
    heavy = _heavy(folder)
    if heavy:
        _keep_alive()
    if cached is None or cached[0] != stamp:
        if heavy:
            release_heavy(keep=folder)
        # an extra installed from Settings since the server started (torch, setfit) isn't
        # seen by imports until Python's cached listing of site-packages is refreshed
        importlib.invalidate_caches()
        if shipped:
            import shrewd

            model = shrewd.load(run.path)
        else:
            from shrewd.students import load_student

            model = load_student(folder)
        cached = _MODELS[folder] = (stamp, model)
    return cached[1]


def predict(run, folder, shipped, texts, keep=True):
    """{text: {state, answers, p, routed}} from one local model, cached per folder."""
    stamp = _stamp(folder)
    off = bool(run.meta.get("backup_off"))
    digest = hashlib.sha1(("\0".join(texts) + f"\0off={off}").encode()).hexdigest()
    cached = _PREDICTED.get(folder)
    if cached and cached[0] == stamp and cached[1] == digest:
        return cached[2]
    model = _load(run, folder, shipped)
    questions = run.questions()
    proba = model.predict_proba(texts) if texts else {}
    columns = []
    for q in questions:
        if run.kind == "classifier":
            values = label_proba(model, q, proba) if len(texts) else None
        else:
            values = proba.get(q["id"])
        columns.append([answer_of(q, v) for v in values] if values is not None
                       else [(None, None)] * len(texts))
    routed = [False] * len(texts)
    if shipped and getattr(model, "routing", None) and texts and not off:
        routed = [not bool(x) for x in model.local(texts)]
    out = {}
    for i, text in enumerate(texts):
        out[text] = {"state": "ok", "answers": [c[i][0] for c in columns],
                     "p": [c[i][1] for c in columns], "routed": routed[i]}
    if keep:
        _PREDICTED[folder] = (stamp, digest, out)
    return out


def _predict_or_skip(run, folder, shipped, texts, keep=True):
    """A method that can't load (its base model isn't downloaded and there's no network, say)
    leaves its column empty instead of failing the whole table."""
    try:
        return predict(run, folder, shipped, texts, keep=keep)
    except Exception as exc:
        warnings.warn(f"couldn't run {folder.name}: {type(exc).__name__}: {exc}", stacklevel=2)
        return None


def local_answers(run, texts, methods=None):
    """{method id: [cell per text]} for texts typed in (Try, the Playground), from every trained
    method or only `methods`."""
    out = {}
    for method, (folder, shipped) in method_folders(run).items():
        if methods is not None and method not in methods:
            continue
        cells = _predict_or_skip(run, folder, shipped, list(texts), keep=False)
        if cells is not None:
            out[method] = [cells[t] for t in texts]
    return out


# ---------------------------------------------------------------- the table


def _why(run, queue):
    """{text: one line} from needs_review.csv, in queue order."""
    out = {}
    if queue.empty:
        return out
    several = len(run.teachers()) > 1
    votes = run.task()["votes"]
    records = queue.to_dict("records")
    if run.kind == "classifier":
        for first in records:
            text = first["text"]
            if text in out:
                continue
            why = str(first.get("why") or "")
            out[text] = (why if why.startswith("no answer from") else
                         "no usable answer" if first.get("label") == INVALID else
                         "teachers disagree" if why == "teachers split" or (not why and several)
                         else "votes split" if not why and votes > 1 else "unsure")
        return out
    grouped = {}
    for r in records:
        why = str(r.get("why", "") or "")
        head = ("teachers disagree on" if why.startswith("teachers split") else
                "unsure on" if why.startswith("unsure") else
                "spot check on" if why.startswith("spot check") else
                why if why.startswith("no answer from") else "no usable answer on")
        grouped.setdefault(r["text"], {}).setdefault(head, []).append(r["question"])
    for text, parts in grouped.items():
        out[text] = "; ".join(head if head.startswith("no answer from")
                              else f"{head} {', '.join(qs)}" for head, qs in parts.items())
    return out


def _flagged(run, queue):
    """{text: the panel questions it's queued for, in the panel's order}, so review can start
    on the one that needs you. Empty for a classifier, which has one question."""
    if queue.empty or run.kind == "classifier":
        return {}
    order = {q["id"]: i for i, q in enumerate(run.questions())}
    seen = {}
    for text, question in zip(queue["text"], queue["question"], strict=True):
        seen.setdefault(text, set()).add(question)
    return {text: sorted(qs, key=lambda q: order.get(q, len(order))) for text, qs in seen.items()}


def _stamp_run(run):
    files = [run.file(name) for name in WATCHED] + sorted(run.path.glob("candidates/*/meta.json"))
    return tuple((str(f), f.stat().st_mtime) if f.exists() else str(f) for f in files)


def table(run):
    """Every row, built once and kept until a file it reads changes."""
    with _BUILDING[run.path]:
        stamp = _stamp_run(run)
        cached = _TABLES.get(run.path)
        # a method that couldn't load (an extra installed since, a download that failed) is
        # tried again after a while, rather than left out until one of the files changes
        if cached and cached[0] == stamp and (cached[2] or time.monotonic() - cached[3] < 30):
            return cached[1]
        rows, complete = _build(run)
        _TABLES[run.path] = (stamp, rows, complete, time.monotonic())
        return rows


def _build(run):
    questions = run.questions()
    task = run.task()
    sets = [("pool", run.pool_texts())]
    seeds = {}
    for split in ("tuning", "test"):
        frame = run.seed(split)
        seeds[split] = [] if frame is None else frame.to_dict("records")
        sets.append((split, [] if frame is None else frame["text"].tolist()))
    labeled = run.labeled()
    by_text = {} if labeled is None else {r["text"]: r for r in labeled.to_dict("records")}
    ledger = run.ledger()
    queue = run.review_rows()
    why = _why(run, queue)
    flagged = _flagged(run, queue)
    order = {t: i for i, t in enumerate(why)}
    final = run.final_tests() > 0
    several = len(run.teachers()) > 1
    escalated = bool((run.agreement() or {}).get("escalation"))
    shipped = run.shipped() if run.has("report.json") else None
    texts = [t for _, ts in sets for t in ts]
    folders = method_folders(run)
    local = {m: cells for m, (folder, is_shipped) in folders.items()
             if (cells := _predict_or_skip(run, folder, is_shipped, texts)) is not None}
    with _LOADING:
        release_heavy()

    teachers = Teachers(run, votes=task["votes"], preload=True)
    rows = []
    try:
        for split, split_texts in sets:
            records = seeds.get(split)
            for i, text in enumerate(split_texts):
                if split == "pool":
                    mine = ledger.get(text, {})
                    you = [_shown(run, q, mine.get(q["id"])) for q in questions]
                else:
                    record = records[i]
                    you = [_shown(run, q, record.get("label" if run.kind == "classifier"
                                                      else q["id"])) for q in questions]
                pooled = by_text.get(text) if split == "pool" else None
                cells = []
                for t, model in enumerate(run.teachers()):
                    if split == "test" and not final:
                        cell = {"state": "locked", "answers": [None] * len(questions),
                                "p": [None] * len(questions), "votes": None, "alt": None}
                    else:
                        cell = teachers.cell(model, text, votes=1 if split == "test" else None)
                        if (cell["state"] == "none" and escalated and t > 0
                                and pooled is not None):
                            cell["state"] = "notasked"
                    cells.append(cell)
                combined = None
                if several and pooled is not None:
                    combined = [_combined(run, q, pooled) for q in questions]
                methods = {}
                for method, cells_by_text in local.items():
                    if split == "test" and method != shipped:
                        methods[method] = _blank("locked", len(questions))
                    else:
                        methods[method] = cells_by_text[text]
                rnd = pooled.get("round") if pooled is not None else None
                rows.append({
                    "key": row_key(split, text), "set": split, "text": text, "you": you,
                    "needs": why.get(text) if split == "pool" else None,
                    "flagged": flagged.get(text, []) if split == "pool" else [],
                    "reviewed": split == "pool" and text in ledger,
                    "round": int(rnd) if rnd not in (None, "") and not _nan(rnd) else None,
                    "teachers": cells, "combined": combined, "methods": methods,
                    "_order": order.get(text, math.inf),
                })
    finally:
        teachers.close()
    return rows, len(local) == len(folders)


def _blank(state, n):
    return {"state": state, "answers": [None] * n, "p": [None] * n, "routed": False}


def _nan(value):
    return isinstance(value, float) and math.isnan(value)


def _shown(run, question, value):
    index = run.index_of(question, value)
    return None if index is None else question["options"][index]


def _combined(run, question, pooled):
    if run.kind == "classifier":
        label = pooled.get("label")
        return label if label in question["keys"] else None
    vector = [pooled.get(f"{question['id']}__{k}") for k in question["keys"]]
    try:
        vector = [float(v) for v in vector]
    except (TypeError, ValueError):
        return None
    return answer_of(question, vector)[0]


# ---------------------------------------------------------------- filters


def _reference(row, j):
    if row["you"][j] is not None:
        return row["you"][j]
    if row["combined"] and row["combined"][j] is not None:
        return row["combined"][j]
    for cell in row["teachers"]:
        if cell["state"] == "ok" and cell["answers"][j] is not None:
            return cell["answers"][j]
    return None


def _keep(row, flt, qs):
    if flt == "needs":
        return row["needs"] is not None
    if flt == "disagree":
        return any(len({c["answers"][j] for c in row["teachers"] if c["state"] == "ok"
                        and c["answers"][j] is not None}) > 1 for j in qs)
    if flt == "vsyou":
        return any(row["you"][j] is not None and c["state"] == "ok"
                   and c["answers"][j] is not None and c["answers"][j] != row["you"][j]
                   for j in qs for c in row["teachers"])
    if flt == "local":
        for j in qs:
            ref = _reference(row, j)
            if ref is not None and any(c["state"] == "ok" and c["answers"][j] != ref
                                       for c in row["methods"].values()):
                return True
        return False
    if flt == "routed":
        return any(c["state"] == "ok" and c.get("routed") for c in row["methods"].values())
    return True


FILTERS = ("all", "needs", "disagree", "vsyou", "local", "routed")
SETS = ("all", "pool", "tuning", "test")


def page(run, jobs, split="all", flt="all", q="all", search="", offset=0, limit=300):
    """GET /api/models/{id}/rows."""
    if split not in SETS:
        raise ValueError(f"set is one of {', '.join(SETS)}")
    if flt not in FILTERS:
        raise ValueError(f"filter is one of {', '.join(FILTERS)}")
    n_questions = len(run.questions())
    if q in ("all", None, ""):
        qs = list(range(n_questions))
    else:
        try:
            qs = [int(q)]
        except ValueError:
            raise ValueError("q is a question index or all") from None
        if not 0 <= qs[0] < n_questions:
            raise ValueError(f"q is between 0 and {n_questions - 1}")
    rows = [r for r in table(run) if split in ("all", r["set"])]
    total = len(rows)
    needle = (search or "").strip().lower()
    matched = [r for r in rows if (not needle or needle in r["text"].lower())
               and _keep(r, flt, qs)]
    if flt == "needs":
        matched.sort(key=lambda r: r["_order"])
    overlay = _running_methods(run, jobs)
    out = [_public(r, overlay, n_questions) for r in matched[offset:offset + limit]]
    return {"total": total, "matched": len(matched), "rows": out}


def _running_methods(run, jobs):
    """Methods being compared right now show as running or queued, not their old answers."""
    out = {}
    for job in jobs.of(run.id, kind="compare"):
        out[job.params.get("method")] = "running" if job.state == "running" else "queued"
    return out


def _public(row, overlay, n):
    out = {k: v for k, v in row.items() if not k.startswith("_")}
    if overlay:
        out["methods"] = {**row["methods"], **{m: _blank(s, n) for m, s in overlay.items()}}
    return out


def find(run, key):
    """The row with this key, or None."""
    return next((r for r in table(run) if r["key"] == key), None)


def public(row, run, jobs):
    return _public(row, _running_methods(run, jobs), len(run.questions()))


def routing(run):
    """{curve: [[budget %, local %], ...], selected, chosen, off} from shrewd.route.curve, or
    None. `chosen` is False after a first ship with routing, until a limit is picked: what each
    limit leaves local is only known once the model is trained. `off` is Studio's own switch:
    the threshold stays saved, but nothing is shown as going to the teachers."""
    from shrewd.route import HELD_FILE, curve

    if not run.file(f"student/{HELD_FILE}").exists():
        return None
    meta = read_json(run.file("student/meta.json")) or {}
    current = (meta.get("routing") if meta.get("type") == "decisions"
               else read_json(run.file("student/routing.json"))) or {}
    budgets = [0.01, 0.02, 0.05, 0.1]
    if current.get("budget") is not None and current["budget"] not in budgets:
        budgets = sorted(budgets + [current["budget"]])
    try:
        points = curve(run.path, budgets=tuple(budgets), delta=current.get("delta", 0.05))
    except (FileNotFoundError, ValueError):
        return None
    selected = next((i for i, b in enumerate(budgets) if b == current.get("budget")), None)
    return {"curve": [[_whole(p["budget"] * 100), int(round(p["coverage"] * 100))]
                      for p in points], "selected": selected,
            "chosen": run.meta.get("routing_chosen", True),
            "off": bool(run.meta.get("backup_off"))}


def backup_on(run):
    current = routing(run)
    return bool(current) and not current["off"]


def _whole(value):
    value = round(value, 2)
    return int(value) if float(value).is_integer() else value
