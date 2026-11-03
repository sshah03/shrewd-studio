// Drawers that slide out from the right: Task, Prompt, Compare, Use and Report.
import type { Extra, Method, Model, Task } from "../api";
import { api } from "../api";
import { S, isPanel, shipped, type Pane } from "../state";
import { esc, methodSize, n, SHIPPED_TAG, size } from "../util";
import { paneWrap } from "./details";
import { showIn, system } from "../system";

const loadingPane = (err: string | null, retry: string) => paneWrap(err
  ? `<p class="err" style="margin:0">${esc(err)}</p><div><button class="btn" data-act="${retry}">Try again</button></div>`
  : '<span class="dim">Loading…</span>');

export function drawer(m: Model, still: boolean) {
  const pane = S.pane;
  if (!pane) return "";
  const titles: Record<Pane, string> = { task: "Task", prompt: "Prompt", compare: "Compare methods", use: "Use", report: `Report, ${shipped(m)?.name ?? ""}` };
  const body = { task: taskPane, prompt: promptPane, compare: comparePane, use: usePane, report: reportPane }[pane](m);
  return `<div class="dscrim ${still ? "still" : ""}" data-close="pane"><div class="drawer ${pane === "compare" && isPanel(m) ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(titles[pane])}">
    <div class="dhead"><h2>${esc(titles[pane])}</h2><div class="grow"></div><button class="btn plain" data-act="close-pane">Close</button></div>${body}</div></div>`;
}

/* ---------------- Task ---------------- */
export const editingQ = { i: null as number | null };

function role(m: Model, t: Task, ti: number) {
  if (ti === 0 && t.escalate) return "asked first";
  if (ti === 0 && t.combine === "majority" && !isPanel(m)) return "breaks ties";
  return "";
}

function labelsTable(t: Task, saved: Task) {
  const savedN = saved.labels?.length ?? 0;
  return `<table class="mini"><thead><tr><th>Label</th><th>Description</th><th></th></tr></thead><tbody>
    ${(t.labels ?? []).map((l, i) => `<tr><td>${i >= savedN ? `<input type="text" data-tl-name="${i}" value="${esc(l.name)}" placeholder="name" style="width:110px" aria-label="Label name">` : esc(l.name)}</td>
      <td><input type="text" data-tl-desc="${i}" value="${esc(l.description)}" style="width:100%" aria-label="Description of ${esc(l.name)}"></td>
      <td class="r">${i >= savedN ? `<button class="btn plain" data-act="drop-new-label" data-i="${i}">Remove</button>` : `<button class="btn plain danger" data-act="confirm-remove-label" data-i="${i}" ${savedN <= 2 ? 'disabled title="A classifier needs two labels"' : ""}>Remove…</button>`}</td></tr>`).join("")}
    ${(t.labels ?? []).length ? "" : '<tr><td colspan="3" class="dim">No labels yet.</td></tr>'}
  </tbody></table>`;
}

function questionsTable(t: Task) {
  const qs = t.questions ?? [];
  return `<table class="mini"><thead><tr><th>Id</th><th>Type</th><th>Options</th><th></th></tr></thead><tbody>
    ${qs.map((q, i) => editingQ.i === i
      ? `<tr><td><input type="text" data-tq="${i}" data-f="id" value="${esc(q.id)}" style="width:110px" aria-label="Question id"></td>
          <td><select data-tq="${i}" data-f="type" aria-label="Type">${["choice", "yes/no", "score"].map(x => `<option ${q.type === x ? "selected" : ""}>${x}</option>`).join("")}</select></td>
          <td><input type="text" data-tq="${i}" data-f="options" value="${esc(q.options.join(", "))}" style="width:100%" aria-label="Options, comma separated" ${q.type === "yes/no" ? "disabled" : ""}></td>
          <td class="r"><button class="btn plain" data-act="q-done">Done</button></td></tr>
        <tr><td colspan="4"><input type="text" data-tq="${i}" data-f="text" value="${esc(q.text ?? "")}" placeholder="The question the teachers answer" style="width:100%" aria-label="Question text"></td></tr>`
      : `<tr><td class="mono">${esc(q.id)}</td><td>${esc(q.type)}</td><td class="dim">${esc(q.options.join(", "))}</td><td class="r"><button class="btn plain" data-act="q-edit" data-i="${i}">Edit</button>${q.type === "choice" && q.options.length > 2 ? `<button class="btn plain" data-act="confirm-merge-option" data-q="${esc(q.id)}">Merge…</button>` : ""}<button class="btn plain" data-act="confirm-reask" data-q="${esc(q.id)}">Re-ask…</button>${qs.length > 1 ? `<button class="btn plain danger" data-act="confirm-remove-question" data-q="${esc(q.id)}">Remove…</button>` : ""}</td></tr>`).join("")}
  </tbody></table>`;
}

function labeling(m: Model, t: Task) {
  const ts = t.teachers;
  const panel = isPanel(m);
  const parts: string[] = [];
  if (!panel && ts.length > 1) parts.push(`<label for="cmb">Combine:</label><select id="cmb" data-tf="combine"><option value="majority" ${t.combine === "majority" ? "selected" : ""}>Majority vote</option><option value="weighted" ${t.combine === "weighted" ? "selected" : ""}>Weighted by accuracy on your labels</option></select>`);
  if (panel && ts.length > 1) {
    parts.push(`<label for="ask">Ask:</label><select id="ask" data-tf="ask"><option value="every" ${t.escalate ? "" : "selected"}>Every teacher</option><option value="first" ${t.escalate ? "selected" : ""}>First teacher, others where it may be overruled</option></select>`);
    if (t.escalate) parts.push(`<label>Overruled on at most:</label><span class="inline"><input type="number" data-tf="esc-budget" value="${t.escalate.budget}" aria-label="Escalation budget"> % at <input type="number" data-tf="esc-conf" value="${Math.round((1 - t.escalate.delta) * 100)}" aria-label="Confidence"> % confidence</span>`);
  }
  if (!panel) {
    parts.push(`<label for="votes">Votes per teacher:</label><select id="votes" data-tf="votes">${[1, 3, 5].map(v => `<option ${t.votes === v ? "selected" : ""}>${v}</option>`).join("")}</select>`);
    const multi = ts.length > 1;
    parts.push(`<label for="lim">Label:</label><span class="inline"><select id="lim" data-tf="limit" ${multi ? 'disabled title="Budgeted labeling works with one teacher"' : ""}><option value="all" ${t.limit.mode === "all" ? "selected" : ""}>Every document</option><option value="n" ${t.limit.mode === "n" ? "selected" : ""}>Up to N, most informative first</option><option value="usd" ${t.limit.mode === "usd" ? "selected" : ""}>Up to a dollar amount</option></select>${t.limit.mode !== "all" ? `<input type="number" data-tf="limit-value" value="${t.limit.value ?? ""}" aria-label="${t.limit.mode === "n" ? "N" : "Dollars"}">` : ""}</span>`);
  }
  parts.push(`<label for="par">Parallel requests:</label><input id="par" type="number" data-tf="concurrency" value="${t.concurrency}">`);
  return parts.join("");
}

export const taskFoot = () => `<span class="dim">${S.dirty ? "Unsaved changes" : ""}</span><button class="btn" data-act="discard" ${S.dirty ? "" : "disabled"}>Discard</button><button class="btn default" data-act="savetask" ${S.dirty && !S.busy ? "" : "disabled"}>Save</button>`;

function taskPane(m: Model) {
  if (!S.task) return loadingPane(S.taskErr, "reload-task");
  const t = S.task.draft;
  const panel = isPanel(m);
  return paneWrap(`
    <div class="sec"><h3>Instructions</h3><textarea rows="3" data-tf="instructions" aria-label="Instructions">${esc(t.instructions)}</textarea></div>
    <div class="sec"><h3>${panel ? "Questions" : "Labels"}<div class="grow"></div><button class="btn" data-act="${panel ? "add-question" : "add-label"}">Add</button></h3>
      ${panel ? questionsTable(t) : labelsTable(t, S.task.saved)}</div>
    <div class="sec"><h3>Teachers<div class="grow"></div><button class="btn" data-act="check">Check teachers…</button></h3>
      <table class="mini"><thead><tr><th></th><th>Model</th><th></th><th class="r" title="Measured by the first teacher check">$ per 1k</th><th></th></tr></thead><tbody>
      ${t.teachers.map((x, ti) => `<tr><td><span class="ord"><button data-act="t-up" data-i="${ti}" aria-label="Move ${esc(x.name)} up" ${ti === 0 ? "disabled" : ""}>↑</button><button data-act="t-down" data-i="${ti}" aria-label="Move ${esc(x.name)} down" ${ti === t.teachers.length - 1 ? "disabled" : ""}>↓</button></span></td>
        <td>${esc(x.name)}</td><td class="dim">${role(m, t, ti)}</td><td class="r">${x.per1k ? x.per1k.toFixed(2) : "–"}</td><td class="r"><button class="btn plain danger" data-act="confirm-remove-teacher" data-i="${ti}" ${t.teachers.length < 2 ? 'disabled title="A model needs a teacher"' : ""}>Remove</button></td></tr>`).join("")}
      </tbody></table>
      <div class="inline"><input type="text" id="new-teacher" placeholder="litellm model, e.g. gemini/gemini-3-pro" style="flex:1" aria-label="Add teacher"><button class="btn" data-act="add-teacher">Add</button></div></div>
    <div class="sec"><h3>Labeling</h3><div class="form">${labeling(m, t)}</div></div>
    <div class="sec"><h3>Data</h3><div class="inline"><button class="btn" data-act="examples-file">Add examples…</button><button class="btn" data-act="pool">Add documents…</button><a class="btn" href="${api.exportCsv(m.id)}" download>Export labeled CSV…</a><button class="btn" data-act="reveal">${showIn()}</button></div></div>
    <div class="sec"><div class="inline"><button class="btn danger" data-act="delete-model-open" title="Move it to the ${system().trash}, or keep only what using the shipped model needs">Delete model…</button></div></div>`,
    taskFoot(), "task");
}

/* ---------------- Prompt ---------------- */
const score = (s: number) => (s > 1 ? s / 100 : s).toFixed(2);

export const promptFoot = (budget: number, against: string) => `<span class="dim">Up to ${n(budget)} calls to ${esc(against)}</span><button class="btn default" data-act="optimize" ${S.busy ? "disabled" : ""}>Optimize</button>`;

function promptPane(m: Model) {
  const p = S.prompt;
  if (!p) return loadingPane(S.promptErr, "reload-prompt");
  const panel = isPanel(m);
  const rewriters = [...new Set([p.against, ...m.teachers.map(t => t.short)])];
  const run = p.last_run;
  const seed = run?.candidates[0]?.prompt ?? "";
  const shownI = S.promptView ?? run?.best ?? 0;
  const shownC = run?.candidates[shownI];
  return paneWrap(`
    <div class="sec"><h3>In use<div class="grow"></div><span class="dim" style="font-weight:400">${p.optimized ? "Optimized" : "Written from the task"}</span></h3>
      <pre>${esc(p.text)}</pre></div>
    <div class="sec"><h3>Optimize with GEPA</h3><div class="form">
      <label>Scored on:</label><span>${n(p.scored_on)} tuning examples, ${esc(p.metric)}, against ${esc(p.against)}</span>
      <label for="gb">Budget:</label><span class="inline"><input id="gb" type="number" value="800" data-prompt-budget> teacher calls</span>
      <label for="gt">Stop at:</label><span class="inline"><input id="gt" type="number" step="0.01" placeholder="–"> ${esc(p.metric)}</span>
      <label for="gr">Rewritten by:</label><select id="gr">${rewriters.map(r => `<option>${esc(r)}</option>`).join("")}</select>
      ${panel ? `<label for="gw">Header length:</label><span class="inline">at most <input id="gw" type="number" placeholder="–"> words</span>` : ""}
    </div></div>
    ${run ? `<div class="sec"><h3>Last run</h3>
      <table class="mini"><thead><tr><th>Candidate</th><th class="r">${esc(p.metric)}</th><th></th></tr></thead><tbody>
      ${run.candidates.map((c, i) => `<tr class="${i === run.best ? "best" : ""}"><td>${i === 0 ? "Seed" : `Candidate ${i}`}</td><td class="r">${score(c.score)}</td><td class="r">${i === run.in_use ? '<span class="dim">in use</span>' : `<button class="btn plain" data-act="view-cand" data-i="${i}" aria-pressed="${S.promptView === i}">View</button><button class="btn plain" data-act="confirm-prompt" data-i="${i}">Use…</button>`}</td></tr>`).join("")}
      </tbody></table>
      <div class="pair"><div><h3>Seed</h3><pre>${esc(seed)}</pre></div><div><h3>${shownI === run.best ? "Best" : shownI === 0 ? "Seed" : `Candidate ${shownI}`}</h3><pre>${esc(shownC?.prompt ?? "")}</pre></div></div></div>` : ""}`,
    promptFoot(800, p.against), "prompt");
}

/* ---------------- Compare ---------------- */
type Opt = [id: string, name: string, hw: "CPU" | "GPU", time: string];
const OPTS: Record<Model["kind"], Opt[]> = {
  // measured on an M-series Mac with about 600 labeled documents; SetFit's steps are capped, so
  // it stays near 5 minutes, while the encoder grows with the pool
  panel: [["tfidf", "tf-idf", "CPU", "seconds"], ["embed", "embeddings", "CPU", "seconds"], ["encoder", "encoder", "GPU", "a few minutes, more with a bigger pool"]],
  classifier: [["tfidf", "tf-idf", "CPU", "seconds"], ["embed", "embeddings", "CPU", "seconds"], ["setfit", "SetFit", "GPU", "about 5 minutes"], ["encoder", "encoder", "GPU", "a few minutes, more with a bigger pool"]],
};
/** The extra a method needs, when it isn't installed (from Settings' extras). */
export function missing(id: string): Extra | null {
  const e = (S.settings?.extras ?? []).find(x => x.id === id);
  return e && !e.installed ? e : null;
}

export function installNote(e: Extra) {
  const job = e.job ? S.jobs?.now.find(j => j.id === e.job!.id) : undefined;
  if (job) return esc(job.message || "Installing…");
  return `Not installed <button class="btn plain" data-act="install" data-extra="${esc(e.id)}" title="Installs into the Python Studio runs on. Downloads ${esc(e.download)}.">Install…</button>`;
}

function comparePane(m: Model) {
  if (["examples", "checked", "labeling"].includes(m.stage)) return paneWrap('<p style="margin:0">Methods train on the labeled pool, so compare them once the teachers have labeled it.</p>');
  const opts = OPTS[m.kind];
  const have = Object.fromEntries(m.methods.map(x => [x.id, x.state]));
  const stale = new Set(m.methods.filter(x => x.stale && !x.original).map(x => x.id));
  // each method is ticked when it first becomes available, including after installing it from
  // here, and again when the data changed since it was compared; a tick you changed stays
  const pick = (S.comparePick ??= {});
  for (const [id] of opts) if (!(id in pick) && (!have[id] || stale.has(id)) && !missing(id)) pick[id] = true;
  const chosen = opts.filter(o => pick[o[0]] && !missing(o[0]));
  const cpu = chosen.filter(o => o[2] === "CPU").map(o => o[1]), gpu = chosen.filter(o => o[2] === "GPU").map(o => o[1]);
  const state = (id: string) => stale.has(id) && have[id] === "done"
    ? '<span title="The examples, labels or your answers changed since">compared before the changes</span>'
    : ({ done: "compared", running: "training", queued: "waiting", paused: "paused" } as Record<string, string>)[have[id]];
  const compared = m.methods.filter(x => x.state === "done" && !x.original);
  const qs = m.questions;
  const panel = isPanel(m);
  const score = (x: Method, j: number) => `${x.dev?.[j] != null ? `${x.dev[j]}%` : "–"}${x.test?.[j] != null ? `<small>test ${x.test[j]}%</small>` : ""}`;
  const heads = panel ? qs.map(q => `<th class="r" title="On your tuning examples; test after shipping">${esc(q.id)}</th>`).join("")
    : '<th class="r" title="On your tuning examples">Tuning</th><th class="r">Test</th>';
  const cells = (x: Method) => panel ? qs.map((_, j) => `<td class="r">${score(x, j)}</td>`).join("")
    : `<td class="r">${x.dev?.[0] != null ? `${x.dev[0]}%` : "–"}</td><td class="r">${x.test?.[0] != null ? `${x.test[0]}%` : "–"}</td>`;
  const table = compared.length ? `<div class="sec"><h3>Compared</h3>
      <table class="mini cmp"><thead><tr><th>Method</th>${heads}<th class="r" title="Time to answer one document, and the model's size on disk">Speed, size</th><th></th></tr></thead><tbody>
      ${compared.map(x => `<tr><td>${esc(x.name)}${x.shipped ? SHIPPED_TAG : ""}</td>${cells(x)}
        <td class="r">${x.ms != null ? `${x.ms} ms` : "–"}<small ${methodSize(x)?.why ? `title="${esc(methodSize(x)!.why)}"` : ""}>${methodSize(x)?.text ?? ""}</small></td>
        <td class="r"><button class="btn plain" data-act="ship-method" data-method="${esc(x.id)}">${x.shipped ? "Ship again…" : "Ship…"}</button>${x.shipped ? "" : `<button class="btn plain danger" data-act="remove-method-row" data-method="${esc(x.id)}" aria-label="Remove ${esc(x.name)}">Remove</button>`}</td></tr>`).join("")}
      </tbody></table></div>` : "";
  return paneWrap(`${table}
    <div class="sec"><h3>${compared.length ? "Compare more" : "Methods"}</h3>${opts.map(([id, name, hw, time]) => { const miss = missing(id); return `<label class="mrow"><input type="checkbox" data-cp="${id}" ${pick[id] && !miss ? "checked" : ""} ${miss ? "disabled" : ""}>
        <span>${name}</span><span class="dim">${miss ? installNote(miss) : have[id] ? state(id) : `${hw}, ${time}`}</span></label>`; }).join("")}</div>
    ${order(cpu, gpu)}`,
    `<span class="dim">Scored on tuning examples, no API calls</span><button class="btn default" data-act="startcompare" ${chosen.length && !S.busy ? "" : "disabled"}>Compare ${chosen.length}</button>`, "compare");
}

/* ---------------- Use ---------------- */
/** The fallback calls the teachers from your own code, which can't read the keys Studio keeps. */
function fallbackKeys(m: Model) {
  const stored = new Set((S.settings?.keys ?? []).filter(k => k.source === "keychain").map(k => k.variable));
  const vars = [...new Set(m.teachers.map(t => t.key).filter((v): v is string => !!v && stored.has(v)))];
  if (!vars.length) return "";
  const list = vars.map(v => `<code>${esc(v)}</code>`).join(vars.length === 2 ? " and " : ", ");
  return `<p class="dim" style="margin:6px 0 0">The fallback asks the teachers, so it needs ${list} set where it runs. Studio keeps ${vars.length === 1 ? "that key" : "those keys"} in the ${esc(system().keystore)}, which this code doesn't read.</p>`;
}

const and = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** How the picked methods will run, as one sentence. */
function order(cpu: string[], gpu: string[]) {
  if (!cpu.length && !gpu.length) return "";
  const hw = S.settings?.compute.detected;
  const on = hw && hw !== "–" ? ` on ${hw === "CPU" ? "the CPU" : esc(hw)}` : "";
  const parts = [];
  if (cpu.length) parts.push(cpu.length > 1 ? `${and(cpu)} run together on the CPU` : `${cpu[0]} runs on the CPU`);
  if (gpu.length) parts.push(`${cpu.length ? "then " : ""}${and(gpu)} ${gpu.length > 1 ? "run one at a time" : "runs"}${on}`);
  return `<div class="sec"><h3>Order</h3><p style="margin:0">${parts.join(", ")}.</p></div>`;
}

function usePane(m: Model) {
  const x = shipped(m);
  if (!x) return paneWrap('<p style="margin:0">Ship a method first. Ship retrains it on everything labeled and runs the final test.</p>');
  const rt = m.routing;
  const dir = JSON.stringify(m.path ?? `runs/${m.id}`);   // a Python string literal, quotes and all
  const plain = isPanel(m)
    ? `from shrewd import load\n\npanel = load(${dir})\npanel.decide(texts)`
    : `from shrewd import load\n\nclf = load(${dir})\nclf.predict(texts)`;
  const backed = isPanel(m)
    ? `from shrewd import Decisions, load\n\npanel = load(${dir})\npanel.decide(texts, route=True,\n             fallback=Decisions(${dir}).ask)`
    : `from shrewd import Project, load\n\nclf = load(${dir})\nclf.predict(texts, route=True,\n            fallback=Project(${dir}).ask)`;
  const serve = isPanel(m)
    ? `from fastapi import FastAPI\nfrom pydantic import BaseModel\nfrom shrewd import load\n\npanel = load(${dir})\napp = FastAPI()\n\nclass Texts(BaseModel):\n    texts: list[str]\n\n@app.post("/decide")\ndef decide(body: Texts):\n    return [{k: a.payload for k, a in row.items()}\n            for row in panel.decide(body.texts)]`
    : `from fastapi import FastAPI\nfrom pydantic import BaseModel\nfrom shrewd import load\n\nclf = load(${dir})\napp = FastAPI()\n\nclass Texts(BaseModel):\n    texts: list[str]\n\n@app.post("/classify")\ndef classify(body: Texts):\n    return {"labels": clf.predict(body.texts)}`;
  const limit = rt ? rt.curve[rt.selected] : null;
  const backup = rt?.off
    ? '<p class="dim" style="margin:0" title="Ship again with teacher backup off to train on the whole pool.">Off: the model answers everything locally. Pick a limit above the table to turn it back on.</p>'
    : rt
    ? `<div class="inline" style="margin-bottom:8px"><span>${rt.chosen === false ? '<span class="needs">Limit not chosen yet</span>' : `At most ${limit?.[0] ?? "–"}% disagree with the teachers`}, ${limit?.[1] ?? "–"}% answered locally</span><button class="btn ${rt.chosen === false ? "default" : "plain"}" data-act="routing-open">${rt.chosen === false ? "Choose limit…" : "Change limit…"}</button></div>
      <pre>${esc(backed)}</pre>${isPanel(m) ? "" : '<p class="dim" style="margin:0">Needs shrewd 0.4 or later.</p>'}${fallbackKeys(m)}
      <div class="inline" style="margin-top:8px"><span class="dim">Label a CSV this way:</span><button class="btn" data-act="label-file" data-mode="teachers">Choose CSV…</button></div>`
    : '<p class="dim" style="margin:0">Off. With it on, the model run through shrewd sends documents it\'s unsure of to the teachers, within a limit on how often it may disagree with them. Ship again with teacher backup on to use it.</p>';
  return paneWrap(`
    <div class="sec"><p style="margin:0"><span class="dim">Shipped:</span> ${esc(x.name)}${x.test ? `, test ${x.test.map(v => v + "%").join(" ")}` : ""}</p></div>
    <div class="sec"><h3>The model on its own</h3><pre>${esc(plain)}</pre><p class="dim" style="margin:0">Answers everything locally, with no API calls. Needs only <code>pip install shrewd</code>, without the LLM libraries.</p>
      <div class="inline" style="margin-top:8px"><span class="dim">Label a CSV with it:</span><button class="btn" data-act="label-file" data-mode="local">Choose CSV…</button></div>
      <div class="inline" style="margin-top:8px"><span class="dim">Without shrewd:</span><button class="btn" data-act="export-open" title="A folder that runs without shrewd: Python with numpy, JavaScript, ONNX or Hugging Face, depending on the method">Export…</button></div>
      <details style="margin-top:8px"><summary class="dim">Serving it</summary><pre>${esc(serve)}</pre><p class="dim" style="margin:0" title="One call with many texts is much faster than many calls with one">Load it once when the service starts and pass texts in batches. Run it with <code>uvicorn serve:app</code>.</p></details></div>
    <div class="sec"><h3>With teacher backup, through shrewd</h3>${backup}</div>
    <div class="sec"><h3>Files</h3><div class="inline"><button class="btn" data-act="reveal">${showIn()}</button><a class="btn" href="${api.exportTar(m.id)}" download title="load() also reads a .tar.gz from a URL">Save as .tar.gz…</a></div>${x.base ? `<p class="dim" style="margin:0">It loads ${esc(x.base.name.split("/").pop())} from Hugging Face the first time it runs on a computer${x.base.mb != null ? ` (${size(x.base.mb)})` : ""}; the folder holds only the rest.</p>` : ""}</div>`, "", "use");
}

/* ---------------- Report ---------------- */
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const f3 = (v: unknown) => { const x = num(v); return x == null ? "–" : (Math.abs(x) < 0.0005 ? 0 : x).toFixed(3); };
const pc = (v: unknown) => { const x = num(v); return x == null ? "–" : `${Math.round(x <= 1 ? x * 100 : x)}%`; };
const ci = (v: unknown) => Array.isArray(v) && v.length === 2 ? `${f3(v[0])} to ${f3(v[1])}` : "–";

function findings(list: unknown) {
  if (!Array.isArray(list)) return "";
  if (!list.length) return '<div class="sec"><h3>Findings</h3><p style="margin:0" class="dim">None. Nothing looks off.</p></div>';
  return `<div class="sec findings"><h3>Findings</h3>${list.map(f => {
    const o = obj(f);
    if (!o) return `<p>${esc(f)}</p>`;
    const sev = String(o.severity ?? "info");
    return `<p>${sev !== "info" ? `<span class="${sev === "fail" ? "fail" : "warn"}">${sev === "fail" ? "Problem" : "Check"}:</span> ` : ""}${esc(o.title ?? "")}${o.detail ? ` ${esc(o.detail)}` : ""}${o.suggestion ? ` <span class="dim">${esc(o.suggestion)}</span>` : ""}</p>`;
  }).join("")}</div>`;
}

function routingLine(r: unknown, budget: number | null) {
  const t = obj(obj(r)?.test);
  if (!t) return "";
  const err = num(t.student_error);
  return `<table class="mini"><tbody><tr><td>Teacher backup on the test set</td><td class="r">${pc(t.coverage)} local${err != null ? `, ${(err * 100).toFixed(1)}% disagree` : ""}${budget != null ? ` (limit ${budget}%)` : ""}</td></tr></tbody></table>`;
}

function classifierReport(m: Model, rep: Obj, met: Obj) {
  const x = shipped(m);
  const s = obj(met.student) ?? {}, t = obj(met.teacher) ?? {};
  const gap = num(s.macro_f1) != null && num(t.macro_f1) != null ? num(s.macro_f1)! - num(t.macro_f1)! : null;
  const sel = Array.isArray(s.selective) ? (s.selective as Obj[]) : Array.isArray(met.student_selective) ? met.student_selective as Obj[] : [];
  const gapCi = met.gap_ci ?? met.teacher_minus_student_ci;
  return `<div class="where">${esc(x?.name ?? "")}, final test ${m.final_tests}, ${n(m.counts.test)} locked examples</div>
    <table class="mini"><thead><tr><th></th><th class="r">Macro-F1</th><th class="r">95% interval</th></tr></thead><tbody>
      <tr><td>${esc(x?.name ?? "Local")}</td><td class="r">${f3(s.macro_f1)}</td><td class="r">${ci(s.macro_f1_ci)}</td></tr>
      <tr><td>Teacher${m.teachers.length > 1 ? "s combined" : ""}</td><td class="r">${f3(t.macro_f1)}</td><td class="r">${ci(t.macro_f1_ci)}</td></tr>
      <tr><td>Gap</td><td class="r">${gap == null ? "–" : (gap >= 0 ? "+" : "") + gap.toFixed(3)}</td><td class="r">${Array.isArray(gapCi) ? `${f3(-(gapCi[1] as number))} to ${f3(-(gapCi[0] as number))}` : "–"}</td></tr></tbody></table>
    ${sel.length ? `<table class="mini"><thead><tr><th>Share answered</th>${sel.map(r => `<th class="r">${pc(r.coverage)}</th>`).join("")}</tr></thead><tbody><tr><td>Accuracy</td>${sel.map(r => `<td class="r">${pc(r.accuracy)}</td>`).join("")}</tr></tbody></table>` : ""}
    ${routingLine(met.routing ?? rep.routing, m.routing?.curve[m.routing.selected]?.[0] ?? null)}
    ${findings(rep.findings)}`;
}

function panelReport(m: Model, rep: Obj, met: Obj) {
  const x = shipped(m);
  const qs = obj(met.questions) ?? {};
  const keys = m.questions.map(q => q.id).filter(k => qs[k]);
  const q = (k: string) => obj(qs[k]) ?? {};
  const also = (k: string) => {
    const s = obj(q(k).student) ?? {};
    if (num(s.auroc) != null) return `AUROC ${num(s.auroc)!.toFixed(2)}`;
    if (num(s.mae) != null) return `MAE ${num(s.mae)!.toFixed(2)}, exact ${pc(s.exact)}, adjacent ${pc(s.adjacent)}`;
    return "–";
  };
  const teachers = obj(met.teachers);
  const before = num(met.uncalibrated), after = num(met.calibrated);
  const stack = obj(met.stacking);
  const kept = stack ? Object.entries(stack).filter(([, v]) => obj(v)?.kept).map(([k]) => k) : [];
  return `<div class="where">${esc(x?.name ?? "")}, final test ${m.final_tests}, ${n(m.counts.test)} locked examples</div>
    <table class="mini"><thead><tr><th>Question</th><th class="r">Local</th><th class="r">Teacher${m.teachers.length > 1 ? "s" : ""}</th><th class="r">Brier</th><th class="r">ECE</th></tr></thead><tbody>
    ${keys.map(k => { const s = obj(q(k).student) ?? {}, t = obj(q(k).teacher) ?? {}; return `<tr><td>${esc(k)}</td><td class="r">${pc(s.accuracy)}</td><td class="r">${pc(t.accuracy)}</td><td class="r">${f3(s.brier)}</td><td class="r">${f3(s.ece)}</td></tr>`; }).join("")}
    </tbody></table>
    ${before != null && after != null ? `<table class="mini"><tbody><tr><td>Mean ECE before, after calibration</td><td class="r">${before.toFixed(3)}, ${after.toFixed(3)}</td></tr></tbody></table>` : ""}
    <table class="mini"><thead><tr><th>Question</th><th class="r">Also</th></tr></thead><tbody>${keys.map(k => `<tr><td>${esc(k)}</td><td class="r">${also(k)}</td></tr>`).join("")}</tbody></table>
    ${teachers && m.teachers.length > 1 ? `<table class="mini"><thead><tr><th>Each teacher alone</th>${keys.map(k => `<th class="r">${esc(k.slice(0, 8))}</th>`).join("")}</tr></thead><tbody>
      ${Object.entries(teachers).map(([name, v]) => `<tr><td>${esc(m.teachers.find(t => t.name === name)?.short ?? name)}</td>${keys.map(k => `<td class="r">${pc(obj(obj(v)?.[k])?.accuracy)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
    ${routingLine(met.routing, m.routing?.curve[m.routing.selected]?.[0] ?? null)}
    ${kept.length ? `<table class="mini"><tbody><tr><td>Zero-shot stack</td><td class="r">kept for ${esc(kept.join(", "))}</td></tr></tbody></table>` : ""}
    ${findings(rep.findings)}`;
}

function reportPane(m: Model) {
  if (!S.report) return loadingPane(S.reportErr, "reload-report");
  const rep = S.report;
  const met = obj(rep.metrics) ?? rep;
  return paneWrap(isPanel(m) ? panelReport(m, rep, met) : classifierReport(m, rep, met), "", "report");
}

