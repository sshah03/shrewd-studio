"""Read shrewd run directories.

A run directory is the only state there is: manifest.json, the seed splits, the labeled or
judged pool, each teacher's votes, agreement.json, teacher_check.json, needs_review.csv,
report.json, candidates/ and student/. Studio adds studio.json beside them for what the
library has no place for (a display name, the labeling settings Studio passes to its jobs)
and studio_compare.json for compare rows merged across jobs.
"""

import json
import math
import os
import re
from pathlib import Path

import pandas as pd
from shrewd.decide import from_dict

TYPES = {"choice": "choice", "noul": "yes/no", "score": "score"}


def short_name(model):
    return str(model).rsplit("/", 1)[-1]


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "model"


def num(value, digits=4):
    """JSON-safe float: NaN and inf become None."""
    if value is None:
        return None
    value = float(value)
    return None if math.isnan(value) or math.isinf(value) else round(value, digits)


def pct(value):
    return None if value is None else int(round(float(value) * 100))


def read_csv(path, **kwargs):
    try:
        return pd.read_csv(path, **kwargs)
    except (FileNotFoundError, pd.errors.EmptyDataError):
        return None


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return None


def tilde(path):
    """A path with the home folder written as ~, for display only."""
    home = str(Path.home())
    text = str(path)
    return "~" + text[len(home):] if text == home or text.startswith(home + os.sep) else text


class Run:
    """One model: a run directory, read lazily."""

    def __init__(self, path):
        self.path = Path(path)
        self.id = self.path.name
        self.manifest = json.loads((self.path / "manifest.json").read_text())
        self.kind = "panel" if self.manifest.get("kind") == "decisions" else "classifier"
        self.meta = read_json(self.path / "studio.json") or {}

    def save_meta(self, **changes):
        self.meta.update(changes)
        (self.path / "studio.json").write_text(json.dumps(self.meta, indent=2))

    def project(self):
        """The library object, reopened from the manifest."""
        if self.kind == "panel":
            from shrewd import Decisions

            return Decisions(self.path)
        from shrewd import Project

        return Project(self.path)

    @property
    def name(self):
        return self.meta.get("name") or self.id.replace("-", " ").replace("_", " ").capitalize()

    def teachers(self):
        teacher = self.manifest["teacher"]
        return list(teacher) if isinstance(teacher, list) else [teacher]

    def shrewd_questions(self):
        return {k: from_dict(v) for k, v in self.manifest["questions"].items()}

    def questions(self):
        """Every question as {id, type, text, options, keys, spec}: `options` are what a
        person reads (a score's level names), `keys` the option names in shrewd's files. A
        classifier is one choice question, `label`."""
        if self.kind == "classifier":
            labels = list(self.manifest["labels"])
            return [{"id": "label", "type": "choice", "text": None, "options": labels,
                     "keys": labels, "spec": None}]
        out = []
        for key, q in self.shrewd_questions().items():
            options = list(q.criteria) if q.kind == "score" else q.options()
            out.append({"id": key, "type": TYPES[q.kind], "text": q.instructions,
                        "options": [str(o) for o in options], "keys": q.options(), "spec": q})
        return out

    def index_of(self, question, value):
        """An answer as written anywhere (a label, an option, yes/no, a level number or
        name) to its option index, or None."""
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
        text = str(value).strip()
        if not text:
            return None
        if question["spec"] is None:
            lookup = {o.lower(): i for i, o in enumerate(question["options"])}
            return lookup.get(text.lower())
        from shrewd.decisions import gold_index

        return gold_index(question["spec"], text)

    def header(self):
        path = self.file("prompt_header.txt")
        return path.read_text() if path.exists() else None

    def prompt_text(self):
        """The system prompt the teachers are sent (what the classifier cache is keyed on)."""
        if self.kind == "panel":
            from shrewd import decide

            return decide.build_prompt(self.shrewd_questions(), self.manifest.get("instructions"),
                                       header=self.header())
        path = self.file("prompt.txt")
        if path.exists():
            return path.read_text()
        from shrewd.optimize import build_seed_prompt

        return build_seed_prompt(self.manifest["instructions"], self.manifest["labels"])

    def ensure_prompt(self):
        """A classifier labels from prompt.txt, and shrewd's docs say to write the seed
        prompt there yourself to skip optimization, which is what Studio does."""
        path = self.file("prompt.txt")
        if self.kind == "classifier" and not path.exists():
            path.write_text(self.prompt_text())

    # -- files -----------------------------------------------------------------------

    def file(self, name):
        return self.path / name

    def has(self, name):
        return (self.path / name).exists()

    def pool_file(self):
        return self.file("pool_judged.csv" if self.kind == "panel" else "pool_labeled.csv")

    def seed(self, split):
        name = {"tuning": "seed_dev.csv", "test": "seed_test.csv"}[split]
        return read_csv(self.file(name), dtype=str, keep_default_na=False)

    def seed_texts(self):
        out = set()
        for split in ("tuning", "test"):
            frame = self.seed(split)
            if frame is not None:
                out |= set(frame["text"])
        return out

    def pool_texts(self):
        """Every pool document in order: what was added, then anything labeled that wasn't
        (a pool labeled from Python). Seed documents are never part of the pool."""
        texts = []
        for name in ("pool_input.csv", self.pool_file().name):
            frame = read_csv(self.file(name), dtype=str, keep_default_na=False)
            if frame is not None:
                texts += frame["text"].tolist()
        seed = self.seed_texts()
        return [t for t in dict.fromkeys(texts) if t.strip() and t not in seed]

    def labeled(self):
        frame = read_csv(self.pool_file(), keep_default_na=False)
        if frame is not None:
            frame["text"] = frame["text"].astype(str)
        return frame

    def agreement(self):
        return read_json(self.file("agreement.json"))

    def teacher_check(self):
        return read_json(self.file("teacher_check.json"))

    def report_json(self):
        return read_json(self.file("report.json"))

    def label_log(self):
        return read_json(self.file("label_log.json"))

    def stages(self):
        return self.manifest.get("stages", [])

    def final_tests(self):
        return sum(1 for s in self.stages() if s["name"] == "distill")

    def spent(self):
        return round(sum(s.get("cost_usd", 0.0) for s in self.stages()), 4)

    def shipped(self):
        """The shipped method's id, from student/meta.json."""
        meta = read_json(self.file("student/meta.json"))
        if meta is None:
            return None
        return meta.get("features") if meta.get("type") == "decisions" else meta.get("type")

    def compared(self):
        """compare.json rows as {method: row}."""
        blob = read_json(self.file("compare.json")) or {}
        key = "features" if self.kind == "panel" else "student"
        return {r[key]: r for r in blob.get("candidates", [])}

    # -- the review queue -------------------------------------------------------------

    def ledger(self):
        """reviewed.csv: your answers on pool documents, {text: {question: answer}}."""
        frame = read_csv(self.file("reviewed.csv"), dtype=str, keep_default_na=False)
        out = {}
        if frame is None:
            return out
        for _, r in frame.iterrows():
            if self.kind == "panel":
                out.setdefault(r["text"], {})[r["question"]] = r["answer"]
            else:
                out.setdefault(r["text"], {})["label"] = r["label"]
        return out

    def review_rows(self):
        """needs_review.csv minus anything already answered by hand."""
        queue = read_csv(self.file("needs_review.csv"), dtype=str, keep_default_na=False)
        if queue is None or queue.empty:
            return pd.DataFrame()
        answer = "human_answer" if self.kind == "panel" else "human_label"
        if answer in queue.columns:
            queue = queue[queue[answer].str.strip() == ""]
        done = self.ledger()
        if self.kind == "panel":
            keep = [q not in done.get(t, {}) for t, q in zip(queue["text"], queue["question"],
                                                              strict=True)]
        else:
            keep = [t not in done for t in queue["text"]]
        return queue[keep]

    def review_count(self):
        rows = self.review_rows()
        return 0 if rows.empty else int(rows["text"].nunique())

    def labeled_combine(self):
        """How the labels on disk combined several teachers: what shrewd recorded, or its
        default, majority. None before labeling and for panels or a single teacher."""
        if (self.kind != "classifier" or len(self.teachers()) < 2
                or not any(s["name"] == "label" for s in self.stages())):
            return None
        return self.manifest.get("combine") or "majority"

    # -- what Studio keeps ----------------------------------------------------------

    def task(self, concurrency=8):
        """The labeling settings Studio passes to its jobs. Where Studio has nothing
        stored, what shrewd's own files say fills in."""
        stored = self.meta.get("task") or {}
        several = len(self.teachers()) > 1
        last = next((s["params"] for s in reversed(self.stages()) if s["name"] == "label"), {})
        combine = escalate = None
        limit = {"mode": "all", "value": None}
        if self.kind == "classifier":
            if several:
                # weighted unless chosen otherwise, or the pool was already labeled by
                # shrewd's own default (majority), so the labels on disk say what was done
                combine = stored.get("combine") or self.labeled_combine() or "weighted"
            limit = stored.get("limit")
            if limit is None:
                limit = {"mode": "all", "value": None}
                if last.get("mode") == "active" and last.get("n"):
                    limit = {"mode": "n", "value": last["n"]}
                elif last.get("mode") == "active" and last.get("budget_usd"):
                    limit = {"mode": "usd", "value": last["budget_usd"]}
        elif several:
            combine = "weighted"
            if "escalate" in stored:
                escalate = stored["escalate"]
            else:
                done = (self.agreement() or {}).get("escalation")
                if done:
                    escalate = {"budget": pct(done["budget"]), "delta": done["delta"]}
        return {"combine": combine,
                "votes": int(stored.get("votes") or last.get("votes") or 1),
                "escalate": escalate, "limit": limit,
                "concurrency": int(stored.get("concurrency") or concurrency)}
