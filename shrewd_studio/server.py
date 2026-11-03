"""The Studio API and the built frontend, served on 127.0.0.1."""

import collections
import contextlib
import functools
import io
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import threading
import uuid
import warnings
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import pandas as pd
import shrewd
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from shrewd_studio import NO_WINDOW, __version__, rows, views
from shrewd_studio.jobs import Jobs
from shrewd_studio.settings import DEFAULT_WORKSPACE, Settings
from shrewd_studio.workspace import Run, read_csv, read_json, slug, tilde

STATIC = Path(__file__).parent / "static"


def create_app(workspace, sandbox=False, settings=None, workspace_source="flag",
               default_workspace=None, restart=None):
    """`workspace_source` says what chose the folder ("flag", "env", "settings", "default"):
    Settings can only change it when it wasn't the flag or the variable. `restart` stops the
    server and starts it again, which is how a changed folder takes effect."""
    root = Path(workspace).expanduser().resolve()
    default_workspace = Path(default_workspace or DEFAULT_WORKSPACE).expanduser().resolve()
    boot = uuid.uuid4().hex
    root.mkdir(parents=True, exist_ok=True)
    settings = settings or Settings()
    try:
        settings.load_keys()
    except Exception as exc:  # no usable key store: keys from the shell still work
        warnings.warn(f"couldn't read keys from the {system()['keystore']}: {exc}", stacklevel=2)
    settings.apply()
    jobs = Jobs(root, sandbox=sandbox, limits=lambda: (settings["compute"]["cpu_jobs"],
                                                       settings["compute"]["gpu_jobs"]))
    # litellm takes a couple of seconds to import; do it before the first page asks
    threading.Thread(target=lambda: __import__("litellm"), daemon=True).start()

    @asynccontextmanager
    async def lifespan(app):
        yield
        jobs.shutdown()

    app = FastAPI(title="Shrewd Studio", version=__version__, lifespan=lifespan)

    @app.middleware("http")
    async def only_from_this_computer(request, call_next):
        refusal = _refuse(request.headers, request.method)
        if refusal:
            return PlainTextResponse(refusal, status_code=403)
        return await call_next(request)

    edits = collections.defaultdict(threading.Lock)

    def one_at_a_time(endpoint):
        """Edits to one model's answers run one after another. Requests are served on several
        threads, and answering quickly from the keyboard sends the next save while shrewd is
        still rewriting the files the last one changed."""
        @functools.wraps(endpoint)
        def serial(*args, **kwargs):
            with edits[kwargs["model_id"]]:
                return endpoint(*args, **kwargs)
        return serial

    def run_of(model_id):
        path = root / model_id
        if "/" in model_id or model_id.startswith(".") or not (path / "manifest.json").exists():
            raise HTTPException(404, f"no model {model_id!r} in {root}")
        return Run(path)

    def guard(run):
        """Edits that rewrite the manifest or the examples wait for the model's jobs, since a
        running worker would write its own copy of the manifest back over them."""
        if jobs.busy(run.id):
            raise HTTPException(409, "a job is running on this model; wait for it, or pause it")

    def bad(exc):
        return HTTPException(400, str(exc) or type(exc).__name__)

    def submit(run, kind, params, title, uses):
        return jobs.submit(run.id, run.name, kind, title, uses, params)

    # -- models ----------------------------------------------------------------------

    @app.get("/api/models")
    def list_models():
        found = sorted((Run(p.parent) for p in root.glob("*/manifest.json")),
                       key=lambda r: (r.kind, r.name.lower()))
        return [views.model_row(r, jobs) for r in found]

    @app.get("/api/search")
    def search(q: str = "", limit: int = 20):
        """Models by name and documents by text, across the workspace. Reads files only."""
        needle = q.strip().lower()
        if not needle:
            return {"models": [], "documents": []}
        runs = sorted((Run(p.parent) for p in root.glob("*/manifest.json")),
                      key=lambda r: (r.kind, r.name.lower()))
        models = [{"id": r.id, "name": r.name} for r in runs if needle in r.name.lower()]
        documents = []
        for r in runs:
            sets = [("pool", r.pool_texts())]
            for split, name in (("tuning", "seed_dev.csv"), ("test", "seed_test.csv")):
                if r.has(name):
                    sets.append((split, read_csv(r.file(name))["text"].astype(str).tolist()))
            for split, texts in sets:
                for text in texts:
                    if needle in text.lower():
                        documents.append({"model": r.id, "model_name": r.name, "set": split,
                                          "text": text})
                        if len(documents) >= limit:
                            return {"models": models, "documents": documents}
        return {"models": models, "documents": documents}

    @app.post("/api/models")
    def create(body: dict = Body(...)):
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "give the model a name")
        teachers = _names(body.get("teachers")) or settings["defaults"]["teachers"]
        if not teachers:
            raise HTTPException(400, "pick at least one teacher model")
        path = root / slug(name)
        n = 1
        while path.exists():
            n += 1
            path = root / f"{slug(name)}-{n}"
        teacher = teachers if len(teachers) > 1 else teachers[0]
        instructions = (body.get("instructions") or "").strip() or None
        seed = settings["defaults"]["seed"]
        try:
            if body.get("kind") == "panel":
                from shrewd import Decisions

                Decisions(path, questions=_questions(body.get("questions") or []),
                          instructions=instructions, teacher=teacher, seed=seed)
            else:
                from shrewd import Project

                labels = _labels(body.get("labels"))
                if len(labels) < 2:
                    raise ValueError("a classifier needs at least two labels")
                if not instructions:
                    raise ValueError("describe the task in a sentence or two")
                Project(path, instructions=instructions, labels=labels, teacher=teacher,
                        seed=seed)
        except (ValueError, TypeError) as exc:
            raise bad(exc) from None
        Run(path).save_meta(name=name)
        return {"id": path.name}

    @app.get("/api/models/{model_id}")
    def model(model_id: str):
        return views.model_view(run_of(model_id), jobs)

    @app.get("/api/models/{model_id}/rows")
    def model_rows(model_id: str, set: str = "all", filter: str = "all", q: str = "all",
                   search: str = "", offset: int = 0, limit: int = 300):
        try:
            return rows.page(run_of(model_id), jobs, set, filter, q, search, max(0, offset),
                             max(1, min(limit, 2000)))
        except ValueError as exc:
            raise bad(exc) from None

    @app.post("/api/models/{model_id}/answers")
    @one_at_a_time
    def answers(model_id: str, body: dict = Body(...)):
        run = run_of(model_id)
        row = rows.find(run, body.get("key") or "")
        if row is None:
            raise HTTPException(404, "no such row")
        given = {k: v for k, v in (body.get("answers") or {}).items() if v not in (None, "")}
        if not given:
            raise HTTPException(400, "send at least one answer")
        lib = run.project()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                if row["set"] == "pool":
                    if run.kind == "panel":
                        applied = lib.review([{"text": row["text"], "question": q, "answer": a}
                                              for q, a in given.items()])
                    else:
                        applied = lib.review([{"text": row["text"], "label": given.get("label")}])
                    if not applied:
                        reason = "; ".join(str(w.message) for w in caught)
                        raise ValueError(reason or "nothing was applied")
                else:
                    guard(run)
                    if run.kind == "panel":
                        lib.fix_example(row["text"], given)
                    else:
                        lib.fix_example(row["text"], given.get("label"))
            except (ValueError, KeyError, FileNotFoundError) as exc:
                raise bad(exc) from None
        return rows.public(rows.find(run, row["key"]), run, jobs)

    @app.post("/api/models/{model_id}/answers/clear")
    @one_at_a_time
    def clear_answer(model_id: str, body: dict = Body(...)):
        """Take your answer back. On a pool row the teachers' answer returns (shrewd's
        unreview, no API calls); on an example, a panel question is left unanswered. A
        classifier example always has a label, so it's removed instead (examples/remove)."""
        run = run_of(model_id)
        row = rows.find(run, body.get("key") or "")
        if row is None:
            raise HTTPException(404, "no such row")
        question = body.get("question")
        lib = run.project()
        try:
            if row["set"] == "pool":
                taken = lib.unreview(row["text"], questions=[question] if question else None) \
                    if run.kind == "panel" else lib.unreview(row["text"])
                if not taken:
                    raise ValueError("there's no answer of yours on this document")
            elif run.kind == "panel" and question:
                guard(run)
                lib.fix_example(row["text"], {question: ""})
            else:
                raise ValueError("an example always has a label; remove the example instead")
        except (ValueError, KeyError, FileNotFoundError) as exc:
            raise bad(exc) from None
        return rows.public(rows.find(run, row["key"]), run, jobs)

    @app.post("/api/models/{model_id}/examples/remove")
    @one_at_a_time
    def remove_example(model_id: str, body: dict = Body(...)):
        run = run_of(model_id)
        guard(run)
        row = rows.find(run, body.get("key") or "")
        if row is None or row["set"] not in ("tuning", "test"):
            raise HTTPException(404, "no such example")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")      # the sheet already said the test set shrinks
            dev, test = run.project().remove_examples([row["text"]])
        return {"tuning": dev, "test": test}

    @app.post("/api/models/{model_id}/examples/from-pool")
    @one_at_a_time
    def from_pool(model_id: str, body: dict = Body(...)):
        run = run_of(model_id)
        guard(run)
        row = rows.find(run, body.get("key") or "")
        if row is None or row["set"] != "pool":
            raise HTTPException(404, "no such pool row")
        if all(a is None for a in row["you"]):
            raise HTTPException(400, "answer this document first")
        record = {"text": row["text"]}
        for q, answer in zip(run.questions(), row["you"], strict=True):
            record[q["id"]] = answer or ""
        return add_one(run, record)

    def add_one(run, record):
        """One example, split like a CSV import: a hash of its text decides tuning or test."""
        try:
            dev, test = run.project().add_examples(pd.DataFrame([record]))
        except (ValueError, FileNotFoundError) as exc:
            raise bad(exc) from None
        if not dev + test:
            raise HTTPException(400, "that document is already one of your examples")
        return {"set": "test" if test else "tuning"}

    @app.post("/api/models/{model_id}/examples/typed")
    @one_at_a_time
    def typed_example(model_id: str, body: dict = Body(...)):
        """A document typed in with your answers, as an example. `{text, answers}`, answers
        by question id. The first examples come from a CSV, which sets up the split."""
        run = run_of(model_id)
        if views.archived(run):
            raise HTTPException(400, "this model is archived; it can be used, not changed")
        guard(run)
        text = str(body.get("text") or "").strip()
        if not text:
            raise HTTPException(400, "type a document")
        if not run.has("seed_test.csv"):
            raise HTTPException(400, "import your first examples from a CSV; they're split "
                                     "into tuning and a locked test set")
        answers = body.get("answers") or {}
        record = {"text": text}
        for q in run.questions():
            record[q["id"]] = str(answers.get(q["id"]) or "")
        if run.kind == "classifier" and not record[run.questions()[0]["id"]]:
            raise HTTPException(400, "pick a label first")
        if not any(record[q["id"]] for q in run.questions()):
            raise HTTPException(400, "answer at least one question first")
        return add_one(run, record)

    @app.post("/api/models/{model_id}/try")
    def try_it(model_id: str, body: dict = Body(...)):
        """Local answers for typed documents, free. `{text}` gives each method's answer to it;
        `{texts, methods}` (the Playground) gives a list per method, in the order sent."""
        run = run_of(model_id)
        keep = ("answers", "p", "routed")
        if "texts" in body:
            texts = [str(t).strip() for t in body.get("texts") or [] if str(t).strip()]
            if not texts or len(texts) > 500:
                raise HTTPException(400, "send between 1 and 500 documents")
            answered = rows.local_answers(run, texts, body.get("methods"))
            return {"methods": {m: [{k: c[k] for k in keep} for c in cells]
                                for m, cells in answered.items()}}
        text = (body.get("text") or "").strip()
        if not text:
            raise HTTPException(400, "type a document")
        answered = rows.local_answers(run, [text])
        return {"methods": {m: {k: cells[0][k] for k in keep}
                            for m, cells in answered.items()}}

    @app.post("/api/models/{model_id}/ask")
    def ask(model_id: str, body: dict = Body(...)):
        """The teachers' answers for one typed document. This one costs: the app asks first."""
        run = run_of(model_id)
        text = (body.get("text") or "").strip()
        if not text:
            raise HTTPException(400, "type a document")
        run.ensure_prompt()
        try:
            given = run.project().ask([text])[0]
        except Exception as exc:
            raise bad(exc) from None
        teachers = rows.Teachers(run)
        try:
            cells = [teachers.cell(m, text, votes=1) for m in run.teachers()]
        finally:
            teachers.close()
        combined = None
        if len(run.teachers()) > 1:
            combined = [rows.answer_of(q, rows.vector_of(q, given))[0] for q in run.questions()]
        return {"teachers": cells, "combined": combined}

    # -- playground: your trained models side by side on documents you type ----------------

    @app.get("/api/playground")
    def playground():
        """Every model with a trained method, with what the Playground needs to show it, and the
        documents and picks saved last time."""
        out = []
        runs = sorted((Run(p.parent) for p in root.glob("*/manifest.json")),
                      key=lambda r: (r.kind, r.name.lower()))      # the sidebar's order
        for run in runs:
            trained = rows.method_folders(run)
            if not trained:
                continue
            shipped = run.shipped()
            out.append({
                "id": run.id, "name": run.name, "kind": run.kind,
                "questions": [{"id": q["id"], "options": q["options"]} for q in run.questions()],
                "methods": [{"id": m, "name": views.method_name(m), "shipped": m == shipped,
                             "original": m == f"compared-{shipped}"}
                            for m in sorted(trained, key=lambda m: (
                                m != shipped, m != f"compared-{shipped}", m))],
                "teachers": len(run.teachers()),
                # None when litellm has no price for one of the teachers
                "per_doc": None if None in (prices := [views.per1k(run, t) for t in run.teachers()])
                else round(sum(prices) / 1000, 6),
                "routing": rows.backup_on(run)})
        saved = root / ".studio" / "playground.json"
        return {"models": out, "saved": read_json(saved) if saved.exists() else None}

    @app.put("/api/playground")
    def save_playground(body: dict = Body(...)):
        """What's typed and picked, kept with the workspace (the app's port, and so its browser
        storage, changes every launch)."""
        blob = json.dumps({"picks": body.get("picks") or [], "docs": body.get("docs") or []})
        if len(blob) > 2_000_000:
            raise HTTPException(413, "too many documents to keep; clear some")
        folder = root / ".studio"
        folder.mkdir(exist_ok=True)
        (folder / "playground.json.tmp").write_text(blob)
        (folder / "playground.json.tmp").replace(folder / "playground.json")
        return {"saved": True}

    # -- task --------------------------------------------------------------------------

    @app.get("/api/models/{model_id}/task")
    def get_task(model_id: str):
        return views.task_view(run_of(model_id), settings["defaults"]["concurrency"])

    @app.patch("/api/models/{model_id}/task")
    def patch_task(model_id: str, body: dict = Body(...)):
        run = run_of(model_id)
        guard(run)
        try:
            _edit_task(run, body)
        except (ValueError, TypeError, KeyError) as exc:
            raise bad(exc) from None
        return views.task_view(run_of(model_id), settings["defaults"]["concurrency"])

    @app.get("/api/models/{model_id}/impact")
    def impact(model_id: str, label: str = "", question: str = "", option: str = ""):
        """How many of your examples and pool documents carry a label (classifier) or an
        option of a choice question (panel), for the remove and merge sheets."""
        run = run_of(model_id)
        column, value = ("label", label) if run.kind == "classifier" else (question, option)
        out = {}
        for split, name in (("tuning", "seed_dev.csv"), ("test", "seed_test.csv")):
            frame = read_csv(run.file(name), dtype=str, keep_default_na=False)
            out[split] = int((frame[column] == value).sum()) if frame is not None and \
                column in frame.columns else 0
        if run.kind == "classifier":
            pool = read_csv(run.file("pool_labeled.csv"), dtype=str, keep_default_na=False)
            out["pool"] = int((pool["label"] == value).sum()) if pool is not None else 0
        else:
            pool = read_csv(run.file("pool_judged.csv"))
            prefix = f"{question}__"
            cols = [c for c in (pool.columns if pool is not None else []) if c.startswith(prefix)]
            top = pool[cols].idxmax(axis=1) if cols else None
            out["pool"] = int((top == prefix + option).sum()) if top is not None else 0
        return out

    def _structural(run, change):
        """Run a remove or merge on the shrewd project; its warnings come back as notes."""
        guard(run)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                change(run.project())
            except (ValueError, KeyError) as exc:
                raise bad(exc) from None
        return {"notes": [str(w.message) for w in caught if issubclass(w.category, UserWarning)],
                "task": views.task_view(run_of(run.id), settings["defaults"]["concurrency"])}

    @app.post("/api/models/{model_id}/labels/{label}/remove")
    def remove_label(model_id: str, label: str, body: dict = Body(default={})):
        run = run_of(model_id)
        if run.kind != "classifier":
            raise HTTPException(400, "labels belong to classifiers; panels have questions")
        return _structural(run, lambda lib: lib.remove_label(label, into=body.get("into")))

    @app.post("/api/models/{model_id}/questions/{question}/remove")
    def remove_question(model_id: str, question: str):
        run = run_of(model_id)
        if run.kind != "panel":
            raise HTTPException(400, "questions belong to panels")
        return _structural(run, lambda lib: lib.remove_question(question))

    @app.post("/api/models/{model_id}/questions/{question}/merge")
    def merge_options(model_id: str, question: str, body: dict = Body(...)):
        run = run_of(model_id)
        if run.kind != "panel":
            raise HTTPException(400, "questions belong to panels")
        return _structural(run, lambda lib: lib.merge_options(question, body.get("mapping") or {}))

    @app.post("/api/models/{model_id}/questions/{question}/reask")
    def reask(model_id: str, question: str):
        run = run_of(model_id)
        if run.kind != "panel" or question not in run.manifest["questions"]:
            raise HTTPException(404, f"no question {question!r}")
        return start(run, "reask", {"question": question})["jobs"][0]

    @app.post("/api/models/{model_id}/pool")
    def add_pool(model_id: str, file: UploadFile = File(...), text_column: str = Form(None)):
        run = run_of(model_id)
        frame = _read_upload(file)
        if text_column and text_column in frame.columns and text_column != "text":
            frame = frame.drop(columns=["text"], errors="ignore")
            frame = frame.rename(columns={text_column: "text"})
        if "text" not in frame.columns:
            raise HTTPException(400, "pick the column that holds the documents")
        texts = frame["text"].astype(str)
        texts = texts[texts.str.strip() != ""]
        old = read_csv(run.file("pool_input.csv"), dtype=str, keep_default_na=False)
        if old is not None:            # adding documents adds to the pool, it doesn't replace it
            texts = pd.concat([old["text"], texts])
        texts = texts.drop_duplicates()
        pd.DataFrame({"text": texts}).to_csv(run.file("pool_input.csv"), index=False)
        return {"n": len(run.pool_texts())}

    @app.post("/api/models/{model_id}/pool/typed")
    @one_at_a_time
    def typed_document(model_id: str, body: dict = Body(...)):
        """A document typed in, added to the pool for the teachers to label."""
        run = run_of(model_id)
        if views.archived(run):
            raise HTTPException(400, "this model is archived; it can be used, not changed")
        text = str(body.get("text") or "").strip()
        if not text:
            raise HTTPException(400, "type a document")
        if text in run.seed_texts():
            raise HTTPException(400, "that document is one of your examples")
        if text in set(run.pool_texts()):
            raise HTTPException(400, "that document is already in the pool")
        old = read_csv(run.file("pool_input.csv"), dtype=str, keep_default_na=False)
        texts = ([] if old is None else old["text"].tolist()) + [text]
        pd.DataFrame({"text": texts}).to_csv(run.file("pool_input.csv"), index=False)
        return {"n": len(run.pool_texts())}

    @app.post("/api/models/{model_id}/examples")
    def add_examples(model_id: str, file: UploadFile = File(...), mapping: str = Form(None),
                     replace: bool = Form(False)):
        """The first import splits into tuning and a locked test set; later imports add to
        both sides without re-splitting. `mapping` renames CSV columns: {csv column:
        "text" | question id | "label"}; unmapped columns are dropped."""
        run = run_of(model_id)
        guard(run)
        frame = _read_upload(file)
        if mapping:
            try:
                renames = {k: v for k, v in json.loads(mapping).items() if v}
            except ValueError:
                raise HTTPException(400, "mapping isn't valid JSON") from None
            frame = frame[[c for c in renames if c in frame.columns]].rename(columns=renames)
        if "text" not in frame.columns:
            raise HTTPException(400, "the CSV needs a 'text' column")
        lib = run.project()
        try:
            if run.has("seed_test.csv") and not replace:
                lib.add_examples(frame)
            else:
                lib.add_seed(frame, test_frac=settings["defaults"]["test_frac"] / 100,
                             overwrite=True)
        except (ValueError, KeyError) as exc:
            raise bad(exc) from None
        return views.model_view(run_of(model_id), jobs)

    @app.get("/api/models/{model_id}/export.csv")
    def export_csv(model_id: str):
        run = run_of(model_id)
        labeled = run.labeled()
        if labeled is None:
            raise HTTPException(404, "the pool isn't labeled yet")
        if run.kind == "panel":
            out = pd.DataFrame({"text": labeled["text"]})
            for q in run.questions():
                pairs = [rows.answer_of(q, [_float(r.get(f"{q['id']}__{k}")) for k in q["keys"]])
                         for r in labeled.to_dict("records")]
                out[q["id"]] = [a for a, _ in pairs]
                out[f"{q['id']}_p"] = [p for _, p in pairs]
            labeled = out
        return Response(labeled.to_csv(index=False), media_type="text/csv", headers={
            "Content-Disposition": f'attachment; filename="{run.id}-labeled.csv"'})

    # -- prompt ------------------------------------------------------------------------

    @app.get("/api/models/{model_id}/prompt")
    def prompt(model_id: str):
        return views.prompt_view(run_of(model_id))

    @app.post("/api/models/{model_id}/prompt/use")
    def use_prompt(model_id: str, body: dict = Body(...)):
        run = run_of(model_id)
        guard(run)
        try:
            views.use_prompt(run, int(body.get("index")))
        except (TypeError, ValueError) as exc:
            raise bad(exc) from None
        return views.prompt_view(run)

    # -- jobs --------------------------------------------------------------------------

    @app.get("/api/jobs")
    def list_jobs():
        return jobs.listing()

    @app.post("/api/jobs/clear")
    def clear_jobs():
        jobs.clear_finished()
        return jobs.listing()

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "no such job")
        return job.to_dict(log=True)

    @app.post("/api/jobs/{job_id}/{action}")
    def control(job_id: str, action: str):
        do = {"pause": jobs.pause, "resume": jobs.resume, "cancel": jobs.cancel}.get(action)
        if do is None:
            raise HTTPException(404, "pause, resume or cancel")
        job = jobs.get(job_id)
        if job is not None and job.kind == "install" and action == "pause":
            raise HTTPException(400, "an install can't be paused halfway; cancel it instead")
        try:
            return do(job_id).to_dict()
        except KeyError:
            raise HTTPException(404, "no such job") from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None

    @app.get("/api/jobs/{job_id}/download")
    def download(job_id: str):
        job = jobs.get(job_id)
        if job is None or not job.output or not Path(job.output).exists():
            raise HTTPException(404, "no file for that job")
        return FileResponse(job.output, media_type="text/csv", filename=f"labeled-{job_id}.csv")

    @app.get("/api/models/{model_id}/estimate")
    def estimate(model_id: str, kind: str = "label"):
        try:
            return views.estimate(run_of(model_id), kind)
        except ValueError as exc:
            raise bad(exc) from None

    @app.post("/api/models/{model_id}/jobs")
    def start_job(model_id: str, body: dict = Body(...)):
        return start(run_of(model_id), body.get("kind"), body.get("params") or {})

    def start(run, kind, params):
        task = run.task(settings["defaults"]["concurrency"])
        if kind in ("check", "label", "optimize", "reask") and not run.has("seed_dev.csv"):
            raise HTTPException(400, "add your labeled examples first")
        if kind == "check":
            # a second check at once would ask the teachers the same things again, and pay
            # twice, since answers are cached only as they come back
            if jobs.of(run.id, kind="check"):
                raise HTTPException(409, "the teachers are already being checked")
            return {"jobs": [submit(run, kind, {"votes": task["votes"]}, "Check teachers",
                                    "API").to_dict()]}
        if kind in ("label", "reask"):
            if jobs.of(run.id, kind=kind):
                raise HTTPException(409, "this model is already being labeled")
            if not run.pool_texts():
                raise HTTPException(400, "add documents to the pool first")
            settings_now = {**task, **{k: v for k, v in params.items() if k in task}}
            if kind == "reask":
                title = f"Re-ask {params['question']}"
                settings_now["question"] = params["question"]
            elif settings_now["limit"]["mode"] == "n":
                title = f"Labeling, up to {int(settings_now['limit']['value']):,}"
            elif settings_now["limit"]["mode"] == "usd":
                title = f"Labeling, up to ${float(settings_now['limit']['value']):,.2f}"
            elif (more := views.unlabeled(run)) and run.labeled() is not None:
                title = f"Label {more:,} more document{'s' if more != 1 else ''}"
            elif run.labeled() is not None:
                title = "Label again"
            else:
                title = f"Label {len(run.pool_texts()):,} documents"
            return {"jobs": [submit(run, kind, settings_now, title, "API").to_dict()]}
        if kind == "optimize":
            if sandbox:
                raise HTTPException(400, "prompt optimization isn't simulated in the sandbox")
            return {"jobs": [submit(run, kind, params, "Optimize the prompt", "API").to_dict()]}
        if kind in ("compare", "ship"):
            if not run.pool_file().exists():
                raise HTTPException(400, "label the pool first")
            wanted = (params.get("methods") or []) if kind == "compare" else \
                [params.get("method")]
            for method in wanted:
                if method not in views.METHODS[run.kind]:
                    raise HTTPException(400, f"unknown method {method!r}")
                if not views.installed(method):
                    raise HTTPException(400, f'{method} needs pip install "shrewd[{method}]"')
            if not wanted:
                raise HTTPException(400, "pick at least one method")
            if kind == "ship":
                if jobs.of(run.id, kind="ship"):     # both would write the shipped model
                    raise HTTPException(409, "this model is already being shipped")
                method = wanted[0]
                # a limit picked earlier carries over (the app sends it); on a first ship the
                # app asks for one once the model is trained and the trade-off is known
                if params.get("routing"):
                    chosen = run.meta.get("routing_chosen", True) and rows.routing(run)
                    run.save_meta(routing_chosen=bool(chosen))
                run.save_meta(backup_off=False)
                title = f"Ship {views.METHOD_NAMES[method]}, final test {run.final_tests() + 1}"
                uses = "GPU" if method in views.GPU else "CPU"
                return {"jobs": [submit(run, kind, params, title, uses).to_dict()]}
            running = {j.params.get("method") for j in jobs.of(run.id, kind="compare")}
            started = []
            for method in wanted:
                if method not in running:
                    started.append(submit(run, kind, {"method": method,
                                                      "soft": params.get("soft", True)},
                                          f"Compare, {views.METHOD_NAMES[method]}",
                                          "GPU" if method in views.GPU else "CPU").to_dict())
            return {"jobs": started}
        raise HTTPException(400, f"unknown job {kind!r}")

    # -- routing, report, use -----------------------------------------------------------

    @app.post("/api/models/{model_id}/route")
    def route(model_id: str, body: dict = Body(...)):
        from shrewd.route import rebudget

        run = run_of(model_id)
        guard(run)
        current = rows.routing(run)
        if current is None:
            raise HTTPException(400, "ship with routing on first")
        if body.get("off"):
            run.save_meta(backup_off=True, routing_chosen=True)
            return rows.routing(run)
        try:
            budget = float(body.get("budget"))
            if not 0 < budget < 100:
                raise ValueError("budget is a percentage between 0 and 100")
            rebudget(run.path, budget / 100)
        except (TypeError, ValueError, FileNotFoundError) as exc:
            raise bad(exc) from None
        run.save_meta(routing_chosen=True, backup_off=False)
        return rows.routing(run)

    @app.get("/api/models/{model_id}/report")
    def report(model_id: str):
        out = views.report_view(run_of(model_id))
        if out is None:
            raise HTTPException(404, "ship a method first; shipping runs the final test")
        return out

    @app.post("/api/models/{model_id}/label-file")
    def label_file(model_id: str, file: UploadFile = File(...), mode: str = Form("local")):
        run = run_of(model_id)
        if not run.has("student/meta.json"):
            raise HTTPException(400, "ship a method first")
        frame = _read_upload(file)
        if "text" not in frame.columns:
            raise HTTPException(400, "the CSV needs a 'text' column")
        folder = run.file("labeled_files")
        folder.mkdir(exist_ok=True)
        source = folder / f"{uuid.uuid4().hex[:10]}-input.csv"
        frame.to_csv(source, index=False)
        job = submit(run, "label-file", {"input": str(source), "mode": mode},
                     f"Label {len(frame):,} documents from a file", "CPU")
        return job.to_dict()

    @app.delete("/api/models/{model_id}/methods/{method}")
    def remove_method(model_id: str, method: str):
        """Delete a compared candidate. The shipped model in student/ is never touched."""
        run = run_of(model_id)
        folder = run.file(f"candidates/{method}")
        if "/" in method or method.startswith(".") or not folder.is_dir():
            raise HTTPException(404, "no such method")
        if any(j.params.get("method") == method for j in jobs.of(run.id, kind="compare")):
            raise HTTPException(409, "that method is still training")
        shutil.rmtree(folder)
        merged = {k: v for k, v in (read_json(run.file("studio_compare.json")) or {}).items()
                  if k != method}
        run.file("studio_compare.json").write_text(json.dumps(merged, indent=2))
        rows = [r for r in (read_json(run.file("compare.json")) or {}).get("candidates", [])
                if (r.get("student") or r.get("features")) != method]
        run.file("compare.json").write_text(json.dumps({"candidates": rows}, indent=2))
        return {"removed": method}

    @app.get("/api/models/{model_id}/export.tar.gz")
    def export_model(model_id: str):
        run = run_of(model_id)
        if not run.has("student/meta.json"):
            raise HTTPException(400, "ship a method first")
        folder = root / ".studio" / "exports"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{run.id}.tar.gz"
        # what shrewd keeps when it prunes: enough for load() and for the teacher fallback
        dropped = set(shrewd.prune(run.path, dry_run=True)) | {run.file("studio.json")}
        with tarfile.open(path, "w:gz") as tar:
            for item in sorted(run.path.iterdir()):
                if item not in dropped:
                    tar.add(item, arcname=f"{run.id}/{item.name}")
        return FileResponse(path, media_type="application/gzip", filename=f"{run.id}.tar.gz")

    def export_folder(run, format, precision):
        return root / "exports" / f"{run.id}-{format}{'-half' if precision == 'float16' else ''}"

    @app.get("/api/models/{model_id}/export")
    def export_options(model_id: str):
        run = run_of(model_id)
        if not run.has("student/meta.json"):
            raise HTTPException(400, "ship a method first")
        return {**views.export_options(run), "folder": tilde(root / "exports")}

    @app.post("/api/models/{model_id}/export")
    def export_run(model_id: str, body: dict = Body(...)):
        """shrewd.export() into the workspace's exports folder, replacing an earlier export of
        the same model and format. shrewd checks it against the model before returning."""
        run = run_of(model_id)
        options = views.export_options(run)
        format, precision = body.get("format"), body.get("precision", "float32")
        offered = {f["id"]: f["ready"] for f in options["formats"]}
        if not options["supported"]:
            raise HTTPException(400, "exporting needs shrewd 0.5 or later")
        if format not in offered:
            raise HTTPException(400, f"this model can't be exported as {format}")
        if not offered[format]:
            raise HTTPException(400, "install ONNX export in Settings first")
        if precision not in ("float32", "float16") or (
                precision == "float16" and not (options["half"] and format == "plain")):
            raise HTTPException(400, "half size is for embedding models exported for "
                                     "Python and JavaScript")
        folder = export_folder(run, format, precision)
        try:
            with rows._LOADING:
                report = shrewd.export(run.path, folder, format=format, precision=precision,
                                       overwrite=True)
        except FileExistsError:
            raise HTTPException(400, f"{tilde(folder)} holds other files; move them first") \
                from None
        except RuntimeError as exc:
            shutil.rmtree(folder, ignore_errors=True)
            raise HTTPException(500, f"The export didn't match the model, so it was removed. "
                                     f"{exc}") from None
        mb = sum(f.stat().st_size for f in folder.iterdir() if f.is_file()) / 1e6
        return {**report, "path": tilde(folder), "mb": round(mb, 1)}

    @app.post("/api/models/{model_id}/export/reveal")
    def export_reveal(model_id: str, body: dict = Body(...)):
        run = run_of(model_id)
        folder = export_folder(run, body.get("format"), body.get("precision", "float32"))
        if not folder.is_dir():
            raise HTTPException(404, "export it first")
        _open(folder)
        return {"path": tilde(folder)}

    # -- deleting -------------------------------------------------------------------------

    def parts_of(run):
        """What a model's folder holds, grouped the way the Delete sheet shows it, and what
        archiving it (shrewd.prune) would remove."""
        pruned = set(shrewd.prune(run.path, dry_run=True, keep=_keep(run))) \
            if run.has("student/meta.json") else None
        groups = {}
        for item in run.path.iterdir():
            what = _PART.get(item.name, "pool" if item.name.startswith(("pool_", "votes_"))
                             else "other")
            group = groups.setdefault(what, {"what": what, "mb": 0.0, "removed_mb": 0.0})
            mb = _folder_mb(item) if item.is_dir() else item.stat().st_size / 1e6
            group["mb"] += mb
            if pruned is not None and item in pruned:
                group["removed_mb"] += mb
        order = ["examples", "pool", "cache", "candidates", "checkpoints", "model", "other"]
        out = sorted(groups.values(), key=lambda g: order.index(g["what"]))
        for group in out:
            group["mb"], group["removed_mb"] = round(group["mb"], 3), round(group["removed_mb"], 3)
        return out, pruned

    @app.get("/api/models/{model_id}/delete")
    def delete_info(model_id: str):
        run = run_of(model_id)
        parts, pruned = parts_of(run)
        mine = list(jobs.of(run.id))
        return {"parts": parts, "total_mb": round(sum(p["mb"] for p in parts), 1),
                "can_archive": pruned is not None and not views.archived(run),
                "archived": views.archived(run),
                "running": sum(j.state in ("queued", "running") for j in mine),
                "paused": sum(j.state == "paused" for j in mine)}

    @app.post("/api/models/{model_id}/delete")
    def delete_model(model_id: str, body: dict = Body(default={})):
        """Move the model to the Trash, or with `keep_model` only what using its shipped model
        doesn't need (shrewd.prune). Paused jobs on it are cancelled."""
        run = run_of(model_id)
        guard(run)
        keep = bool(body.get("keep_model"))
        if keep and (not run.has("student/meta.json") or views.archived(run)):
            raise HTTPException(400, "nothing to archive: ship a method first")
        for job in list(jobs.of(run.id, states=("paused",))):
            jobs.cancel(job.id)
        doomed = shrewd.prune(run.path, dry_run=True, keep=_keep(run)) if keep else [run.path]
        try:
            where = _trash(doomed, f"{run.name} (removed files)" if keep else run.name)
        except Exception as exc:
            raise HTTPException(500, f"Couldn't move it to the {system()['trash']} ({exc}). "
                                     "Nothing was removed.") from None
        if keep:
            return {"archived": True, "trash": where}
        jobs.forget(run.id)
        return {"deleted": True, "trash": where}

    @app.post("/api/models/{model_id}/reveal")
    def reveal(model_id: str):
        run = run_of(model_id)
        _open(run.path)
        return {"path": str(run.path)}

    # -- settings ----------------------------------------------------------------------

    def view():
        out = _settings_view(settings, root, sandbox)
        out["storage"].update(workspace_source=workspace_source,
                              models_source="shell" if "HF_HOME" in settings.shell else
                              "settings" if settings["storage"].get("models_dir") else "default",
                              default_workspace=tilde(default_workspace),
                              default_models_dir=tilde(_HF_DEFAULT))
        out["boot"] = boot
        for extra in out["extras"]:        # the latest install of each, for its row in Settings
            tried = [j for j in jobs.jobs.values()
                     if j.kind == "install" and j.params.get("extra") == extra["id"]]
            last = max(tried, key=lambda j: j.started or "", default=None)
            extra["job"] = None if last is None else {
                "id": last.id, "state": last.state, "message": last.message,
                "error": last.error, "log": list(last.log)[-20:]}
        return out

    @app.get("/api/settings")
    def get_settings():
        return view()

    @app.get("/api/teacher-key")
    def teacher_key(model: str = ""):
        """What a teacher name needs before it can be called (the New model form, Settings)."""
        from shrewd_studio.settings import PROVIDERS

        return views.teacher_key(model, {v for _, v in PROVIDERS})

    @app.patch("/api/settings")
    def patch_settings(body: dict = Body(...)):
        try:
            settings.update(body)
        except (ValueError, TypeError) as exc:
            raise bad(exc) from None
        jobs.schedule()
        return view()

    # -- storage: where models are kept, and where Hugging Face downloads go -------------

    def folder_of(body):
        which = body.get("which")
        if which not in ("workspace", "models_dir"):
            raise HTTPException(400, "which is workspace or models_dir")
        raw = (body.get("path") or "").strip()
        if not raw:
            raise HTTPException(400, "choose a folder")
        return which, Path(raw).expanduser().resolve()

    def models_in(folder):
        return sorted(p.parent for p in folder.glob("*/manifest.json")) if folder.is_dir() else []

    def check_folder(which, path):
        """What switching to `path` would mean, and what stops it, if anything."""
        if which == "models_dir":
            current = Path(os.environ.get("HF_HOME") or _HF_DEFAULT).resolve()
            problem = ("That's the folder in use now." if path == current else
                       "That's a file, not a folder." if path.exists() and not path.is_dir() else
                       None if _writable(path) else "Studio can't write to that folder.")
            return {"path": tilde(path), "exists": path.is_dir(), "problem": problem,
                    "mb": round(_folder_mb(path), 1) if path.is_dir() else 0.0}
        here, there = models_in(root), models_in(path)
        active = sum(j.state in ("queued", "running") for j in jobs.jobs.values())
        problem = ("That's the folder in use now." if path == root else
                   "That folder is inside the current workspace." if root in path.parents else
                   "That's a file, not a folder." if path.exists() and not path.is_dir() else
                   None if _writable(path) else "Studio can't write to that folder.")
        return {"path": tilde(path), "exists": path.is_dir(), "problem": problem,
                "here": {"models": len(here), "mb": round(sum(_folder_mb(p) for p in here), 1)},
                "there": len(there),
                "conflicts": sorted({p.name for p in here} & {p.name for p in there}),
                "active": active}

    @app.post("/api/settings/storage/inspect")
    def inspect_storage(body: dict = Body(...)):
        return check_folder(*folder_of(body))

    @app.post("/api/settings/storage/pick")
    def pick_folder(body: dict = Body(...)):
        """The system's folder dialog, where there is one; otherwise the path is typed."""
        start = Path((body.get("path") or "").strip() or Path.home()).expanduser()
        while not start.is_dir() and start != start.parent:
            start = start.parent
        prompt = ("Choose where Studio keeps your models" if body.get("which") == "workspace"
                  else "Choose where downloaded models go")
        command = _folder_dialog(start, prompt)
        if command is None:
            raise HTTPException(501, "type the folder's path")
        done = subprocess.run(command, capture_output=True, text=True, check=False,
                              **NO_WINDOW)
        path = done.stdout.strip() if done.returncode == 0 else ""
        path = path.rstrip("/\\") or path
        return {"path": tilde(path) if path else None}

    @app.post("/api/settings/storage/reveal")
    def reveal_storage(body: dict = Body(...)):
        folder = root if body.get("which") == "workspace" else \
            Path(os.environ.get("HF_HOME") or _HF_DEFAULT)
        while not folder.exists() and folder != folder.parent:
            folder = folder.parent
        _open(folder)
        return {"path": str(folder)}

    @app.post("/api/settings/storage")
    def set_storage(body: dict = Body(...)):
        """Use another folder from the next start, and restart. For the workspace, `move` moves
        the model folders (and Studio's own files) there first; anything else stays."""
        which, path = folder_of(body)
        if which == "workspace" and workspace_source in ("flag", "env"):
            raise HTTPException(409, "the workspace is set by "
                                + ("--workspace" if workspace_source == "flag"
                                   else "SHREWD_STUDIO_WORKSPACE"))
        if which == "models_dir" and "HF_HOME" in settings.shell:
            raise HTTPException(409, "the downloads folder is set by HF_HOME")
        info = check_folder(which, path)
        if info["problem"]:
            raise HTTPException(400, info["problem"])
        if which == "workspace" and body.get("move"):
            if info["active"]:
                raise HTTPException(409, "jobs are running; wait for them, or pause them")
            if info["conflicts"]:
                raise HTTPException(409, "already in that folder: " + ", ".join(info["conflicts"]))
            path.mkdir(parents=True, exist_ok=True)
            moving = models_in(root)
            # Studio's own files: the job list, and the sandbox's true answers
            moving += [root / name for name in (".studio", ".sandbox_truth.json")
                       if (root / name).exists() and not (path / name).exists()]
            moved = []
            try:
                for folder in moving:
                    shutil.move(str(folder), str(path / folder.name))
                    moved.append(folder)
            except OSError as exc:
                for folder in reversed(moved):   # put back what moved, so nothing is split
                    with contextlib.suppress(OSError):
                        shutil.move(str(path / folder.name), str(folder))
                raise HTTPException(500, f"couldn't move {folder.name}: {exc}") from None
        default = default_workspace if which == "workspace" \
            else _HF_DEFAULT.resolve()
        settings.set_storage(which, None if path == default else path)
        if restart:
            threading.Timer(0.3, restart).start()   # after this response is sent
        return {"restart": bool(restart), "boot": boot}

    @app.post("/api/settings/extras/{extra}/install")
    def install_extra(extra: str):
        names = {e: name for e, name, _ in views.EXTRAS}
        if extra not in names:
            raise HTTPException(404, f"no extra {extra!r}")
        if views.installed(extra):
            raise HTTPException(400, f"{names[extra]} is already installed")
        busy = next((j for j in jobs.jobs.values()
                     if j.kind == "install" and j.state in ("queued", "running")), None)
        if busy is not None:
            # two pip runs at once can break each other's packages
            other = names.get(busy.params.get("extra"), "Another extra")
            raise HTTPException(409, f"{other} is still installing. Install {names[extra]} "
                                     "when it's done.")
        return jobs.submit("", "Studio", "install", f"Install {names[extra]}", "CPU",
                           {"extra": extra}).to_dict()

    @app.put("/api/settings/keys")
    def put_key(body: dict = Body(...)):
        try:
            settings.set_key((body.get("variable") or "").strip(), body.get("value") or "")
        except ValueError as exc:
            raise bad(exc) from None
        except Exception as exc:
            where = system()["keystore"]
            why = (f"there's no {where} Studio can use (on Linux, it needs a Secret Service "
                   "keyring such as GNOME Keyring or KWallet). Set the key in your environment "
                   "instead" if "No recommended backend" in str(exc) else str(exc))
            raise HTTPException(500, f"Couldn't store the key in the {where}: {why}.") from None
        return {"keys": settings.keys()}

    @app.delete("/api/settings/keys/{variable}")
    def delete_key(variable: str):
        try:
            settings.delete_key(variable)
        except KeyError:
            raise HTTPException(404, f"{variable} isn't stored by Studio") from None
        return {"keys": settings.keys()}

    # -- the frontend --------------------------------------------------------------------

    if (STATIC / "index.html").exists():
        app.mount("/", StaticFiles(directory=STATIC, html=True), name="web")
    else:
        @app.get("/", response_class=HTMLResponse)
        def missing_frontend():
            return ("<p style='font-family:system-ui;padding:2rem'>The Studio frontend isn't "
                    "built. Run <code>npm install && npm run build</code> in <code>web/</code>."
                    "</p>")

    app.state.jobs = jobs
    app.state.root = root
    app.state.settings = settings
    return app


# ---------------------------------------------------------------- helpers


def _read_upload(file):
    raw = file.file.read()
    try:
        return pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
    except Exception as exc:
        raise HTTPException(400, f"couldn't read that file as CSV: {exc}") from None


def _float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _names(items):
    """Teacher names from ["a", "b"] or [{"name": "a"}, ...]."""
    out = []
    for item in items or []:
        name = item.get("name") if isinstance(item, dict) else item
        if name and str(name).strip():
            out.append(str(name).strip())
    return out


def _labels(items):
    """{name: description} from a dict or [{name, description}]."""
    if isinstance(items, dict):
        return {str(k).strip(): (v or "").strip() for k, v in items.items() if str(k).strip()}
    return {str(i["name"]).strip(): (i.get("description") or "").strip()
            for i in items or [] if str(i.get("name") or "").strip()}


def _question(item, old=None):
    """One question from the app, as a shrewd question object. Editing keeps what the app
    didn't send (a yes/no question's true/false criteria, a hypothesis), so an unchanged
    question stays identical and keeps its cached answers."""
    import dataclasses

    from shrewd.decide import Choice, Noul, Score

    text = (item.get("text") or "").strip() or (old.instructions if old else "")
    if not text:
        raise ValueError(f"question {item.get('id')!r} needs the question itself")
    kind = item.get("type") or {"choice": "choice", "noul": "yes/no", "score": "score"}.get(
        old.kind if old else "")
    options = [str(o).strip() for o in item.get("options") or [] if str(o).strip()]
    if kind == "yes/no":
        return dataclasses.replace(old, instructions=text) if old and old.kind == "noul" \
            else Noul(instructions=text)
    if kind == "score":
        if old and old.kind == "score" and not options:
            return dataclasses.replace(old, instructions=text)
        return Score(instructions=text, criteria=options)
    if kind == "choice":
        given = item.get("descriptions")
        if isinstance(given, list):
            given = dict(zip(options, given, strict=False))
        given = given or {}
        before = dict(old.criteria) if old and old.kind == "choice" else {}
        options = options or list(before)
        return Choice(instructions=text, criteria={
            o: str(given.get(o, before.get(o, ""))).strip() for o in options})
    raise ValueError(f"question {item.get('id')!r} has unknown type {kind!r}")


def _questions(items):
    from shrewd import decide

    if not items:
        raise ValueError("a decision panel needs at least one question")
    out = {}
    for item in items:
        key = slug(item.get("id") or "").replace("-", "_")
        out[key] = _question(item)
    decide.validate(out)
    return out


def _edit_task(run, body):
    """PATCH /task: shrewd's set_teacher, set_labels and set_question, then the labeling
    settings Studio keeps in studio.json and passes to its jobs."""
    lib = run.project()
    instructions = body.get("instructions")
    if instructions is not None and instructions.strip() != (
            run.manifest.get("instructions") or "").strip():
        raise ValueError("shrewd keeps a model's instructions fixed, since every cached "
                         "answer depends on them; make a new model to change them")
    if "teachers" in body:
        teachers = _names(body["teachers"])
        if not teachers:
            raise ValueError("keep at least one teacher")
        if teachers != run.teachers():
            lib.set_teacher(teachers if len(teachers) > 1 else teachers[0])
    if "labels" in body and run.kind == "classifier":
        labels = _labels(body["labels"])
        current = run.manifest["labels"]
        if set(current) - set(labels):
            raise ValueError("use Remove on a label to merge or drop it; labels can't be renamed")
        for name in [k for k in labels if k not in current]:
            lib.add_label(name, labels[name])
        lib.set_labels({k: v for k, v in labels.items() if k in current})
    if "questions" in body and run.kind == "panel":
        stored = run.shrewd_questions()
        sent = {slug(i.get("id") or "").replace("-", "_"): i for i in body["questions"]}
        missing = set(stored) - set(sent)
        if missing:
            raise ValueError(f"shrewd can't remove a question ({', '.join(sorted(missing))}); "
                             "make a new model without it")
        for key, item in sent.items():
            lib.set_question(key, _question(item, stored.get(key)))
    run = Run(run.path)
    several = len(run.teachers()) > 1
    task = dict(run.meta.get("task") or {})
    if "combine" in body and run.kind == "classifier":
        if body["combine"] not in (None, "majority", "weighted"):
            raise ValueError("combine is majority or weighted")
        if body["combine"] == "weighted" and not several:
            raise ValueError("weighting needs several teachers")
        task["combine"] = body["combine"]
    if "votes" in body and run.kind == "classifier":
        if int(body["votes"]) not in (1, 3, 5):
            raise ValueError("votes is 1, 3 or 5")
        task["votes"] = int(body["votes"])
    if "escalate" in body and run.kind == "panel":
        escalate = body["escalate"]
        if escalate is not None:
            if not several:
                raise ValueError("asking the first teacher first needs several teachers")
            budget, delta = float(escalate.get("budget")), float(escalate.get("delta") or 0.05)
            if not 0 < budget < 100 or not 0 < delta < 1:
                raise ValueError("escalate budget is a percentage, delta a probability")
            escalate = {"budget": budget, "delta": delta}
        task["escalate"] = escalate
    if "limit" in body and run.kind == "classifier":
        limit = body["limit"] or {"mode": "all", "value": None}
        if limit.get("mode") not in ("all", "n", "usd"):
            raise ValueError("limit mode is all, n or usd")
        if limit["mode"] != "all":
            if several:
                raise ValueError("labeling under a limit works with one teacher")
            value = float(limit.get("value") or 0)
            if value <= 0:
                raise ValueError("the limit needs a positive value")
            limit = {"mode": limit["mode"], "value": int(value) if limit["mode"] == "n"
                     else value}
        else:
            limit = {"mode": "all", "value": None}
        task["limit"] = limit
    if "concurrency" in body:
        concurrency = int(body["concurrency"])
        if not 1 <= concurrency <= 256:
            raise ValueError("concurrency is between 1 and 256")
        task["concurrency"] = concurrency
    run.save_meta(task=task)


_HF = {}
# Hugging Face's own default when HF_HOME isn't set, on every system
_HF_DEFAULT = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "huggingface"


LOCAL_NAMES = ("127.0.0.1", "localhost", "[::1]")
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def _host_name(host):
    host = host.strip().lower()
    if host.startswith("["):
        return host[:host.find("]") + 1]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _refuse(headers, method):
    """Why a request is refused, or None. The server listens only on this computer, but a web
    page open in any browser here can still send it requests: through a hostname that resolves
    to 127.0.0.1 (DNS rebinding), or as a cross-site form post. So, as Jupyter does, every request
    must name this computer. And anything that changes something must carry the X-Shrewd-Studio
    header, which a page on another site can't send without a CORS preflight this server never
    approves. That holds in every browser and webview, whatever Origin it reports."""
    if _host_name(headers.get("host", "")) not in LOCAL_NAMES:
        return "Shrewd Studio only answers requests addressed to this computer."
    if method.upper() in SAFE_METHODS:
        return None
    origin = headers.get("origin")
    local_origin = origin is None or _host_name(urlsplit(origin).netloc) in LOCAL_NAMES
    if headers.get("x-shrewd-studio") != "1" or not local_origin or \
            headers.get("sec-fetch-site") == "cross-site":
        return "Shrewd Studio only accepts changes from its own window."
    return None


def _open(folder):
    """Show a folder in Finder (or the system's file manager)."""
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(folder)])
    elif sys.platform == "win32":
        os.startfile(folder)  # noqa: S606
    else:
        subprocess.Popen(["xdg-open", str(folder)])


# Studio's own notes, and the teacher check (kept when archiving so the teachers' scores
# still show; it's small)
_KEEP = ("studio.json", "teacher_check.json")


def _keep(run):
    """What archiving keeps beyond what shrewd.prune does. Several teachers are weighted by
    their answers on the tuning examples, so the routing fallback asks them all of those again
    once their cached answers are gone; the cache is small next to what's removed."""
    return _KEEP + (("cache.db",) if len(run.teachers()) > 1 else ())
_PART = {"seed_dev.csv": "examples", "seed_test.csv": "examples", "needs_review.csv": "pool",
         "reviewed.csv": "pool", "label_log.json": "pool", "cache.db": "cache",
         "candidates": "candidates", "compare.json": "candidates", "checkpoints": "checkpoints",
         "student": "model", "report.json": "model", "manifest.json": "model",
         "prompt.txt": "model", "prompt_header.txt": "model", "agreement.json": "model"}


def _folder_dialog(start, prompt):
    """The command that shows the system's choose-a-folder dialog and prints the choice, or
    None where there isn't one (Linux without zenity or kdialog)."""
    if sys.platform == "darwin":
        quoted = str(start).replace("\\", "\\\\").replace('"', '\\"')
        return ["osascript", "-e", f'POSIX path of (choose folder with prompt "{prompt}" '
                f'default location (POSIX file "{quoted}"))']
    if sys.platform == "win32":
        quoted = str(start).replace("'", "''")
        return ["powershell", "-NoProfile", "-STA", "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                f"$d.Description = '{prompt}'; $d.SelectedPath = '{quoted}'; "
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"]
    if shutil.which("zenity"):
        return ["zenity", "--file-selection", "--directory", f"--title={prompt}",
                f"--filename={start}{os.sep}"]
    if shutil.which("kdialog"):
        return ["kdialog", "--getexistingdirectory", str(start), "--title", prompt]
    return None


def system():
    """What this computer calls the things Studio mentions, for the app's wording."""
    if sys.platform == "darwin":
        names = {"os": "mac", "keystore": "Keychain", "files": "Finder", "trash": "Trash"}
    elif sys.platform == "win32":
        names = {"os": "windows", "keystore": "Credential Manager", "files": "File Explorer",
                 "trash": "Recycle Bin"}
    else:
        names = {"os": "linux", "keystore": "system keyring", "files": "file manager",
                 "trash": "Trash"}
    return {**names, "picker": _folder_dialog(Path.home(), "") is not None}


def _trash(paths, name):
    """Move files or folders to the Trash (the Recycle Bin on Windows) as one item called
    `name`, so they can be put back. Returns the name it got there. Nothing is deleted if the
    system has nowhere to put it: that raises OSError and the files stay where they were."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", name).strip(" .") or "Shrewd model"
    if sys.platform == "darwin":
        trash = Path.home() / ".Trash"
        if not trash.is_dir():
            raise OSError("there's no Trash folder in your home folder")
        return _gather(paths, trash, name).name
    # elsewhere the system's own trash, through send2trash: gather everything into one
    # folder beside it (same disk, so it's a rename), then trash that folder
    from send2trash import send2trash

    staging = paths[0].parent / ".shrewd-removing"
    staging.mkdir(exist_ok=True)
    moved = {}
    try:
        target = _gather(paths, staging, name, moved)
        send2trash(str(target))
    except Exception:
        for here, was in reversed(list(moved.items())):     # put everything back
            if was is None:
                with contextlib.suppress(OSError):
                    here.rmdir()
            elif here.exists():
                shutil.move(str(here), str(was))
        raise
    finally:
        with contextlib.suppress(OSError):
            staging.rmdir()
    return target.name


def _gather(paths, into, name, moved=None):
    """Move `paths` into `into` as one item called `name` (numbered if taken): a lone folder
    is renamed, several things go into a new folder. `moved` records new -> old paths."""
    moved = {} if moved is None else moved
    target, n = into / name, 2
    while target.exists():
        target, n = into / f"{name} {n}", n + 1
    if len(paths) == 1 and paths[0].is_dir():
        shutil.move(str(paths[0]), str(target))
        moved[target] = paths[0]
        return target
    target.mkdir()
    moved[target] = None
    for path in paths:
        shutil.move(str(path), str(target / path.name))
        moved[target / path.name] = path
    return target


def _command_line(args):
    """A command to paste into this system's terminal."""
    if sys.platform == "win32":
        return subprocess.list2cmdline(args)
    return " ".join(shlex.quote(a) for a in args)


def _writable(path):
    """Whether a folder, or the nearest folder above it that exists, can be written to."""
    while not path.exists() and path != path.parent:
        path = path.parent
    return path.is_dir() and os.access(path, os.W_OK)


def _folder_mb(path):
    total = 0
    for dirpath, _, files in os.walk(path):
        for name in files:
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(dirpath, name)).st_size
    return round(total / 1e6, 1)


def _detected():
    import importlib.util

    if "device" not in _HF:
        if importlib.util.find_spec("torch") is None:
            return "CPU (torch isn't installed)"      # not kept: it may be installed later
        else:
            import torch

            _HF["device"] = ("CUDA" if torch.cuda.is_available() else
                             "Metal" if torch.backends.mps.is_available() else "CPU")
    return _HF["device"]


def _settings_view(settings, root, sandbox):
    hf = Path(os.environ.get("HF_HOME") or _HF_DEFAULT)
    if "models_mb" not in _HF:
        _HF["models_mb"] = _folder_mb(hf) if hf.exists() else 0.0
    answers = sum(p.stat().st_size for p in root.glob("*/cache.db"))
    import importlib

    importlib.invalidate_caches()      # an extra may have been installed since Studio started
    return {
        "keys": settings.keys(),
        "endpoints": settings["endpoints"],
        "prices": settings["prices"],
        "defaults": settings["defaults"],
        "compute": {**settings["compute"], "detected": _detected()},
        "extras": [{"id": extra, "name": name, "download": size,
                    "installed": views.installed(extra),
                    "install": None if views.installed(extra) else
                    _command_line(views.install_command(extra))}
                   for extra, name, size in views.EXTRAS],
        "storage": {"workspace": tilde(root), "answers_mb": round(answers / 1e6, 1),
                    "models_mb": _HF["models_mb"], "models_dir": tilde(hf)},
        "about": {"studio": __version__, "shrewd": shrewd.__version__,
                  "python": f"{tilde(sys.executable)}, {platform.python_version()}"},
        "sandbox": sandbox,
        "system": system(),
    }
