"""Jobs: anything that takes time or money, each run in its own worker process.

The scheduler starts queued jobs in order as slots allow: `cpu_jobs` CPU jobs and `gpu_jobs`
GPU jobs at once (from Settings), and one API job per model. Jobs that write a model's
manifest (checking, labeling, shipping, optimizing) run alone on that model; compare jobs
and labeling a file can run beside each other. Pausing or cancelling ends the process;
resuming queues the job again and a new process picks up from what's on disk. The job list
is kept in <workspace>/.studio/jobs.json, so a job that was running when Studio closed comes
back paused.
"""

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from shrewd_studio import NO_WINDOW, UTF8

ACTIVE = ("queued", "running", "paused")
EXCLUSIVE = {"check", "label", "ship", "optimize", "reask"}
MAX_LOG = 400
KEEP_FINISHED = 100


def now():
    return datetime.now(UTC).isoformat(timespec="seconds")


class Job:
    FIELDS = ("id", "model", "model_name", "kind", "title", "uses", "params", "state",
              "progress", "message", "started", "finished", "ran", "cost", "error", "output")

    def __init__(self, **fields):
        self.id = uuid.uuid4().hex[:10]
        self.state, self.progress, self.message = "queued", None, "Waiting for a free slot"
        self.started = now()
        self.finished = self.cost = self.error = self.output = None
        self.ran = 0.0
        self.params = {}
        for key, value in fields.items():
            setattr(self, key, value)
        self.log = []
        self.proc = None
        self.since = None  # when the current process started, for `took`

    def took(self):
        return round(self.ran + (time.monotonic() - self.since if self.since else 0), 1)

    def to_dict(self, log=False):
        out = {k: getattr(self, k) for k in self.FIELDS if k not in ("params", "ran", "output")}
        out["took"] = self.took()
        if self.output:
            out["download"] = f"/api/jobs/{self.id}/download"
        if log:
            out["log"] = list(self.log)
        return out

    def record(self):
        return {k: getattr(self, k) for k in self.FIELDS}


class Jobs:
    def __init__(self, root, sandbox=False, limits=lambda: (2, 1)):
        self.root = Path(root)
        self.sandbox = sandbox
        self.limits = limits
        self.jobs = {}
        self.lock = threading.RLock()
        self.folder = self.root / ".studio"
        self.folder.mkdir(parents=True, exist_ok=True)
        self._load()
        self.schedule()

    # -- the list ----------------------------------------------------------------------

    def _load(self):
        path = self.folder / "jobs.json"
        if not path.exists():
            return
        for record in json.loads(path.read_text()):
            job = Job(**record)
            if job.state == "running":
                job.state = "paused"
                job.message = "Stopped when Studio closed. Resume to continue."
            self.jobs[job.id] = job

    def _save(self):
        finished = sorted((j for j in self.jobs.values() if j.state not in ACTIVE),
                          key=lambda j: j.finished or "", reverse=True)
        for job in finished[KEEP_FINISHED:]:
            del self.jobs[job.id]
        records = [j.record() for j in self.jobs.values()]
        tmp = self.folder / "jobs.json.tmp"
        tmp.write_text(json.dumps(records, indent=2))
        tmp.replace(self.folder / "jobs.json")

    def submit(self, model, model_name, kind, title, uses, params=None):
        with self.lock:
            job = Job(model=model, model_name=model_name, kind=kind, title=title, uses=uses,
                      params=params or {})
            self.jobs[job.id] = job
            self._save()
        self.schedule()
        return job

    def get(self, job_id):
        return self.jobs.get(job_id)

    def of(self, model, states=ACTIVE, kind=None):
        return [j for j in self.jobs.values() if j.model == model and j.state in states
                and (kind is None or j.kind == kind)]

    def busy(self, model):
        """A worker is running, or about to run, on this model."""
        return any(j.state in ("queued", "running") for j in self.jobs.values()
                   if j.model == model)

    def listing(self):
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: j.started)
            cpu, gpu = self.limits()
            return {"now": [j.to_dict() for j in jobs if j.state in ACTIVE],
                    "finished": [j.to_dict() for j in sorted(
                        (j for j in jobs if j.state not in ACTIVE),
                        key=lambda j: j.finished or "", reverse=True)],
                    "limits": {"cpu": cpu, "gpu": gpu}}

    # -- control -------------------------------------------------------------------------

    def pause(self, job_id):
        with self.lock:
            job = self._need(job_id, ("queued", "running"))
            self._stop(job, "paused", "Paused")
        self.schedule()
        return job

    def resume(self, job_id):
        with self.lock:
            job = self._need(job_id, ("paused", "failed"))
            job.state, job.message, job.error = "queued", "Waiting for a free slot", None
            job.finished = None
            self._save()
        self.schedule()
        return job

    def clear_finished(self):
        """Drop every finished job from the list. Running, waiting and paused ones stay, and
        files finished jobs wrote stay in their model's folder."""
        with self.lock:
            for job_id in [i for i, j in self.jobs.items() if j.state not in ACTIVE]:
                del self.jobs[job_id]
            self._save()

    def forget(self, model):
        """Drop every finished job of a deleted model from the list."""
        with self.lock:
            for job_id in [i for i, j in self.jobs.items() if j.model == model
                           and j.state not in ACTIVE]:
                del self.jobs[job_id]
            self._save()

    def cancel(self, job_id):
        with self.lock:
            job = self._need(job_id, ACTIVE)
            self._stop(job, "cancelled", "Cancelled")
            job.finished = now()
            self._save()
        self.schedule()
        return job

    def _need(self, job_id, states):
        job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.state not in states:
            raise ValueError(f"the job is {job.state}")
        return job

    def _stop(self, job, state, message):
        proc = job.proc
        job.state, job.message = state, message
        if proc is not None and proc.poll() is None:
            proc.terminate()
            threading.Thread(target=_reap, args=(proc,), daemon=True).start()
        self._save()

    def shutdown(self):
        """End every worker (when the server stops); their jobs come back paused."""
        with self.lock:
            for job in self.jobs.values():
                if job.state == "running":
                    self._stop(job, "paused", "Stopped when Studio closed. Resume to continue.")

    # -- scheduling ------------------------------------------------------------------------

    def schedule(self):
        with self.lock:
            cpu, gpu = self.limits()
            running = [j for j in self.jobs.values() if j.state == "running"]
            for job in sorted((j for j in self.jobs.values() if j.state == "queued"),
                              key=lambda j: j.started):
                if self._fits(job, running, cpu, gpu):
                    self._start(job)
                    running.append(job)

    def _fits(self, job, running, cpu, gpu):
        here = [j for j in running if j.model == job.model]
        if here and (job.kind in EXCLUSIVE or any(j.kind in EXCLUSIVE for j in here)):
            return False
        if job.uses == "API":
            return not any(j.uses == "API" for j in here)
        limit = gpu if job.uses == "GPU" else cpu
        return sum(1 for j in running if j.uses == job.uses) < limit

    def _start(self, job):
        spec = {"root": str(self.root), "model": job.model, "kind": job.kind,
                "params": job.params, "sandbox": self.sandbox, "job": job.id}
        env = dict(os.environ, PYTHONUNBUFFERED="1", **UTF8)
        logs = self.folder / "logs"
        logs.mkdir(exist_ok=True)
        stderr = open(logs / f"{job.id}.log", "a", encoding="utf-8")  # noqa: SIM115 (closed by the reader)
        try:
            proc = subprocess.Popen([sys.executable, "-m", "shrewd_studio.worker"],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=stderr, env=env, text=True, encoding="utf-8",
                                    errors="replace", **NO_WINDOW)
        except OSError as exc:
            stderr.close()
            job.state, job.error, job.finished = "failed", str(exc), now()
            self._save()
            return
        proc.stdin.write(json.dumps(spec))
        proc.stdin.close()
        job.proc, job.since = proc, time.monotonic()
        job.state, job.message, job.error = "running", "Starting", None
        self._save()
        threading.Thread(target=self._follow, args=(job, proc, stderr), daemon=True).start()

    def _follow(self, job, proc, stderr):
        result = error = None
        for line in proc.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            with self.lock:
                if job.proc is not proc:
                    continue
                if "progress" in message:
                    job.progress = message["progress"]
                    job.message = message.get("message") or job.message
                elif "log" in message:
                    job.log.append(message["log"])
                    del job.log[:-MAX_LOG]
                elif "done" in message:
                    result = message["done"]
                elif "error" in message:
                    error = message["error"]
        proc.wait()
        stderr.close()
        with self.lock:
            if job.proc is not proc:
                return
            job.ran, job.since, job.proc = job.took(), None, None
            if job.state == "running":
                if result is not None and proc.returncode == 0:
                    job.state, job.progress = "done", 1.0
                    job.message = result.get("message") or "Done"
                    job.output = result.get("output")
                else:
                    job.state = "failed"
                    job.error = error or _tail(self.folder / "logs" / f"{job.id}.log") or \
                        f"the worker stopped (exit code {proc.returncode})"
                job.finished = now()
            if result is not None:
                job.cost = round((job.cost or 0) + (result.get("cost") or 0), 4)
            self._save()
        self.schedule()


def add_record(root, job):
    """Add a job to a workspace's list without starting it (the samples add a paused one)."""
    folder = Path(root) / ".studio"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "jobs.json"
    records = json.loads(path.read_text()) if path.exists() else []
    path.write_text(json.dumps(records + [job.record()], indent=2))


def _reap(proc):
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def _tail(path, lines=3):
    try:
        text = Path(path).read_text().strip().splitlines()
    except FileNotFoundError:
        return None
    return "\n".join(text[-lines:]) or None
