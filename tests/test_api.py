"""The API end to end in sandbox mode: simulated teachers, real shrewd runs, real workers."""

import io
import json
import os
import time

import pandas as pd
import pytest
from fastapi.testclient import TestClient as _TestClient

from shrewd_studio import rows, samples, sandbox, views
from shrewd_studio.server import create_app
from shrewd_studio.workspace import Run


def TestClient(app, **kwargs):  # noqa: N802
    """The server only answers requests addressed to this computer."""
    headers = {"x-shrewd-studio": "1", **kwargs.pop("headers", {})}
    return _TestClient(app, base_url="http://127.0.0.1", headers=headers, **kwargs)


TICKETS = {"billing": "charges, invoices, refunds", "technical": "something is broken",
           "shipping": "deliveries and parcels", "account": "login, profile, access",
           "other": "anything else"}


@pytest.fixture(scope="session")
def workspace(tmp_path_factory):
    """Small models at the stages the tests need, built in-process with shrewd's API."""
    root = tmp_path_factory.mktemp("runs")
    sandbox.install(root)
    truth = {}

    p, pool, made = samples._classifier(root, "cls", "Tickets", "Route support tickets.",
                                        TICKETS, samples.HAIKU, samples.ticket, (150, 450), 1)
    truth.update(made)
    p.check_teachers()
    p.label(pool)
    p.compare(students=["tfidf"])
    p.distill(student="tfidf", route_budget=0.05)

    d, pool, made = samples._panel(root, "pan", "Moderation", "Forum comments.",
                                   samples._panel_questions("moderation"),
                                   [samples.HAIKU, samples.FABLE], samples.comment, (150, 300), 2)
    truth.update(made)
    d.check_teachers()
    d.judge(pool)

    for slug in ("fresh", "pausable"):
        _, _, made = samples._classifier(root, slug, slug.capitalize(), "Route support tickets.",
                                         TICKETS, [samples.HAIKU, samples.GPT], samples.ticket,
                                         (120, 300), 3)
        truth.update(made)
    (root / ".sandbox_truth.json").write_text(json.dumps(truth))
    return root


@pytest.fixture(scope="session")
def client(workspace):
    with TestClient(create_app(workspace, sandbox=True)) as c:
        yield c


def wait(client, job, states=("done", "failed", "cancelled")):
    for _ in range(1200):
        state = client.get(f"/api/jobs/{job['id']}").json()
        if state["state"] in states:
            return state
        time.sleep(0.1)
    raise AssertionError(f"job {job['title']} never got to {states}")


def finished(client, job):
    state = wait(client, job)
    assert state["state"] == "done", f"{state.get('error')}\n" + "\n".join(state["log"])
    return state


def csv_file(frame):
    buffer = io.BytesIO()
    frame.to_csv(buffer, index=False)
    return {"file": ("data.csv", buffer.getvalue(), "text/csv")}


def test_models_list_and_detail(client):
    models = {m["id"]: m for m in client.get("/api/models").json()}
    assert {"cls", "pan", "fresh"} <= set(models)
    assert models["cls"]["stage"] == "shipped"
    assert models["cls"]["how"] == "One teacher, shipped with teacher backup"
    assert models["pan"]["stage"] == "review" and models["pan"]["review"] > 0
    assert models["fresh"]["stage"] == "examples"

    cls = client.get("/api/models/cls").json()
    assert cls["questions"] == [{"id": "label", "type": "choice", "options": list(TICKETS),
                                 "text": None}]
    assert cls["descriptions"] == TICKETS
    assert cls["teachers"][0]["accuracy"][0] > 50 and cls["teachers"][0]["key_set"]
    assert cls["teachers"][0]["key"] == "ANTHROPIC_API_KEY"     # for the Use drawer's note
    shipped = next(m for m in cls["methods"] if m["shipped"])
    assert shipped["id"] == "tfidf" and shipped["dev"][0] > 0 and shipped["test"][0] > 0
    assert cls["routing"]["curve"][cls["routing"]["selected"]][0] == 5
    assert cls["final_tests"] == 1 and cls["counts"]["labeled"] == cls["counts"]["pool"]

    pan = client.get("/api/models/pan").json()
    assert [q["type"] for q in pan["questions"]] == ["yes/no", "choice", "score"]
    assert pan["questions"][2]["options"] == ["none", "mild", "severe"]
    assert pan["combine"] == "weighted" and len(pan["combined_accuracy"]) == 3
    assert all(len(t["accuracy"]) == 3 for t in pan["teachers"])
    assert pan["methods"] == [] and pan["routing"] is None


def test_rows_with_each_filter(client):
    everything = client.get("/api/models/pan/rows").json()
    assert everything["total"] == everything["matched"] == 450
    sets = [r["set"] for r in everything["rows"]]
    assert sets == sorted(sets, key=["pool", "tuning", "test"].index)
    test_row = next(r for r in client.get("/api/models/pan/rows?set=test").json()["rows"])
    assert {t["state"] for t in test_row["teachers"]} == {"locked"}

    needs = client.get("/api/models/pan/rows?set=pool&filter=needs").json()["rows"]
    assert needs and all(r["needs"] for r in needs)
    assert all(len(r["teachers"][0]["answers"]) == 3 for r in needs)
    split = client.get("/api/models/pan/rows?filter=disagree&q=1").json()["rows"]
    assert split and all(len({t["answers"][1] for t in r["teachers"]}) > 1 for r in split)
    vsyou = client.get("/api/models/pan/rows?filter=vsyou").json()["rows"]
    assert vsyou and all(r["set"] == "tuning" for r in vsyou)
    harmful = needs[0]["teachers"][1]["p"][0]
    assert 0 <= harmful <= 1                       # P(yes) for a yes/no question

    cls = client.get("/api/models/cls/rows?limit=2000").json()["rows"]
    pool = next(r for r in cls if r["set"] == "pool")
    assert pool["methods"]["tfidf"]["state"] == "ok" and pool["teachers"][0]["state"] == "ok"
    test = next(r for r in cls if r["set"] == "test")
    assert test["methods"]["tfidf"]["state"] == "ok"          # shipped: tested once
    assert test["teachers"][0]["state"] == "ok"               # the final test asked them
    local = client.get("/api/models/cls/rows?filter=local").json()
    routed = client.get("/api/models/cls/rows?filter=routed").json()
    assert local["matched"] < local["total"]
    assert routed["rows"] and all(r["methods"]["tfidf"]["routed"] for r in routed["rows"])
    word = pool["text"].split()[1].lower()
    found = client.get(f"/api/models/cls/rows?search={word}").json()
    assert found["matched"] and all(word in r["text"].lower() for r in found["rows"])
    assert client.get("/api/models/cls/rows?filter=nope").status_code == 400


def test_answers_on_pool_and_tuning_rows(client):
    row = client.get("/api/models/pan/rows?set=pool&filter=needs&limit=1").json()["rows"][0]
    before = client.get("/api/models/pan").json()["counts"]["review"]
    saved = client.post("/api/models/pan/answers", json={
        "key": row["key"], "answers": {"harmful": "yes", "category": "spam",
                                       "severity": "mild"}}).json()
    assert saved["you"] == ["yes", "spam", "mild"] and saved["reviewed"]
    assert saved["needs"] is None
    assert client.get("/api/models/pan").json()["counts"]["review"] == before - 1
    added = client.post("/api/models/pan/examples/from-pool", json={"key": row["key"]}).json()
    assert added["set"] in ("tuning", "test")

    tuning = client.get("/api/models/cls/rows?set=tuning&limit=1").json()["rows"][0]
    other = next(o for o in TICKETS if o != tuning["you"][0])
    fixed = client.post("/api/models/cls/answers", json={
        "key": tuning["key"], "answers": {"label": other}}).json()
    assert fixed["you"] == [other]
    bad = client.post("/api/models/cls/answers", json={"key": tuning["key"],
                                                       "answers": {"label": "nope"}})
    assert bad.status_code == 400


def test_task_edits(client):
    task = client.get("/api/models/fresh/task").json()
    assert task["combine"] == "weighted" and task["votes"] == 1  # what the wizard promises
    assert [t["name"] for t in task["teachers"]] == [samples.HAIKU, samples.GPT]
    changed = client.patch("/api/models/fresh/task", json={
        "labels": [{"name": n, "description": d + "!"} for n, d in TICKETS.items()],
        "combine": "weighted", "votes": 3, "concurrency": 4,
        "teachers": [samples.GPT, samples.HAIKU]}).json()
    assert changed["labels"][0]["description"] == TICKETS["billing"] + "!"
    assert changed["combine"] == "weighted" and changed["votes"] == 3
    assert [t["name"] for t in changed["teachers"]] == [samples.GPT, samples.HAIKU]
    client.patch("/api/models/fresh/task", json={"teachers": [samples.HAIKU, samples.GPT],
                                                 "votes": 1, "combine": "majority"})
    assert client.patch("/api/models/fresh/task", json={"limit": {"mode": "n", "value": 50}}
                        ).status_code == 400             # budgets work with one teacher
    assert client.patch("/api/models/fresh/task", json={"instructions": "Other."}
                        ).status_code == 400

    panel = client.get("/api/models/pan/task").json()
    questions = panel["questions"]
    questions[0]["text"] = "Could this comment hurt someone?"
    edited = client.patch("/api/models/pan/task", json={
        "questions": questions, "escalate": {"budget": 5, "delta": 0.05}}).json()
    assert edited["questions"][0]["text"] == "Could this comment hurt someone?"
    assert edited["escalate"] == {"budget": 5.0, "delta": 0.05}
    assert client.patch("/api/models/pan/task", json={"questions": questions[:1]}
                        ).status_code == 400             # shrewd can't remove a question
    client.patch("/api/models/pan/task", json={"escalate": None})


def test_prompt_and_estimate(client):
    prompt = client.get("/api/models/cls/prompt").json()
    assert "billing" in prompt["text"] and prompt["metric"] == "accuracy"
    assert not prompt["optimized"] and prompt["last_run"] is None
    assert client.get("/api/models/pan/prompt").json()["metric"] == "1 − Brier/2"

    check = client.get("/api/models/fresh/estimate?kind=check").json()
    assert [r["teacher"] for r in check["rows"]] == [samples.HAIKU, samples.GPT]
    assert check["rows"][0]["documents"] == check["rows"][0]["calls"] > 0
    assert check["total"] == pytest.approx(sum(r["usd"] for r in check["rows"]), abs=1e-3)
    label = client.get("/api/models/fresh/estimate?kind=label").json()
    assert label["rows"][0]["documents"] == 300


def test_a_label_job(client):
    job = client.post("/api/models/fresh/jobs", json={"kind": "label"}).json()["jobs"][0]
    assert job["uses"] == "API" and job["title"] == "Label 300 documents"
    done = finished(client, job)
    assert done["cost"] > 0 and done["took"] > 0
    model = client.get("/api/models/fresh").json()
    assert model["counts"]["labeled"] == 300 and model["stage"] in ("review", "labeled")
    assert any(j["id"] == job["id"] for j in client.get("/api/jobs").json()["finished"])


@pytest.mark.skipif(not views.installed("embed"), reason='needs "shrewd[embed]"')
def test_compare_two_methods_then_ship(client, workspace):
    started = client.post("/api/models/pan/jobs", json={
        "kind": "compare", "params": {"methods": ["tfidf", "embed"]}}).json()["jobs"]
    assert [j["title"] for j in started] == ["Compare, tf-idf", "Compare, embeddings"]
    for job in started:
        finished(client, job)
    rows = json.loads((workspace / "pan" / "compare.json").read_text())["candidates"]
    assert {r["features"] for r in rows} == {"tfidf", "embed"}
    methods = client.get("/api/models/pan").json()["methods"]
    assert {m["id"] for m in methods} == {"tfidf", "embed"}
    assert all(m["state"] == "done" and len(m["dev"]) == 3 for m in methods)
    row = client.get("/api/models/pan/rows?set=pool&limit=1").json()["rows"][0]
    assert set(row["methods"]) == {"tfidf", "embed"}

    ship = client.post("/api/models/pan/jobs", json={"kind": "ship", "params": {
        "method": "embed", "calibration": "auto", "soft": True,
        "routing": {"budget": 10, "delta": 0.05}}}).json()["jobs"][0]
    assert ship["title"] == "Ship embeddings, final test 1" and ship["uses"] == "CPU"
    finished(client, ship)
    model = client.get("/api/models/pan").json()
    shipped = next(m for m in model["methods"] if m["shipped"])
    assert shipped["id"] == "embed" and len(shipped["test"]) == 3
    assert model["stage"] == "shipped" and model["routing"]["selected"] == 3
    # a first ship with routing asks for a limit once the trade-off is known; picking one
    # (or shipping again) keeps it
    assert model["routing"]["chosen"] is False
    client.post("/api/models/pan/route", json={"budget": 5})
    assert client.get("/api/models/pan").json()["routing"]["chosen"] is True
    # the embeddings method keeps only its head; the model it loads by name is counted apart
    assert all(m.get("base") is None for m in model["methods"])
    report = client.get("/api/models/pan/report").json()
    assert set(report["questions"]) == {"harmful", "category", "severity"}
    assert isinstance(report["findings"], list) and report["final_tests"] == 1
    tried = client.post("/api/models/pan/try", json={"text": "Buy followers now"}).json()
    assert len(tried["methods"]["embed"]["answers"]) == 3


def test_pause_resume_and_cancel(client):
    job = client.post("/api/models/pausable/jobs", json={"kind": "label"}).json()["jobs"][0]
    assert job["state"] == "running"
    paused = client.post(f"/api/jobs/{job['id']}/pause").json()
    assert paused["state"] == "paused"
    assert client.get("/api/models").json()[0] is not None
    assert next(m for m in client.get("/api/models").json() if m["id"] == "pausable")["paused"]
    assert any(j["id"] == job["id"] for j in client.get("/api/jobs").json()["now"])
    assert client.post(f"/api/jobs/{job['id']}/pause").status_code == 409
    resumed = client.post(f"/api/jobs/{job['id']}/resume").json()
    assert resumed["state"] in ("queued", "running")
    finished(client, job)

    again = client.post("/api/models/pausable/jobs", json={"kind": "check"}).json()["jobs"][0]
    assert client.post(f"/api/jobs/{again['id']}/cancel").json()["state"] == "cancelled"
    assert wait(client, again)["state"] == "cancelled"
    assert client.post("/api/jobs/nope/resume").status_code == 404


def test_routing_try_and_ask(client):
    routing = client.post("/api/models/cls/route", json={"budget": 10}).json()
    assert routing["curve"][routing["selected"]][0] == 10
    assert client.get("/api/models/cls").json()["routing"] == routing
    client.post("/api/models/cls/route", json={"budget": 5})
    assert client.post("/api/models/pan/route", json={"budget": 5}).status_code in (200, 400)

    tried = client.post("/api/models/cls/try", json={"text": "I was charged twice"}).json()
    cell = tried["methods"]["tfidf"]
    assert cell["answers"][0] in TICKETS and 0 < cell["p"][0] <= 1
    assert isinstance(cell["routed"], bool)
    asked = client.post("/api/models/cls/ask", json={"text": "My parcel never came"}).json()
    assert asked["teachers"][0]["state"] == "ok"
    assert asked["teachers"][0]["answers"][0] in TICKETS


def test_a_shipped_model_exports_to_run_without_shrewd(client, workspace, monkeypatch):
    import importlib.util

    import shrewd

    options = client.get("/api/models/cls/export").json()
    assert options["supported"] and not options["half"]
    assert [f["id"] for f in options["formats"]] == ["plain"]
    done = client.post("/api/models/cls/export", json={"format": "plain"}).json()
    assert done["checked"] > 0 and done["max_difference"] < 1e-6
    folder = workspace / "exports" / "cls-plain"
    spec = importlib.util.spec_from_file_location("exported", folder / "shrewd_model.py")
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    texts = ["I was charged twice", "my parcel never came", "can't log in"]
    exported = runtime.Model(folder)
    assert exported.predict(texts) == shrewd.load(workspace / "cls").predict(texts)
    assert len(exported.confident(texts)) == 3
    assert "exports" not in {m["id"] for m in client.get("/api/models").json()}
    assert client.post("/api/models/cls/export", json={"format": "onnx"}).status_code == 400
    assert client.post("/api/models/cls/export",
                       json={"format": "plain", "precision": "float16"}).status_code == 400
    assert client.get("/api/models/fresh/export").status_code == 400
    monkeypatch.setattr(views, "can_export", lambda: False)
    assert not client.get("/api/models/cls/export").json()["supported"]
    assert client.post("/api/models/cls/export", json={"format": "plain"}).status_code == 400


def test_teacher_backup_can_be_turned_off_without_retraining(client):
    before = client.get("/api/models/cls").json()
    assert before["routing"] and not before["routing"]["off"]
    off = client.post("/api/models/cls/route", json={"off": True}).json()
    assert off["off"] and off["curve"] == before["routing"]["curve"]
    model = client.get("/api/models/cls").json()
    assert "teacher backup" not in model["how"]
    page = client.get("/api/models/cls/rows", params={"limit": 500}).json()
    shipped = next(x["id"] for x in model["methods"] if x["shipped"])
    assert not any(r["methods"][shipped].get("routed") for r in page["rows"])
    limit = before["routing"]["curve"][before["routing"]["selected"]][0]
    back = client.post("/api/models/cls/route", json={"budget": limit})
    assert not back.json()["off"]
    assert "teacher backup" in client.get("/api/models/cls").json()["how"]


def test_finished_jobs_can_be_cleared_from_the_list(workspace):
    from shrewd_studio.jobs import Job, Jobs

    root = workspace.parent / "clear-test"
    jobs = Jobs(root)
    made = [Job(model="cls", model_name="Tickets", kind=kind, title=kind, uses="CPU")
            for kind in ("check", "label", "compare", "ship")]
    for job, state in zip(made, ("done", "paused", "failed", "cancelled"), strict=True):
        job.state = state
        jobs.jobs[job.id] = job
    jobs._save()
    jobs.clear_finished()
    assert [j["id"] for j in jobs.listing()["now"]] == [made[1].id]
    assert jobs.listing()["finished"] == []
    assert list(Jobs(root).jobs) == [made[1].id]


def test_only_this_computer_and_studios_own_page_are_answered(client):
    from shrewd_studio.server import _refuse

    assert client.get("/api/models").status_code == 200
    for host in ("evil.example", "127.0.0.1.evil.example", "studio.localhost.example:8765"):
        assert client.get("/api/models", headers={"host": host}).status_code == 403
    clear = lambda **headers: client.post("/api/jobs/clear", headers=headers).status_code  # noqa: E731
    assert clear(origin="https://evil.example") == 403
    assert clear(origin="null") == 403
    assert clear(**{"sec-fetch-site": "cross-site"}) == 403
    assert clear(origin="http://127.0.0.1") == 200
    ok = {"host": "127.0.0.1:8765", "x-shrewd-studio": "1"}
    assert _refuse({"host": "127.0.0.1:8765"}, "POST")             # a form post from any page
    assert _refuse({**ok, "host": "evil.example"}, "GET")
    assert _refuse({**ok, "host": "localhost:5173", "origin": "http://localhost:5173"}, "POST") \
        is None                                                        # the dev server's proxy
    assert _refuse({**ok, "host": "[::1]:8765", "origin": "http://[::1]:8765"}, "PATCH") is None
    assert _refuse({**ok, "origin": "http://localhost:8765"}, "POST") is None
    assert _refuse({**ok, "origin": "https://tauri.localhost"}, "POST")
    assert _refuse(ok, "POST") is None                                 # scripts send no Origin
    assert _refuse({"host": "127.0.0.1:8765"}, "GET") is None


def test_using_a_shipped_model(client, tmp_path):
    import tarfile

    import shrewd

    archive = client.get("/api/models/cls/export.tar.gz")
    path = tmp_path / "cls.tar.gz"
    path.write_bytes(archive.content)
    with tarfile.open(path) as tar:
        names = set(tar.getnames())
        tar.extractall(tmp_path, filter="data")
    # enough for load() and the teacher fallback, without the data
    assert {"cls/manifest.json", "cls/student/meta.json", "cls/prompt.txt"} <= names
    assert not names & {"cls/seed_test.csv", "cls/cache.db", "cls/studio.json"}
    assert shrewd.load(tmp_path / "cls").predict(["I was charged twice"])[0] in TICKETS

    texts = pd.DataFrame({"text": ["Where is my parcel?", "I was billed twice", "Hello"]})
    job = client.post("/api/models/cls/label-file", files=csv_file(texts),
                      data={"mode": "local"}).json()
    done = finished(client, job)
    labeled = pd.read_csv(io.StringIO(client.get(done["download"]).text))
    assert {"text", "label", "label_p", "answered"} <= set(labeled.columns)

    assert client.post("/api/models/cls/jobs", json={"kind": "optimize"}).status_code == 400
    assert client.post("/api/models/cls/questions/label/reask").status_code == 404


def test_creating_a_model_from_files(client):
    made = client.post("/api/models", json={
        "kind": "panel", "name": "Job ads", "instructions": "Job postings.",
        "teachers": [samples.HAIKU],
        "questions": [{"id": "remote", "type": "yes/no", "text": "Is it remote?"},
                      {"id": "seniority", "type": "score", "text": "How senior?",
                       "options": ["junior", "mid", "senior"]}]}).json()
    assert made == {"id": "job-ads"}
    data = samples._make(160, 9, samples.posting)
    model = client.post("/api/models/job-ads/examples",
                        files=csv_file(data[["text", "remote", "seniority"]].iloc[:100])).json()
    assert model["counts"]["tuning"] + model["counts"]["test"] == 100
    assert client.post("/api/models/job-ads/pool", files=csv_file(data[["text"]].iloc[100:])
                       ).json()["n"] == 60
    assert client.get("/api/models/job-ads").json()["stage"] == "examples"
    assert client.post("/api/models", json={"kind": "classifier", "name": "x",
                                            "labels": {"a": ""}}).status_code == 400
    bad = client.post("/api/models/job-ads/examples",
                      files={"file": ("x.csv", b"words\nhello\n", "text/csv")})
    assert bad.status_code == 400
    exported = client.get("/api/models/cls/export.csv")
    assert set(pd.read_csv(io.StringIO(exported.text)).columns) >= {"text", "label"}


def test_settings_and_keys(client):
    variable = "STUDIOTEST_API_KEY"
    settings = client.get("/api/settings").json()
    assert {k["variable"] for k in settings["keys"]} >= {"ANTHROPIC_API_KEY", "OPENAI_API_KEY"}
    assert settings["sandbox"] is True and settings["compute"]["cpu_jobs"] == 2
    keys = client.put("/api/settings/keys", json={"variable": variable, "value": "sk-1"}).json()
    assert next(k for k in keys["keys"] if k["variable"] == variable)["source"] == "keychain"
    assert os.environ[variable] == "sk-1"
    import keyring

    assert keyring.get_password("shrewd-studio", variable) == "sk-1"
    stored = json.loads((client.app.state.settings.path).read_text())
    assert stored["keychain"] == [variable] and "sk-1" not in json.dumps(stored)
    assert all(k["variable"] != variable for k in
               client.delete(f"/api/settings/keys/{variable}").json()["keys"])
    assert variable not in os.environ and keyring.get_password("shrewd-studio", variable) is None
    assert client.delete(f"/api/settings/keys/{variable}").status_code == 404
    assert client.put("/api/settings/keys", json={"variable": "bad name", "value": "x"}
                      ).status_code == 400

    patched = client.patch("/api/settings", json={
        "compute": {"cpu_jobs": 3}, "endpoints": {"ollama": "http://localhost:11434"},
        "prices": [{"model": "ollama/qwen3:8b", "input": 0, "output": 0}]}).json()
    assert patched["compute"]["cpu_jobs"] == 3 and os.environ["OLLAMA_API_BASE"]
    assert client.get("/api/jobs").json()["limits"] == {"cpu": 3, "gpu": 1}
    client.patch("/api/settings", json={"compute": {"cpu_jobs": 2},
                                        "endpoints": {"ollama": None}, "prices": []})
    assert "OLLAMA_API_BASE" not in os.environ
    assert client.patch("/api/settings", json={"compute": {"device": "tpu"}}).status_code == 400


def test_labels_and_questions_can_be_removed_or_merged(client, workspace):
    """Merging and removing go through shrewd's merge_labels/remove_label/remove_question/
    merge_options, report what they touch first, and never ask a teacher."""
    p, pool, made = samples._classifier(workspace, "shrink-cls", "Shrink", "Route tickets.",
                                        TICKETS, samples.HAIKU, samples.ticket, (150, 200), 7)
    sandbox.register(made)
    p.label(pool)
    impact = client.get("/api/models/shrink-cls/impact", params={"label": "other"}).json()
    assert set(impact) == {"tuning", "test", "pool"} and sum(impact.values()) > 0
    r = client.post("/api/models/shrink-cls/labels/other/remove", json={"into": "account"})
    assert r.status_code == 200, r.text
    assert [lab["name"] for lab in r.json()["task"]["labels"]] == [
        k for k in TICKETS if k != "other"]
    assert client.get("/api/models/shrink-cls").json()["questions"][0]["options"] == [
        k for k in TICKETS if k != "other"]
    r = client.post("/api/models/shrink-cls/labels/shipping/remove", json={})
    assert r.status_code == 200, r.text
    assert "shipping" not in [x["name"] for x in r.json()["task"]["labels"]]
    assert client.patch("/api/models/shrink-cls/task", json={
        "labels": [{"name": "billing", "description": ""}]}).status_code == 400
    added = client.patch("/api/models/shrink-cls/task", json={"labels": [
        *client.get("/api/models/shrink-cls/task").json()["labels"],
        {"name": "refunds", "description": "money back"}]})
    assert added.status_code == 200 and "refunds" in [x["name"] for x in added.json()["labels"]]

    d, pool, made = samples._panel(workspace, "shrink-pan", "Shrink panel", "Forum comments.",
                                   samples._panel_questions("moderation"), samples.HAIKU,
                                   samples.comment, (150, 200), 8)
    sandbox.register(made)
    d.judge(pool)
    keys = list(d.questions)
    choice = next(k for k, q in d.questions.items() if q.kind == "choice" and len(q.options()) > 2)
    first, second = d.questions[choice].options()[:2]
    impact = client.get("/api/models/shrink-pan/impact",
                        params={"question": choice, "option": first}).json()
    assert set(impact) == {"tuning", "test", "pool"}
    r = client.post(f"/api/models/shrink-pan/questions/{choice}/merge",
                    json={"mapping": {first: second}})
    assert r.status_code == 200, r.text
    detail = client.get("/api/models/shrink-pan").json()
    options = next(q["options"] for q in detail["questions"] if q["id"] == choice)
    assert first not in options
    other = next(k for k in keys if k != choice)
    assert client.post(f"/api/models/shrink-pan/questions/{other}/remove").status_code == 200
    assert other not in [q["id"] for q in client.get("/api/models/shrink-pan").json()["questions"]]
    rows = client.get("/api/models/shrink-pan/rows", params={"limit": 5}).json()
    assert rows["rows"] and len(rows["rows"][0]["you"]) == len(keys) - 1


def test_folders_can_be_moved_or_switched(tmp_path):
    from shrewd_studio.settings import Settings

    def model(folder, name):
        (folder / name).mkdir(parents=True)
        (folder / name / "manifest.json").write_text(json.dumps({"name": name}))
        (folder / name / "seed_dev.csv").write_text("text,label\nhi,a\n")

    here, taken, fresh = tmp_path / "here", tmp_path / "taken", tmp_path / "fresh"
    model(here, "tickets")
    model(here, "reviews")
    model(taken, "reviews")
    (here / "notes.txt").write_text("not a model")
    settings, restarts = Settings(tmp_path / "settings.json"), []
    app = create_app(here, settings=settings, workspace_source="default",
                     default_workspace=here, restart=lambda: restarts.append(True))
    with TestClient(app) as c:
        look = c.post("/api/settings/storage/inspect",
                      json={"which": "workspace", "path": str(taken)}).json()
        assert look["here"]["models"] == 2 and look["there"] == 1
        assert look["conflicts"] == ["reviews"]
        assert c.post("/api/settings/storage", json={"which": "workspace", "path": str(taken),
                                                     "move": True}).status_code == 409
        for path in (here, here / "inside"):
            assert c.post("/api/settings/storage/inspect",
                          json={"which": "workspace", "path": str(path)}).json()["problem"]

        done = c.post("/api/settings/storage", json={"which": "workspace", "path": str(fresh),
                                                     "move": True})
        assert done.status_code == 200 and done.json()["restart"]
        assert sorted(p.name for p in fresh.iterdir()) == [".studio", "reviews", "tickets"]
        assert (here / "notes.txt").exists() and not (here / "tickets").exists()
        assert Settings(tmp_path / "settings.json")["storage"]["workspace"] == str(fresh.resolve())

        # switching without moving leaves both folders as they are
        switched = c.post("/api/settings/storage", json={"which": "workspace", "path": str(taken)})
        assert switched.status_code == 200
        assert (taken / "reviews").exists() and (fresh / "tickets").exists()
        # back to the default is stored as no choice at all
        c.post("/api/settings/storage", json={"which": "models_dir", "path": str(tmp_path / "hf")})
        stored = Settings(tmp_path / "settings.json")["storage"]
        assert stored["models_dir"] == str((tmp_path / "hf").resolve())
        time.sleep(0.5)
        assert len(restarts) == 3

    # a folder given by --workspace can't be changed from Settings
    with TestClient(create_app(here, settings=settings)) as c:
        assert c.get("/api/settings").json()["storage"]["workspace_source"] == "flag"
        assert c.post("/api/settings/storage", json={"which": "workspace",
                                                     "path": str(fresh)}).status_code == 409


def test_a_model_can_be_archived_or_moved_to_the_trash(workspace, tmp_path, monkeypatch):
    import shutil
    import sys

    root = tmp_path / "ws"
    shutil.copytree(workspace / "cls", root / "cls")
    shutil.copytree(workspace / "cls", root / "again")
    (tmp_path / ".Trash").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(sys, "platform", "darwin")
    with TestClient(create_app(root, sandbox=True)) as c:
        info = c.get("/api/models/cls/delete").json()
        assert info["can_archive"] and not info["archived"] and not info["running"]
        assert {p["what"] for p in info["parts"]} >= {"examples", "pool", "cache", "model"}

        done = c.post("/api/models/cls/delete", json={"keep_model": True}).json()
        assert done["archived"] and (tmp_path / ".Trash" / "Tickets (removed files)").is_dir()
        assert not (root / "cls" / "seed_test.csv").exists()
        row = next(m for m in c.get("/api/models").json() if m["id"] == "cls")
        assert row["archived"] and row["stage"] == "shipped"
        tried = c.post("/api/models/cls/try", json={"text": "I was charged twice"})
        assert tried.status_code == 200
        assert c.get("/api/models/cls/delete").json()["can_archive"] is False

        assert c.post("/api/models/again/delete", json={}).json()["deleted"]
        assert not (root / "again").exists()
        assert (tmp_path / ".Trash" / "Tickets" / "manifest.json").exists()
        assert [m["id"] for m in c.get("/api/models").json()] == ["cls"]


@pytest.mark.parametrize("system", ["linux", "win32"])
def test_elsewhere_a_deleted_model_goes_to_the_systems_trash(workspace, tmp_path, monkeypatch,
                                                             system):
    """Windows and Linux: send2trash takes one item named after the model; if it can't,
    nothing is removed."""
    import shutil
    import sys

    import send2trash

    root, bin_ = tmp_path / "ws", tmp_path / "bin"
    bin_.mkdir()
    shutil.copytree(workspace / "cls", root / "cls")
    shutil.copytree(workspace / "cls", root / "again")
    monkeypatch.setattr(sys, "platform", system)
    monkeypatch.setattr(send2trash, "send2trash", lambda p: shutil.move(p, bin_))
    monkeypatch.setattr(views, "install_command", lambda extra: ["pip", "install", extra])
    with TestClient(create_app(root, sandbox=True)) as c:
        assert c.get("/api/settings").json()["system"]["trash"] == \
            ("Recycle Bin" if system == "win32" else "Trash")
        done = c.post("/api/models/cls/delete", json={"keep_model": True}).json()
        assert done == {"archived": True, "trash": "Tickets (removed files)"}
        assert (bin_ / "Tickets (removed files)" / "seed_test.csv").exists()
        assert (root / "cls" / "student").is_dir() and not (root / ".shrewd-removing").exists()

        def refuse(path):
            raise OSError("no trash on this volume")

        monkeypatch.setattr(send2trash, "send2trash", refuse)
        failed = c.post("/api/models/again/delete", json={})
        assert failed.status_code == 500 and "Nothing was removed" in failed.json()["detail"]
        assert (root / "again" / "manifest.json").exists()
        assert not (root / ".shrewd-removing").exists()


def test_teacher_names_say_what_key_they_need(client, monkeypatch):
    """litellm places a bare name with its provider, so gpt-… needs the OpenAI key."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    ask = lambda m: client.get("/api/teacher-key", params={"model": m}).json()  # noqa: E731
    assert ask("gpt-6-luna") == {"provider": "openai", "status": "missing",
                                 "needs": ["OPENAI_API_KEY"]}
    assert ask("gemini/gemini-2.5-flash")["needs"] == ["GEMINI_API_KEY"]
    assert ask("ollama/llama3")["status"] == "local"
    assert ask("not-a-real-model")["status"] == "unknown"
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    assert ask("gpt-6-luna")["status"] == "set"


def test_models_are_kept_in_the_same_folder_however_studio_starts(monkeypatch, tmp_path):
    import argparse

    from shrewd_studio.__main__ import where
    from shrewd_studio.settings import DEFAULT_WORKSPACE, Settings

    monkeypatch.delenv("SHREWD_STUDIO_WORKSPACE", raising=False)
    settings = Settings(path=tmp_path / "settings.json")
    folder, source = where(argparse.Namespace(workspace=None), settings)
    assert (folder, source) == (str(DEFAULT_WORKSPACE), "default")
    assert DEFAULT_WORKSPACE.name == "shrewd-models" and DEFAULT_WORKSPACE.is_absolute()


def test_your_answers_can_be_taken_back(workspace, tmp_path):
    import shutil

    root = tmp_path / "ws"
    for name in ("cls", "pan"):
        shutil.copytree(workspace / name, root / name)
    with TestClient(create_app(root, sandbox=True)) as c:
        # a pool row: the teachers' answer comes back and it stays out of the queue
        row = c.get("/api/models/pan/rows?set=pool&filter=needs&limit=1").json()["rows"][0]
        c.post("/api/models/pan/answers", json={"key": row["key"], "answers": {
            "harmful": "yes", "category": "spam", "severity": "mild"}})
        one = c.post("/api/models/pan/answers/clear",
                     json={"key": row["key"], "question": "harmful"}).json()
        assert one["you"] == [None, "spam", "mild"] and one["reviewed"]
        cleared = c.post("/api/models/pan/answers/clear", json={"key": row["key"]}).json()
        assert cleared["you"] == [None, None, None] and not cleared["reviewed"]
        assert cleared["combined"] == row["combined"]
        again = c.post("/api/models/pan/answers/clear", json={"key": row["key"]})
        assert again.status_code == 400

        # a panel example: one question left unanswered
        tuning = c.get("/api/models/pan/rows?set=tuning&limit=1").json()["rows"][0]
        q = next(qq["id"] for qq, v in zip(c.get("/api/models/pan").json()["questions"],
                                            tuning["you"], strict=True) if v is not None)
        emptied = c.post("/api/models/pan/answers/clear", json={"key": tuning["key"],
                                                                "question": q}).json()
        assert None in emptied["you"]

        # a classifier example always has a label: it can only be removed
        example = c.get("/api/models/cls/rows?set=test&limit=1").json()["rows"][0]
        assert c.post("/api/models/cls/answers/clear",
                      json={"key": example["key"]}).status_code == 400
        before = c.get("/api/models/cls").json()["counts"]
        assert c.post("/api/models/cls/examples/remove",
                      json={"key": example["key"]}).json() == {"tuning": 0, "test": 1}
        assert c.get("/api/models/cls").json()["counts"]["test"] == before["test"] - 1


def test_installing_an_extra_runs_as_a_job(client, monkeypatch):
    from shrewd_studio import views as v

    extras = {e["id"]: e for e in client.get("/api/settings").json()["extras"]}
    assert extras["embed"]["installed"] and extras["embed"]["install"] is None
    assert client.post("/api/settings/extras/embed/install").status_code == 400
    assert client.post("/api/settings/extras/nope/install").status_code == 404
    assert v.pip_trouble(["error: externally-managed-environment"]).startswith("This Python")
    assert v.pip_trouble(["ERROR: Could not install", "boom"]) == "boom"
    command = v.install_command("encoder")
    assert command[-1].startswith("shrewd[encoder]==")

    # one pip at a time, and the refusal says which install to wait for
    from shrewd_studio.jobs import Job

    busy = Job(model="", model_name="Studio", kind="install", title="Install SetFit",
               uses="CPU", params={"extra": "setfit"})
    busy.state = "running"
    jobs = client.app.state.jobs
    jobs.jobs[busy.id] = busy
    monkeypatch.setattr(v, "installed", lambda extra: False)
    try:
        refused = client.post("/api/settings/extras/encoder/install")
        assert refused.status_code == 409
        assert refused.json()["detail"] == ("SetFit is still installing. Install Encoder "
                                            "and zero-shot when it's done.")
    finally:
        del jobs.jobs[busy.id]


def test_a_failed_install_says_why(client, monkeypatch):
    import importlib.util

    if importlib.util.find_spec("pip") is not None or views.installed("setfit"):
        pytest.skip("needs a Python without pip and without setfit")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")          # no uv either, so nothing can install
    job = client.post("/api/settings/extras/setfit/install").json()
    state = wait(client, job)
    assert state["state"] == "failed" and state["error"].startswith("This Python has no pip")
    extra = next(e for e in client.get("/api/settings").json()["extras"] if e["id"] == "setfit")
    assert extra["job"]["state"] == "failed" and extra["job"]["log"]


def test_the_playground_answers_several_documents_with_chosen_methods(client):
    listed = client.get("/api/playground").json()
    cls = next(m for m in listed["models"] if m["id"] == "cls")
    assert cls["methods"][0] == {"id": "tfidf", "name": "tf-idf", "shipped": True,
                                 "original": False}
    assert cls["per_doc"] > 0 and cls["routing"]
    texts = ["I was charged twice", "My parcel never came"]
    out = client.post("/api/models/cls/try", json={"texts": texts, "methods": ["tfidf"]}).json()
    assert list(out["methods"]) == ["tfidf"] and len(out["methods"]["tfidf"]) == 2
    assert out["methods"]["tfidf"][0]["answers"][0] in TICKETS
    assert client.post("/api/models/cls/try", json={"texts": []}).status_code == 400
    one = client.post("/api/models/cls/try", json={"text": texts[0]}).json()   # the old shape
    assert one["methods"]["tfidf"]["answers"][0] in TICKETS

    saved = {"picks": [{"model": "cls", "method": "tfidf"}], "docs": [{"text": texts[0]}]}
    assert client.put("/api/playground", json=saved).json() == {"saved": True}
    assert client.get("/api/playground").json()["saved"] == saved


def test_a_method_that_could_not_load_is_tried_again(workspace, monkeypatch):
    """An extra installed while Studio runs: the table built without that method isn't kept."""
    from shrewd_studio import rows
    from shrewd_studio.workspace import Run

    run = Run(workspace / "cls")
    rows._TABLES.pop(run.path, None)
    real, calls = rows.predict, []

    def not_yet(*args, **kwargs):
        calls.append(1)
        raise ModuleNotFoundError("No module named 'setfit'")

    monkeypatch.setattr(rows, "predict", not_yet)
    with pytest.warns(UserWarning, match="couldn't run"):
        assert all(not r["methods"] for r in rows.table(run))
    monkeypatch.setattr(rows, "predict", real)
    assert all(not r["methods"] for r in rows.table(run))     # within 30 s: kept
    monkeypatch.setattr(rows.time, "monotonic", lambda: 1e12)
    assert all("tfidf" in r["methods"] for r in rows.table(run))


def test_a_majority_vote_shows_its_own_accuracy(client, workspace):
    """A pool labeled by shrewd's default majority vote keeps saying so, and the Combined
    score is that vote's, not the teacher check's weighted one. With two teachers a majority
    vote is the first teacher's answer, since the first breaks ties."""
    p, pool, _ = samples._classifier(workspace, "tie", "Tie", "Route support tickets.",
                                     TICKETS, [samples.HAIKU, samples.GPT], samples.ticket,
                                     (120, 200), 11)
    p.check_teachers()
    p.label(pool)
    model = client.get("/api/models/tie").json()
    assert model["combine"] == "majority" and "majority vote" in model["how"]
    run = Run(workspace / "tie")
    dev = run.seed("tuning")
    teachers = rows.Teachers(run)
    try:
        first = [teachers.cell(samples.HAIKU, t)["answers"][0] for t in dev["text"]]
    finally:
        teachers.close()
    right = sum(a == y for a, y in zip(first, dev["label"], strict=True))
    assert model["combined_accuracy"] == [round(100 * right / len(dev))]
    assert not model["relabel"]

    # switching to weighted says the labels on disk are stale until labeled again, which
    # only recombines cached answers
    client.patch("/api/models/tie/task", json={"combine": "weighted"})
    switched = client.get("/api/models/tie").json()
    assert switched["relabel"] and switched["combined_accuracy"] == model["combined_accuracy"]
    assert client.get("/api/models/tie/estimate?kind=label").json()["total"] == 0
    job = client.post("/api/models/tie/jobs", json={"kind": "label"}).json()["jobs"][0]
    finished(client, job)
    relabeled = client.get("/api/models/tie").json()
    check = json.loads((workspace / "tie" / "teacher_check.json").read_text())
    weighted = check["questions"]["label"]["dev_accuracy"]["combined"]
    assert not relabeled["relabel"] and relabeled["combine"] == "weighted"
    assert relabeled["combined_accuracy"] == [round(100 * weighted)]


def test_quick_answers_are_all_kept(workspace, tmp_path):
    """Answering from the keyboard sends the next save before the last one is done; every
    save lands and every row comes back whole."""
    import shutil
    from concurrent.futures import ThreadPoolExecutor

    root = tmp_path / "ws"
    shutil.copytree(workspace / "pan", root / "pan")
    with TestClient(create_app(root, sandbox=True)) as c:
        before = c.get("/api/models/pan").json()["counts"]["review"]
        queue = c.get("/api/models/pan/rows?set=pool&filter=needs&limit=10").json()["rows"]
        assert len(queue) == min(10, before)
        answer = {"harmful": "no", "category": "none", "severity": "none"}

        def save(row):
            return c.post("/api/models/pan/answers", json={"key": row["key"], "answers": answer})

        with ThreadPoolExecutor(8) as pool:
            saved = list(pool.map(save, queue))
        assert all(r.status_code == 200 for r in saved)
        assert all(r.json()["combined"] and None not in r.json()["combined"] for r in saved)
        assert c.get("/api/models/pan").json()["counts"]["review"] == before - len(queue)
        pool_rows = c.get("/api/models/pan/rows?set=pool&limit=1000").json()["rows"]
        answered = {r["key"] for r in pool_rows if r["you"][0] is not None}
        assert {r["key"] for r in queue} <= answered


def test_models_load_one_at_a_time(workspace, monkeypatch):
    """transformers can't load two models at once, and requests come in on several threads:
    a table asked for twice at once is built once, and loads never overlap."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    run = Run(workspace / "cls")
    rows._TABLES.pop(run.path, None)
    rows._MODELS.clear()
    builds, loading, overlapped = [], [], []
    real_build, real_load = rows._build, rows._load_one

    def build(r):
        builds.append(1)
        return real_build(r)

    def load(*args):
        if loading:
            overlapped.append(1)
        loading.append(threading.get_ident())
        time.sleep(0.05)
        try:
            return real_load(*args)
        finally:
            loading.pop()

    monkeypatch.setattr(rows, "_build", build)
    monkeypatch.setattr(rows, "_load_one", load)
    with ThreadPoolExecutor(6) as pool:
        tables = list(pool.map(lambda _: rows.table(run), range(6)))
    assert len(builds) == 1 and all(t is tables[0] for t in tables)
    rows._MODELS.clear()
    folder, shipped = next(iter(rows.method_folders(run).values()))
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda _: rows._load(run, folder, shipped), range(4)))
    assert not overlapped


def test_archiving_keeps_what_weighting_the_teachers_needs(workspace, tmp_path, monkeypatch):
    """Several teachers are weighted by their answers on the tuning examples. Archiving keeps
    those cached, so the routing fallback afterwards doesn't pay to ask them all again."""
    import sqlite3
    import sys

    root = tmp_path / "ws"
    root.mkdir()
    p, pool, _ = samples._classifier(root, "two", "Two", "Route support tickets.", TICKETS,
                                     [samples.HAIKU, samples.GPT], samples.ticket, (120, 200), 13)
    p.check_teachers()
    p.label(pool, combine="weighted")
    p.compare(students=["tfidf"])
    p.distill(student="tfidf", route_budget=0.05)
    (tmp_path / ".Trash").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(sys, "platform", "darwin")
    with TestClient(create_app(root, sandbox=True)) as c:
        cache = next(g for g in c.get("/api/models/two/delete").json()["parts"]
                     if g["what"] == "cache")
        assert cache["mb"] > 0 and cache["removed_mb"] == 0      # the sheet says "Kept"
        assert c.post("/api/models/two/delete", json={"keep_model": True}).json()["archived"]
    assert (root / "two" / "cache.db").exists() and not (root / "two" / "seed_test.csv").exists()

    def calls():
        with sqlite3.connect(root / "two" / "cache.db") as conn:
            return conn.execute("select count(*) from calls").fetchone()[0]

    before = calls()
    import shrewd

    shrewd.Project(root / "two").ask(["I was charged twice this month"])
    assert calls() == before + 2          # the new document, once per teacher, and nothing else


def test_no_price_is_shown_before_a_check_measures_one(workspace, monkeypatch):
    """shrewd's rough price misses tokenizers and reasoning tokens (real calls ran about twice
    it), so quotes wait for a teacher check to measure what calls really cost."""
    monkeypatch.setattr(views.sandbox, "ACTIVE", False)
    fresh = Run(workspace / "fresh")                    # examples imported, never checked
    assert views.calibration(fresh) is None
    assert all(views.per1k(fresh, t) is None for t in fresh.teachers())
    quote = views.estimate(fresh, "check")
    assert quote["total"] is None and all(r["usd"] is None for r in quote["rows"])
    assert all(r["documents"] == fresh.manifest["splits"]["n_dev"] for r in quote["rows"])

    checked = Run(workspace / "cls")
    paid = [s for s in checked.stages() if s["name"] == "check_teachers" and s.get("cost_usd")]
    if not paid:
        pytest.skip("the sandbox check recorded no cost")
    assert views.calibration(checked) is not None


def test_a_panel_row_says_which_questions_it_is_queued_for(client):
    """Review starts on the question that needs you, not the panel's first one."""
    ids = [q["id"] for q in client.get("/api/models/pan").json()["questions"]]
    queued = client.get("/api/models/pan/rows?set=pool&filter=needs&limit=50").json()["rows"]
    assert queued and all(r["flagged"] for r in queued)
    for r in queued:
        assert set(r["flagged"]) <= set(ids)
        assert r["flagged"] == sorted(r["flagged"], key=ids.index)      # the panel's order
        assert all(q in r["needs"] for q in r["flagged"])
    # how many wait on each question, so review opens on the busiest one
    every = client.get("/api/models/pan/rows?set=pool&filter=needs&limit=1000").json()["rows"]
    counts = client.get("/api/models/pan").json()["queued"]
    assert counts == {q: sum(q in r["flagged"] for r in every)
                      for q in ids if any(q in r["flagged"] for r in every)}
    assert client.get("/api/models/cls").json()["queued"] == {}
    calm = client.get("/api/models/pan/rows?set=tuning&limit=5").json()["rows"]
    assert all(r["flagged"] == [] for r in calm)
    assert all(r["flagged"] == [] for r in client.get("/api/models/cls/rows?set=pool&limit=5"
                                                      ).json()["rows"])


def test_a_check_or_a_ship_already_running_isnt_started_again(client):
    """Two checks at once would pay the teachers twice; two ships would both write the
    shipped model."""
    from shrewd_studio.jobs import Job

    jobs = client.app.state.jobs
    for kind, model, body, refusal in (
            ("check", "fresh", {"kind": "check"}, "the teachers are already being checked"),
            ("ship", "cls", {"kind": "ship", "params": {"method": "tfidf"}},
             "this model is already being shipped")):
        busy = Job(model=model, model_name=model, kind=kind, title=kind, uses="API")
        busy.state = "running"
        jobs.jobs[busy.id] = busy
        try:
            refused = client.post(f"/api/models/{model}/jobs", json=body)
            assert refused.status_code == 409 and refused.json()["detail"] == refusal
        finally:
            del jobs.jobs[busy.id]


def test_data_added_later_walks_through_only_what_it_changed(workspace, tmp_path):
    """A document added to a shipped model is labeled, then the methods are compared again
    and the model shipped again; nothing is stuck on the old stage."""
    import shutil

    root = tmp_path / "ws"
    shutil.copytree(workspace / "cls", root / "cls")
    with TestClient(create_app(root, sandbox=True)) as c:
        model = c.get("/api/models/cls").json()
        assert model["stage"] == "shipped" and model["changes"]["unlabeled"] == 0

        text = "My parcel was left at the wrong address and nobody will tell me where it is"
        assert c.post("/api/models/cls/pool/typed", json={"text": text}).status_code == 200
        again = c.post("/api/models/cls/pool/typed", json={"text": text})
        assert again.status_code == 400 and "already in the pool" in again.json()["detail"]
        model = c.get("/api/models/cls").json()
        assert model["stage"] == "shipped" and model["changes"]["unlabeled"] == 1
        assert c.get("/api/models/cls/estimate?kind=label").json()["rows"][0]["documents"] == 1

        job = c.post("/api/models/cls/jobs", json={"kind": "label"}).json()["jobs"][0]
        assert job["title"] == "Label 1 more document"
        finished(c, job)
        model = c.get("/api/models/cls").json()
        assert model["changes"]["unlabeled"] == 0 and model["changes"]["shipped"]
        assert all(m["stale"] for m in model["methods"])

        finished(c, c.post("/api/models/cls/jobs", json={
            "kind": "compare", "params": {"methods": ["tfidf"]}}).json()["jobs"][0])
        model = c.get("/api/models/cls").json()
        assert not any(m["stale"] for m in model["methods"]) and model["changes"]["shipped"]

        finished(c, c.post("/api/models/cls/jobs", json={
            "kind": "ship", "params": {"method": "tfidf"}}).json()["jobs"][0])
        model = c.get("/api/models/cls").json()
        assert not model["changes"]["shipped"] and model["final_tests"] == 2

        # nothing trains on the locked test set, so adding to it changes nothing upstream;
        # a tuning example does
        from shrewd.project import _hash_unit, _last_test_frac

        manifest = json.loads((root / "cls" / "manifest.json").read_text())
        frac = _last_test_frac(manifest)
        texts = [f"Ticket {k}: the refund for my order never arrived" for k in range(200)]
        side = {t: "test" if _hash_unit(t, manifest["seed"]) < frac else "tuning" for t in texts}
        for wanted, stale in (("test", False), ("tuning", True)):
            text = next(t for t in texts if side[t] == wanted)
            added = c.post("/api/models/cls/examples/typed",
                           json={"text": text, "answers": {"label": "billing"}}).json()
            assert added["set"] == wanted
            model = c.get("/api/models/cls").json()
            assert model["changes"]["shipped"] is stale
            assert all(m["stale"] is stale for m in model["methods"])


def test_the_shipped_methods_compared_version_can_be_tried(client):
    """Shipping retrains on more data; the version from Compare stays, to try next to it,
    but it can't be shipped or removed on its own."""
    methods = client.get("/api/models/cls").json()["methods"]
    original = next(m for m in methods if m["original"])
    assert original["id"] == "compared-tfidf" and original["name"] == "tf-idf, as compared"
    assert original["test"] is None and not original["shipped"]
    tried = client.post("/api/models/cls/try", json={"text": "I was charged twice"}).json()
    assert {"tfidf", "compared-tfidf"} <= set(tried["methods"])
    listed = next(m for m in client.get("/api/playground").json()["models"] if m["id"] == "cls")
    assert [m["id"] for m in listed["methods"]][:2] == ["tfidf", "compared-tfidf"]
    assert listed["methods"][1]["original"]
    assert client.post("/api/models/cls/jobs", json={
        "kind": "ship", "params": {"method": "compared-tfidf"}}).status_code == 400
    assert client.delete("/api/models/cls/methods/compared-tfidf").status_code == 404


def test_a_typed_example_is_split_like_an_import(workspace, tmp_path):
    import shutil

    root = tmp_path / "ws"
    for name in ("cls", "pan"):
        shutil.copytree(workspace / name, root / name)
    with TestClient(create_app(root, sandbox=True)) as c:
        before = c.get("/api/models/cls").json()["counts"]
        text = "Please close my account and delete my login"
        refused = c.post("/api/models/cls/examples/typed", json={"text": text, "answers": {}})
        assert refused.status_code == 400 and "label" in refused.json()["detail"]
        added = c.post("/api/models/cls/examples/typed",
                       json={"text": text, "answers": {"label": "account"}}).json()
        after = c.get("/api/models/cls").json()
        side = {"tuning": "tuning", "test": "test"}[added["set"]]
        assert after["counts"][side] == before[side] + 1
        # the same text always lands on the same side, so it can't be added twice
        assert c.post("/api/models/cls/examples/typed", json={
            "text": text, "answers": {"label": "account"}}).status_code == 400
        # one teacher isn't weighted by the check, so only the trained models are out of date
        assert after["changes"]["shipped"] and not after["changes"]["check"]

        # two teachers weighted by the check: new examples mean checking again, and then
        # recombining the cached answers with the new weights
        assert c.post("/api/models/pan/examples/typed", json={
            "text": "You are all idiots and should leave", "answers": {"harmful": "yes"}
        }).status_code == 200
        changes = c.get("/api/models/pan").json()["changes"]
        assert changes["check"] and not changes["labels"]
        finished(c, c.post("/api/models/pan/jobs", json={"kind": "check"}).json()["jobs"][0])
        changes = c.get("/api/models/pan").json()["changes"]
        assert not changes["check"] and changes["labels"]
        finished(c, c.post("/api/models/pan/jobs", json={"kind": "label"}).json()["jobs"][0])
        changes = c.get("/api/models/pan").json()["changes"]
        assert not changes["check"] and not changes["labels"]


def test_on_windows_workers_take_turns_with_msvcrt(tmp_path, monkeypatch):
    """fcntl is Unix only; Windows locks a byte of the same lock file with msvcrt."""
    import sys
    import types

    from shrewd_studio import worker

    calls = []
    fake = types.SimpleNamespace(LK_LOCK=1, LK_UNLCK=0,
                                 locking=lambda fd, mode, n: calls.append((mode, n)))
    monkeypatch.setitem(sys.modules, "msvcrt", fake)
    monkeypatch.setattr(sys, "platform", "win32")
    run = types.SimpleNamespace(id="m")
    with worker._locked(run, tmp_path):
        calls.append("inside")
    assert calls == [(1, 1), "inside", (0, 1)]
    assert (tmp_path / ".studio" / "locks" / "m.lock").exists()


def test_a_new_prompt_means_checking_and_labeling_again(workspace, tmp_path):
    import shutil

    root = tmp_path / "ws"
    for name in ("cls", "pan"):
        shutil.copytree(workspace / name, root / name)
    with TestClient(create_app(root, sandbox=True)) as c:
        # a classifier labeled before Studio kept prompt fingerprints: shrewd's own record
        assert not c.get("/api/models/cls").json()["changes"]["prompt"]
        test = c.get("/api/models/cls/estimate?kind=test").json()
        assert test["total"] == 0 and all(r["calls"] == 0 for r in test["rows"])
        prompt = root / "cls" / "prompt.txt"
        prompt.write_text(prompt.read_text() + "\nIgnore greetings and sign-offs.")
        changes = c.get("/api/models/cls").json()["changes"]
        assert changes["labels"] and changes["prompt"] and not changes["check"]
        # shipping again with the new prompt has the teachers answer the test set again
        test = c.get("/api/models/cls/estimate?kind=test").json()
        assert test["total"] > 0 and test["rows"][0]["calls"] == test["rows"][0]["documents"]

        # a panel checked and labeled by Studio, then given a new header
        for kind in ("check", "label"):
            finished(c, c.post("/api/models/pan/jobs", json={"kind": kind}).json()["jobs"][0])
        changes = c.get("/api/models/pan").json()["changes"]
        assert not changes["check"] and not changes["labels"] and not changes["prompt"]
        (root / "pan" / "prompt_header.txt").write_text("Read each forum comment carefully.")
        changes = c.get("/api/models/pan").json()["changes"]
        assert changes["check"] and changes["labels"] and changes["prompt"]
        finished(c, c.post("/api/models/pan/jobs", json={"kind": "check"}).json()["jobs"][0])
        changes = c.get("/api/models/pan").json()["changes"]
        assert not changes["check"] and changes["labels"]
        finished(c, c.post("/api/models/pan/jobs", json={"kind": "label"}).json()["jobs"][0])
        changes = c.get("/api/models/pan").json()["changes"]
        assert not changes["check"] and not changes["labels"] and not changes["prompt"]


def test_a_long_prompt_is_priced_as_cached_on_anthropic():
    """shrewd marks the system prompt for caching; Anthropic then bills it at the cached rate
    after the first call. Short prompts and other providers are priced as shrewd does."""
    from shrewd.teacher import estimate_calls

    texts = [f"ticket {i}: my invoice is wrong" for i in range(100)]
    long_prompt, short_prompt = "Route the ticket. " * 300, "Route the ticket."
    claude = "anthropic/claude-haiku-5-5"
    cached = views.rough_price(texts, long_prompt, claude, 1, None)[1]
    assert cached < estimate_calls(texts, long_prompt, claude, 1, None)[1] / 3
    assert views.rough_price(texts, short_prompt, claude, 1, None) == \
        estimate_calls(texts, short_prompt, claude, 1, None)
    assert views.rough_price(texts, long_prompt, "gpt-6-luna", 1, None) == \
        estimate_calls(texts, long_prompt, "gpt-6-luna", 1, None)
