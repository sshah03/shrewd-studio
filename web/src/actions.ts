// What each data-act button does. Handlers read and change S, call the API, then redraw.
import { youVal, needsYou } from "./answers";
import { api, type Folder, type Model, type Row, type Settings, type ShipParams, type Task } from "./api";
import { answerPlayground, loadModel, loadModels, loadMore, loadPrompt, loadReport, loadRows, loadSettings, loadTask, savePlayground } from "./data";
import { pollJobs, trackJobs } from "./jobs";
import { render, renderDetails, renderLayer, renderRow, renderSelection } from "./render";
import { navigate } from "./router";
import { S, compared, currentRow, isPanel, shipped, shownRows, type CsvPick, type GuideTab, type Pane, type Sheet } from "./state";
import { message, n, toast } from "./util";
import { guessColumn, readCsv } from "./csv";
import { exampleTargets, freshWizard, wizardProblem, type Wizard } from "./views/newmodel";
import { editingQ, promptFoot, taskFoot, missing } from "./views/drawers";
import { system } from "./system";

type Handler = (el: HTMLElement) => void | Promise<void>;
const ACTS: Record<string, Handler> = {};
const act = (name: string, fn: Handler) => { ACTS[name] = fn; };

export async function runAct(name: string, el: HTMLElement) {
  const fn = ACTS[name];
  if (!fn) return;
  try {
    await fn(el);
  } catch (e) {
    S.busy = false;
    toast(message(e));
    render();
  }
}

const model = () => S.model!;
const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
const checked = (id: string) => !!(document.getElementById(id) as HTMLInputElement | null)?.checked;
const numOr = (s: string, d: number | null) => (s.trim() === "" || Number.isNaN(+s) ? d : +s);

/** Run an API call with buttons disabled; on success close the sheet unless told not to. */
async function busy<T>(fn: () => Promise<T>): Promise<T> {
  S.busy = true;
  renderLayer();
  try { return await fn(); } finally { S.busy = false; }
}

/* ---------------- drawers and sheets ---------------- */
export function openPane(p: Pane) {
  S.pane = p;
  S.menu = null;
  if (p === "task") { if (!S.task) void loadTask(); }
  else if (p === "prompt") void loadPrompt();
  else if (p === "report") void loadReport();
  // always re-read: an extra may have been installed from another window since
  else if (p === "compare") void loadSettings();
  else if (p === "use" && !S.settings) void loadSettings();   // where the keys are kept
  render();
}

export function closePane() {
  const was = S.pane;
  S.pane = null;
  editingQ.i = null;
  render();
  if (was) document.querySelector<HTMLElement>(`[data-pane="${was}"]`)?.focus();
}

export function openSheet(s: Sheet) {
  S.sheet = s;
  S.menu = null;
  render();
}

export function closeSheet() {
  S.sheet = null;
  render();
  if (S.pane) document.querySelector<HTMLElement>(".drawer .dhead button")?.focus();
  else if (S.gridFocus) document.querySelector<HTMLElement>('.t tr.r[aria-selected="true"]')?.focus();
}

async function estimateSheet(kind: "check" | "label") {
  const id = model().id;
  const s = { kind, est: null, err: null } as Extract<Sheet, { kind: "check" | "label" }>;
  openSheet(s);
  try { s.est = await api.estimate(id, kind); } catch (e) { s.err = message(e); }
  if (S.sheet === s) renderLayer();
}

async function startJob(kind: string, params: Record<string, unknown> = {}) {
  const id = model().id;
  const job = await busy(() => api.startJob(id, kind, params));
  trackJobs(job);
  return job;
}

act("cancel", () => closeSheet());
act("close-pane", () => closePane());
act("new", async () => {
  if (!S.settings) await loadSettings();
  const teachers = [...(S.settings?.defaults.teachers ?? [])];
  S.sheet = null; S.menu = null; S.guide = null;
  S.wizard = freshWizard(teachers);
  render();
});
act("jobs", () => navigate("#/jobs"));
act("guide", el => {
  // The empty home page already shows getting started, so Help opens on the steps there.
  const welcome = S.route.page === "home" && S.models?.length === 0;
  S.guide = { tab: (el.dataset.tab as GuideTab | undefined) ?? (welcome ? "steps" : "next") }; S.menu = null; render();
  if (!S.settings && !S.models?.length) void loadSettings();
});
act("guide-tab", el => { if (S.guide) { S.guide.tab = el.dataset.tab as GuideTab; renderLayer(); } });
act("guide-close", () => { S.guide = null; render(); });
/** A step's button in the Guide: close it, then do what the model's own button does. */
act("guide-go", async el => {
  S.guide = null;
  const go = el.dataset.go!;
  if (go.startsWith("pane:")) { render(); openPane(go.slice(5) as Pane); return; }
  if (go.startsWith("nav:")) { render(); location.hash = `#/${go.slice(4)}`; return; }
  render();
  await runAct(go, el);
});
act("toggle-side", () => {
  S.sideHidden = !S.sideHidden;
  try { localStorage.setItem("studio.side", S.sideHidden ? "hidden" : "shown"); } catch { /* storage blocked */ }
  render();
});
act("find-model", el => { closeFind(); navigate(`#/m/${encodeURIComponent(el.dataset.id!)}`); });
act("find-doc", el => {
  const q = S.find.q;
  closeFind();
  const view = { set: el.dataset.set as "pool" | "tuning" | "test", search: q };
  if (S.route.page === "model" && S.route.id === el.dataset.id && S.model) {
    Object.assign(S.view, view, { sel: 0, filter: "all" });
    render();
    void loadRows();
  } else {
    S.pendingSearch = view;
    navigate(`#/m/${encodeURIComponent(el.dataset.id!)}`);
  }
});
export function closeFind() { S.find = { q: "", open: false, results: null }; }
act("settings", () => navigate("#/settings"));
act("playground", () => navigate("#/playground"));

/* ---------------- Playground ---------------- */
/** New documents from the box: one per line, skipping ones already there. */
export async function playRun() {
  const box = document.getElementById("play-text") as HTMLTextAreaElement | null;
  const P = S.play;
  const have = new Set(P.docs.map(d => d.text));
  const fresh = [...new Set((box?.value ?? "").split("\n").map(t => t.trim()).filter(t => t && !have.has(t)))];
  if (!fresh.length || !P.picks.length) return;
  P.docs = [...fresh.map(text => ({ text })), ...P.docs];
  if (box) box.value = "";
  savePlayground();
  await answerPlayground();
}
act("play-run", () => playRun());
act("play-unpick", el => { S.play.picks.splice(Number(el.dataset.i), 1); savePlayground(); render(); });
act("play-drop", el => { S.play.docs.splice(Number(el.dataset.i), 1); savePlayground(); render(); });
act("play-clear", () => { S.play.docs = []; savePlayground(); render(); });
act("play-ask", async el => {
  const P = S.play, d = P.docs[Number(el.dataset.i)];
  if (!d) return;
  const models = [...new Set(P.picks.map(p => p.model))].filter(id => !d.asked?.[id]);
  P.asking[d.text] = true;
  render();
  try {
    for (const id of models) {
      const res = await api.ask(id, d.text);
      const answers = res.combined ?? res.teachers?.[0]?.answers ?? res.answers ?? null;
      if (answers) (d.asked ??= {})[id] = answers;
    }
  } finally {
    delete P.asking[d.text];
    savePlayground();
    render();
  }
});
act("check", () => estimateSheet("check"));
act("label", () => estimateSheet("label"));
act("rounds", () => openSheet({ kind: "rounds" }));
act("compare", () => openPane("compare"));
act("report", () => openPane("report"));
act("pane-task", () => openPane("task"));
/** The ship sheet, with what the teachers answering the test set costs (nothing once cached,
 * unless the prompt or the teachers changed since). */
function shipSheet(method: string) {
  const id = model().id;
  const s = { kind: "ship", method, est: null, err: null } as Extract<Sheet, { kind: "ship" }>;
  openSheet(s);
  api.estimate(id, "test").then(e => { s.est = e; }, e => { s.err = message(e); }).finally(() => { if (S.sheet === s) renderLayer(); });
}
act("ship", () => { const m = model(); const x = shipped(m) ?? compared(m)[0]; if (x) shipSheet(x.id); });
act("ship-this", () => { const id = S.menu?.col.slice(2); if (id) shipSheet(id); });
act("ship-method", el => shipSheet(el.dataset.method!));
act("remove-method-row", el => openSheet({ kind: "remove-method", method: el.dataset.method! }));
act("confirm-remove-method", () => { const id = S.menu?.col.slice(2); if (id) openSheet({ kind: "remove-method", method: id }); });
act("confirm-remove-teacher", el => openSheet({ kind: "remove-teacher", index: +el.dataset.i! }));
act("confirm-remove-label", el => {
  const i = +el.dataset.i!;
  const labels = (S.task?.saved.labels ?? []).map(l => l.name);
  const into = labels.find((_, j) => j !== i) ?? "";
  openSheet({ kind: "remove-label", index: i, impact: null, mode: "merge", into });
  void api.impact(model().id, { label: labels[i] }).then(impact => {
    if (S.sheet?.kind === "remove-label" && S.sheet.index === i) { S.sheet.impact = impact; renderLayer(); }
  }).catch(err => toast(message(err)));
});
act("confirm-remove-question", el => openSheet({ kind: "remove-question", question: el.dataset.q! }));
act("confirm-merge-option", el => {
  const q = (S.task?.saved.questions ?? []).find(x => x.id === el.dataset.q);
  if (!q) return;
  openSheet({ kind: "merge-option", question: q.id, from: q.options[0], into: q.options[1], impact: null });
  sheetImpact();
});
/** Refresh the merge sheet's counts for the option it would merge away. */
export function sheetImpact() {
  const s = S.sheet;
  if (s?.kind !== "merge-option") return;
  const from = s.from;
  void api.impact(model().id, { question: s.question, option: from }).then(impact => {
    if (S.sheet?.kind === "merge-option" && S.sheet.from === from) { S.sheet.impact = impact; renderLayer(); }
  }).catch(err => toast(message(err)));
}
act("confirm-prompt", el => openSheet({ kind: "use-prompt", index: +el.dataset.i! }));

act("start-check", async () => { await startJob("check"); S.sheet = null; toast("Checking teachers. Follow it in Jobs."); await loadModel(); });
act("start-label", async () => { await startJob("label"); S.sheet = null; toast("Labeling started. You can pause it in Jobs."); await loadModel(); });
act("resume-label", async () => {
  const m = model();
  const paused = S.jobs?.now.find(j => j.model === m.id && j.state === "paused" && j.kind === "label");
  if (paused) { await busy(() => api.resumeJob(paused.id)); pollJobs(); }
  else await startJob("label");
  S.sheet = null;
  await loadModel();
});
act("do-ship", async () => {
  const m = model();
  const s = S.sheet;
  if (s?.kind !== "ship") return;
  // a limit picked earlier carries over; a first ship uses shrewd's default and then asks
  const kept = m.routing && m.routing.chosen !== false ? m.routing.curve[m.routing.selected]?.[0] : null;
  const routing = val("rt") === "on" ? { budget: kept ?? 2, delta: 0.05 } : null;
  const params: ShipParams = isPanel(m)
    ? { method: s.method, calibration: val("cal") || "auto", soft: checked("soft"), calibrate_teacher: checked("calt"), zero_shot: checked("zs"), min_confidence: 0, routing }
    : { method: s.method, calibration: "auto", soft: false, calibrate_teacher: false, zero_shot: false, min_confidence: numOr(val("abs"), 0)!, routing };
  await startJob("ship", params as unknown as Record<string, unknown>);
  S.sheet = null;
  toast(`Shipping ${m.methods.find(x => x.id === s.method)?.name ?? s.method}. Follow it in Jobs.`);
  render();
});
act("routing-open", () => { const rt = model().routing; if (rt) openSheet({ kind: "routing", pick: rt.selected ?? 0 }); });
act("routing-go", async () => {
  const s = S.sheet, m = model();
  const b = s?.kind === "routing" ? m.routing?.curve[s.pick]?.[0] : null;
  if (b == null) return;
  await busy(() => api.route(m.id, b));
  S.sheet = null;
  await Promise.all([loadModel(m.id), loadRows(true)]);
});
act("remove-method", async () => {
  const s = S.sheet;
  if (s?.kind !== "remove-method") return;
  await busy(() => api.removeMethod(model().id, s.method));
  S.sheet = null;
  await Promise.all([loadModel(), loadRows(true)]);
});

/* ---------------- the table ---------------- */
act("methods", () => { S.allMethods = !S.allMethods; render(); });
act("insp", () => { S.insp = !S.insp; render(); });
act("clear", () => { S.view.filter = "all"; S.view.sel = 0; render(); void loadRows(); });
act("clear-search", () => { S.view.search = ""; render(); void loadRows(); });
act("review", () => { Object.assign(S.view, { filter: "needs", set: "all", sel: 0, aqFor: null }, reviewQuestion(model())); S.pane = null; S.gridFocus = true; render(); void loadRows(); });
/** On a panel, the table opens on the question most queued documents wait on; each row's own
 * queued questions are picked out in Details. */
function reviewQuestion(m: Model): Partial<typeof S.view> {
  const counts = Object.entries(m.queued ?? {});
  if (!isPanel(m) || !counts.length) return {};
  const [id] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  const q = m.questions.findIndex(x => x.id === id);
  return q < 0 ? {} : { q };
}
act("reload-rows", () => { S.rowsErr = null; render(); void loadRows(true); });
act("reload-model", () => { S.modelErr = null; render(); void loadModel(); void loadRows(true); });
act("reload-models", () => { S.modelsErr = null; render(); void loadModels(); });
act("reload-task", () => { S.taskErr = null; renderLayer(); void loadTask(); });
act("reload-prompt", () => { S.promptErr = null; renderLayer(); void loadPrompt(); });
act("reload-report", () => { S.reportErr = null; renderLayer(); void loadReport(); });
act("reload-settings", () => { S.settingsErr = null; render(); void loadSettings(); });
act("sort-asc", () => { S.view.sort = { col: S.menu!.col.slice(2), dir: 1 }; S.menu = null; render(); });
act("sort-desc", () => { S.view.sort = { col: S.menu!.col.slice(2), dir: -1 }; S.menu = null; render(); });
act("f-vsyou", () => { S.view.filter = "vsyou"; S.menu = null; render(); void loadRows(); });
act("f-disagree", () => { S.view.filter = "disagree"; S.menu = null; render(); void loadRows(); });

const menuJob = () => model().methods.find(x => x.id === S.menu?.col.slice(2))?.job ?? null;
act("job-pause", () => jobCmd("pause", menuJob()));
act("job-resume", () => jobCmd("resume", menuJob()));
act("job-cancel", () => jobCmd("cancel", menuJob()));

export async function jobCmd(cmd: "pause" | "resume" | "cancel", id: string | null) {
  S.menu = null;
  if (!id) { render(); return; }
  const fn = { pause: api.pauseJob, resume: api.resumeJob, cancel: api.cancelJob }[cmd];
  try { await fn(id); } catch (e) { toast(message(e)); }
  pollJobs();
  if (S.route.page === "model") await loadModel(); else render();
}

/** Pick option k for question j on the selected row (not saved until Save or Enter). */
export function pick(j: number, k: number) {
  const m = model(), r = currentRow();
  if (!r) return;
  const opt = m.questions[j]?.options[k];
  if (opt == null) return;
  const cur = S.picks[r.key] ?? m.questions.map((_, q) => youVal(r, q));
  cur[j] = opt;
  S.picks[r.key] = cur;
  S.view.aq = j;
  S.view.aqFor = r.key;
  renderRow(S.view.sel);
  renderDetails();
}

/** Select row i, loading the next page when it nears the end of what's loaded. */
export function select(i: number) {
  const rows = shownRows();
  const prev = S.view.sel;
  S.view.sel = Math.max(0, Math.min(rows.length - 1, i));
  S.view.aqFor = null;          // the new row starts on the question it's queued for
  S.gridFocus = true;
  renderSelection(prev);
  if (S.rows.length < S.matched && S.view.sel > S.rows.length - 20) void loadMore();
}

/** Save the selected row's picks (if any) and move to the next row. */
export async function saveAndNext() {
  const m = model(), r = currentRow();
  if (!r) return;
  const picks = S.picks[r.key];
  const i = S.view.sel;
  select(i + 1);
  if (!picks || r.set === "try") return;
  const answers: Record<string, string> = {};
  m.questions.forEach((q, j) => { if (picks[j] != null) answers[q.id] = picks[j]!; });
  const wasNeeded = !!r.needs && !r.reviewed;
  try {
    const row = await api.answer(m.id, r.key, answers);
    replaceRow(r.key, row);
    delete S.picks[r.key];
    if (wasNeeded && !needsYou(row) && S.model) {
      S.model.counts.review = Math.max(0, S.model.counts.review - 1);
      const sm = S.models?.find(x => x.id === m.id);
      if (sm) sm.review = Math.max(0, sm.review - 1);
    }
    render();
  } catch (e) {
    toast(`Not saved: ${message(e)}`);
  }
}

function replaceRow(key: string, row: Row) {
  const i = S.rows.findIndex(x => x.key === key);
  if (i >= 0) S.rows[i] = row;
}

act("save", () => saveAndNext());
act("clear-answer", async el => {
  const m = model(), r = currentRow();
  if (!r) return;
  const j = Number(el.dataset.j);
  const picks = S.picks[r.key];
  if (picks?.[j] != null) {                  // not saved yet: just drop it
    picks[j] = null;
    if (picks.every(p => p == null)) delete S.picks[r.key];
    render();
    return;
  }
  const row = await busy(() => api.clearAnswer(m.id, r.key, isPanel(m) ? m.questions[j].id : null));
  replaceRow(r.key, row);
  render();
});
act("remove-example-open", () => {
  const r = currentRow();
  if (!r || r.set === "pool" || r.set === "try") return;
  S.sheet = { kind: "remove-example", key: r.key, set: r.set, text: r.text };
  render();
});
act("remove-example", async () => {
  const s = S.sheet, m = model();
  if (s?.kind !== "remove-example") return;
  await busy(() => api.removeExample(m.id, s.key));
  S.sheet = null;
  toast(s.set === "test" ? "Removed from the test set." : "Removed from your tuning examples.");
  await Promise.all([loadModel(), loadRows(true)]);
});
act("to-examples", async () => {
  const r = currentRow();
  if (!r) return;
  const res = await busy(() => api.fromPool(model().id, r.key));
  toast(addedTo(res.set));
  await Promise.all([loadModel(), loadRows(true)]);
});
const addedTo = (set: "tuning" | "test") => set === "test"
  ? "Added to your examples, in the locked test set."
  : "Added to your examples, for tuning.";

/** A typed-in row kept: it leaves the typed rows and shows up where it went. */
function dropTry(key: string) {
  const m = model();
  S.tries[m.id] = (S.tries[m.id] ?? []).filter(x => x.key !== key);
  delete S.picks[key];
}
act("typed-example", async () => {
  const m = model(), r = currentRow();
  if (!r || r.set !== "try") return;
  const picks = S.picks[r.key] ?? [];
  const answers: Record<string, string> = {};
  m.questions.forEach((q, j) => { if (picks[j] != null) answers[q.id] = picks[j]!; });
  const res = await busy(() => api.typedExample(m.id, r.text, answers));
  dropTry(r.key);
  toast(addedTo(res.set));
  await Promise.all([loadModel(), loadRows(true)]);
});
act("typed-document", async () => {
  const m = model(), r = currentRow();
  if (!r || r.set !== "try") return;
  await busy(() => api.typedDocument(m.id, r.text));
  dropTry(r.key);
  toast("Added to the documents.");
  await Promise.all([loadModel(), loadRows(true)]);
});

/** A typed-in document: the local methods answer it for free; teachers only when asked. */
export async function tryText(text: string) {
  const m = model();
  const res = await api.try(m.id, text);
  const row: Row = {
    key: `try:${Date.now()}:${text}`, set: "try", text, you: [], needs: null, reviewed: false, round: null,
    teachers: m.teachers.map(() => ({ state: "ask", answers: [], p: null, votes: null, alt: null })), combined: null,
    methods: Object.fromEntries(Object.entries(res.methods).map(([id, a]) => [id, { state: "ok" as const, answers: a.answers, p: a.p, routed: a.routed }])),
  };
  (S.tries[m.id] ??= []).push(row);
  render();
}

export async function askTeachers(key: string) {
  const m = model();
  const row = S.tries[m.id]?.find(r => r.key === key);
  if (!row) return;
  const res = await api.ask(m.id, row.text);
  const per = res.teachers ?? (res.answers ? [{ answers: res.answers }] : []);
  row.teachers = m.teachers.map((_, ti) => per[ti]
    ? { state: "ok", answers: per[ti].answers, p: per[ti].p ?? null, votes: null, alt: null }
    : { state: "notasked", answers: [], p: null, votes: null, alt: null });
  row.combined = res.combined ?? (m.combine ? null : per[0]?.answers ?? null);
  render();
}

/* ---------------- files ---------------- */
let onFile: ((f: File) => void) | null = null;
export function pickFile(fn: (f: File) => void) {
  const input = document.getElementById("file-pick") as HTMLInputElement;
  onFile = fn;
  input.value = "";
  input.click();
}
export function fileChosen(f: File) { const fn = onFile; onFile = null; fn?.(f); }

/** Read a picked CSV: its columns, a few rows, how many rows, and a first guess at the mapping. */
async function readPick(f: File, targets: [string, string][]): Promise<CsvPick> {
  const { headers, rows } = readCsv(await f.text(), Infinity);
  const map: Record<string, string> = {};
  for (const [t] of targets) {
    const guess = t === "text" ? guessColumn(headers, ["text", "document", "content", "message", "body"])
      : t === "label" ? guessColumn(headers, ["label", "category", "class", "answer"]) : guessColumn(headers, [t.toLowerCase()]);
    if (guess) map[t] = guess;
  }
  return { file: f, headers, rows, count: rows.length, map };
}

function importInto(target: "examples" | "pool") {
  const m = model();
  pickFile(async f => {
    try {
      const targets = target === "pool" ? [["text", ""]] as [string, string][] : exampleTargets(m.kind, m.questions);
      openSheet({ kind: "import", target, pick: await readPick(f, targets) });
    } catch (e) { toast(message(e)); }
  });
}
act("pool", () => importInto("pool"));
act("examples-file", () => importInto("examples"));
act("import-go", async () => {
  const s = S.sheet;
  if (s?.kind !== "import") return;
  const id = model().id;
  if (s.target === "pool") await busy(() => api.addPool(id, s.pick.file, s.pick.map.text));
  else await busy(() => api.addExamples(id, s.pick.file, invert(s.pick.map)));
  S.sheet = null;
  toast(s.target === "pool" ? `Added ${n(s.pick.count)} documents.` : `Added ${n(s.pick.count)} examples.`);
  await Promise.all([loadModel(), loadRows(true), loadModels()]);
});
/** {target: header} as the server wants it: {header: target}. */
const invert = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).filter(([, h]) => h).map(([t, h]) => [h, t]));

/* ---------------- New model ---------------- */
const wiz = () => S.wizard!;
act("wiz-cancel", () => { S.wizard = null; render(); });
act("wiz-kind", el => { wiz().kind = el.dataset.kind as "classifier" | "panel"; renderLayer(); });
act("wiz-next", () => { const w = wiz(); w.err = null; if (w.step > 1 && wizardProblem(w)) return; w.step = Math.min(4, w.step + 1) as Wizard["step"]; renderLayer(); });
act("wiz-back", () => { const w = wiz(); w.err = null; w.step = Math.max(1, w.step - 1) as Wizard["step"]; renderLayer(); });
act("wiz-add", el => {
  const w = wiz(), what = el.dataset.what;
  if (what === "label") w.labels.push({ name: "", description: "" });
  if (what === "question") w.questions.push({ id: "", type: "choice", text: "", options: [] });
  if (what === "teacher") {
    const v = val("wz-teacher").trim();
    if (v && !w.teachers.includes(v)) w.teachers.push(v);
  }
  renderLayer();
});
act("wiz-drop", el => {
  const w = wiz(), i = +el.dataset.i!;
  ({ label: w.labels, question: w.questions, teacher: w.teachers } as Record<string, unknown[]>)[el.dataset.what!]?.splice(i, 1);
  renderLayer();
});
act("wiz-settings", () => { S.wizard = null; navigate("#/settings"); });
act("wiz-file", el => {
  const w = wiz(), what = el.dataset.what as "examples" | "pool";
  pickFile(async f => {
    try {
      const targets = what === "pool" ? [["text", ""]] as [string, string][] : exampleTargets(w.kind, w.questions);
      w[what] = await readPick(f, targets);
      renderLayer();
    } catch (e) { toast(message(e)); }
  });
});
act("wiz-create", async () => {
  const w = wiz();
  if (wizardProblem(w)) return;
  const questions = w.questions.filter(q => q.id.trim()).map(q => ({ ...q, id: q.id.trim(), options: q.type === "yes/no" ? [] : q.options.filter(Boolean) }));
  try {
    const { id } = await busy(() => api.createModel({
      name: w.name.trim(), kind: w.kind, instructions: w.instructions.trim(), teachers: w.teachers,
      ...(w.kind === "panel" ? { questions } : { labels: w.labels.filter(l => l.name.trim()).map(l => ({ name: l.name.trim(), description: l.description.trim() })) }),
    }));
    let failed = "";
    try {
      if (w.examples) await busy(() => api.addExamples(id, w.examples!.file, invert(w.examples!.map)));
      if (w.pool) await busy(() => api.addPool(id, w.pool!.file, w.pool!.map.text));
    } catch (e) { failed = message(e); }
    S.wizard = null;
    await loadModels();
    navigate(`#/m/${encodeURIComponent(id)}`);
    toast(failed ? `${w.name.trim()} was created, but its data couldn't be added: ${failed}. Add it from the model.`
      : `${w.name.trim()} is ready. The button at the top right is always the next step.`);
  } catch (e) {
    w.err = message(e);
    renderLayer();
  }
});

act("label-file", el => {
  const mode = (el.dataset.mode === "teachers" ? "teachers" : "local") as "local" | "teachers";
  pickFile(async f => {
    try { trackJobs(await api.labelFile(model().id, f, mode)); toast(`Labeling ${f.name}. Follow it in Jobs.`); }
    catch (e) { toast(message(e)); }
  });
});
act("reveal", async () => { await api.reveal(model().id); });
act("jobs-clear", async () => { S.jobs = await api.clearJobs(); render(); });
act("guide-note", el => {
  const note = document.getElementById(`g-n-${el.dataset.note}`);
  if (!note) return;
  note.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  note.classList.add("hit");
  setTimeout(() => note.classList.remove("hit"), 1400);
});

/* ---------------- Exporting ---------------- */
const precision = (s: { half: boolean; format: string | null }) => (s.half && s.format === "plain" ? "float16" : "float32");
act("export-open", async () => {
  const m = model();
  const s: Sheet = { kind: "export", opts: null, format: null, half: false, done: null, err: null };
  S.sheet = s; S.menu = null;
  render();
  const opts = await api.exportOptions(m.id);
  if (S.sheet !== s) return;
  s.opts = opts;
  s.format = (opts.formats.find(f => f.ready) ?? opts.formats[0])?.id ?? null;
  renderLayer();
});
act("export-go", async () => {
  const s = S.sheet, m = model();
  if (s?.kind !== "export" || !s.format) return;
  s.err = null;
  try { s.done = await busy(() => api.exportModel(m.id, s.format!, precision(s))); }
  catch (e) { s.err = message(e); }
  renderLayer();
});
act("export-reveal", async () => {
  const s = S.sheet;
  if (s?.kind === "export" && s.format) await api.exportReveal(model().id, s.format, precision(s));
});

/* ---------------- Installing extras ---------------- */
act("install", async el => {
  const extra = el.dataset.extra!;
  const e = S.settings?.extras.find(x => x.id === extra);
  const job = await api.installExtra(extra);
  if (e) e.job = { id: job.id, state: job.state, message: job.message, error: null, log: [] };
  trackJobs(job);
  toast(`Installing ${e?.name ?? extra}. Follow it in Jobs; it's ready when that finishes.`);
  render();
});
act("install-help", el => {
  S.sheet = { kind: "install-help", extra: el.dataset.extra! };
  render();
});

/* ---------------- Deleting ---------------- */
act("delete-model-open", async () => {
  const m = model();
  const s: Sheet = { kind: "delete-model", info: null, keep: true };
  S.sheet = s; S.pane = null; S.menu = null;
  render();
  const info = await api.deleteInfo(m.id);
  if (S.sheet !== s) return;
  s.info = info; s.keep = info.can_archive;
  renderLayer();
});
act("delete-model", async () => {
  const s = S.sheet, m = model();
  if (s?.kind !== "delete-model" || !s.info) return;
  const keep = s.keep && s.info.can_archive;
  const done = await busy(() => api.deleteModel(m.id, keep));
  S.sheet = null;
  const where = done.trash ? `; the rest is in the ${system().trash} as “${done.trash}”` : "";
  if (keep) {
    toast(`${m.name} is archived${where}.`);
    await Promise.all([loadModels(), loadModel(m.id), loadRows()]);
    return;
  }
  toast(`${m.name} moved to the ${system().trash}.`);
  S.model = null;
  await loadModels();
  location.hash = "#/";
});

/* ---------------- Task drawer ---------------- */
export function markDirty() {
  if (S.dirty) return;
  S.dirty = true;
  const f = document.querySelector(".pane-foot");
  if (f) f.innerHTML = taskFoot();
}
const draft = () => S.task!.draft;
const relayout = () => { S.dirty = true; renderLayer(); };

act("discard", () => { if (S.task) S.task.draft = structuredClone(S.task.saved); S.dirty = false; editingQ.i = null; renderLayer(); });
act("savetask", async () => {
  if (!S.task) return;
  const { saved, draft: d } = S.task;
  const patch: Partial<Task> = {};
  for (const k of Object.keys(d) as (keyof Task)[]) if (JSON.stringify(d[k]) !== JSON.stringify(saved[k])) (patch as Record<string, unknown>)[k] = d[k];
  if (patch.labels) patch.labels = patch.labels.filter(l => l.name.trim());
  const t = await busy(() => api.patchTask(model().id, patch));
  S.task = { saved: t, draft: structuredClone(t) };
  S.dirty = false;
  editingQ.i = null;
  toast("Task saved.");
  await Promise.all([loadModel(), loadRows(true)]);
});
async function patchNow(patch: Partial<Task>) {
  const t = await busy(() => api.patchTask(model().id, patch));
  S.task = { saved: t, draft: S.dirty && S.task ? { ...S.task.draft, ...fieldsOf(t, patch) } : structuredClone(t) };
  S.sheet = null;
  await Promise.all([loadModel(), loadRows(true)]);
}
/** The fields of a saved task named in patch, so a removal doesn't throw away other unsaved edits. */
const fieldsOf = (t: Task, patch: Partial<Task>) => Object.fromEntries(Object.keys(patch).map(k => [k, structuredClone(t[k as keyof Task])]));

act("remove-teacher", async () => {
  const s = S.sheet;
  if (s?.kind !== "remove-teacher" || !S.task) return;
  const name = draft().teachers[s.index]?.name;
  await patchNow({ teachers: S.task.saved.teachers.filter(t => t.name !== name) });
});
/** After a remove or merge: the saved task, the model and rows, and shrewd's notes as toasts. */
async function structural(run: () => Promise<{ notes: string[]; task: Task }>) {
  const r = await busy(run);
  S.task = { saved: r.task, draft: structuredClone(r.task) };
  S.dirty = false;
  S.sheet = null;
  await Promise.all([loadModel(), loadRows(true)]);
  toast(r.notes.length ? r.notes.join(" ") : "Done. Compare and ship again to retrain.");
}
act("remove-label", async () => {
  const s = S.sheet;
  if (s?.kind !== "remove-label" || !S.task) return;
  const name = (S.task.saved.labels ?? [])[s.index]?.name;
  if (!name) return;
  await structural(() => api.removeLabel(model().id, name, s.mode === "merge" ? s.into : null));
});
act("remove-question", async () => {
  const s = S.sheet;
  if (s?.kind !== "remove-question") return;
  await structural(() => api.removeQuestion(model().id, s.question));
});
act("merge-option", async () => {
  const s = S.sheet;
  if (s?.kind !== "merge-option") return;
  await structural(() => api.mergeOptions(model().id, s.question, { [s.from]: s.into }));
});
act("add-label", () => { (draft().labels ??= []).push({ name: "", description: "" }); relayout(); document.querySelector<HTMLElement>(`[data-tl-name="${draft().labels!.length - 1}"]`)?.focus(); });
act("drop-new-label", el => { draft().labels?.splice(+el.dataset.i!, 1); relayout(); });
act("add-question", () => {
  const qs = (draft().questions ??= []);
  qs.push({ id: `question_${qs.length + 1}`, type: "choice", text: "", options: [] });
  editingQ.i = qs.length - 1;
  relayout();
});
act("q-edit", el => { editingQ.i = +el.dataset.i!; renderLayer(); });
act("q-done", () => { editingQ.i = null; renderLayer(); });
// it sends every document to every teacher again, so it asks first like anything else that costs
act("confirm-reask", el => openSheet({ kind: "reask", question: el.dataset.q! }));
act("reask", async () => {
  const s = S.sheet;
  if (s?.kind !== "reask") return;
  closeSheet();
  trackJobs(await api.reask(model().id, s.question));
  toast(`Asking the teachers ${s.question} again. Follow it in Jobs.`);
});
act("t-up", el => { const t = draft().teachers, i = +el.dataset.i!; [t[i - 1], t[i]] = [t[i], t[i - 1]]; relayout(); });
act("t-down", el => { const t = draft().teachers, i = +el.dataset.i!; [t[i + 1], t[i]] = [t[i], t[i + 1]]; relayout(); });
act("add-teacher", () => {
  const name = val("new-teacher").trim();
  if (!name || !S.task) return;
  if (!draft().teachers.some(t => t.name === name)) draft().teachers.push({ name, per1k: 0 });
  relayout();
});

/** A field in the Task drawer changed. Selects that change the layout redraw the drawer. */
export function taskField(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  if (!S.task) return;
  const t = draft();
  const v = el.value;
  if (el.dataset.tf) {
    switch (el.dataset.tf) {
      case "instructions": t.instructions = v; break;
      case "combine": t.combine = v as Task["combine"]; return relayout();
      case "ask": t.escalate = v === "first" ? (S.task.saved.escalate ?? { budget: 5, delta: 0.05, share: 0 }) : null; return relayout();
      case "esc-budget": if (t.escalate) t.escalate = { ...t.escalate, budget: numOr(v, 0)! }; break;
      case "esc-conf": if (t.escalate) t.escalate = { ...t.escalate, delta: 1 - (numOr(v, 95)! / 100) }; break;
      case "votes": t.votes = +v; return relayout();
      case "limit": t.limit = { mode: v as Task["limit"]["mode"], value: v === "all" ? null : t.limit.value }; return relayout();
      case "limit-value": t.limit = { ...t.limit, value: numOr(v, null) }; break;
      case "concurrency": t.concurrency = numOr(v, 8)!; break;
    }
  } else if (el.dataset.tlName) { t.labels![+el.dataset.tlName].name = v; }
  else if (el.dataset.tlDesc) { t.labels![+el.dataset.tlDesc].description = v; }
  else if (el.dataset.tq) {
    const q = t.questions![+el.dataset.tq];
    const f = el.dataset.f;
    if (f === "id") q.id = v;
    else if (f === "text") q.text = v;
    else if (f === "options") q.options = v.split(",").map(s => s.trim()).filter(Boolean);
    else if (f === "type") { q.type = v as typeof q.type; if (q.type === "yes/no") q.options = ["no", "yes"]; return relayout(); }
  }
  markDirty();
}

/* ---------------- Prompt drawer ---------------- */
act("view-cand", el => { const i = +el.dataset.i!; S.promptView = S.promptView === i ? null : i; renderLayer(); });
act("use-prompt", async () => {
  const s = S.sheet;
  if (s?.kind !== "use-prompt") return;
  const p = await busy(() => api.usePrompt(model().id, s.index));
  S.sheet = null;
  if (p && typeof p === "object" && "text" in p) { S.prompt = p; render(); } else await loadPrompt();
  void loadModel();
});
act("optimize", async () => {
  const m = model();
  const params: Record<string, unknown> = { budget: numOr(val("gb"), 800), target: numOr(val("gt"), null), reflection_model: val("gr") || null };
  if (isPanel(m)) params.max_header_words = numOr(val("gw"), null);
  await startJob("optimize", params);
  toast("Optimizing the prompt. Follow it in Jobs.");
  renderLayer();
});
export function promptBudget(v: string) {
  const f = document.querySelector(".pane-foot");
  if (f && S.prompt) f.innerHTML = promptFoot(numOr(v, 0)!, S.prompt.against);
}

/* ---------------- Compare drawer ---------------- */
act("startcompare", async () => {
  // a method whose extra isn't installed may still be in the picks from before Settings loaded
  const methods = Object.entries(S.comparePick ?? {}).filter(([id, on]) => on && !missing(id)).map(([id]) => id);
  if (!methods.length) return;
  const jobs = await startJob("compare", { methods });
  S.comparePick = null;
  toast(`Comparing ${methods.length} method${methods.length === 1 ? "" : "s"}. Follow ${Array.isArray(jobs) && jobs.length > 1 ? "them" : "it"} in Jobs.`);
  await loadModel();
});

/* ---------------- New model ---------------- */

/* ---------------- Settings ---------------- */
const folderSheet = () => (S.sheet?.kind === "folder" ? S.sheet : null);

/** What switching to the sheet's folder would mean; moving is the default when it's possible. */
export async function inspectFolder() {
  const s = folderSheet();
  if (!s) return;
  s.info = null; s.err = null;
  renderLayer();
  const path = s.path;
  try {
    const info = await api.inspectFolder(s.which, path);
    if (folderSheet() !== s || s.path !== path) return;
    s.info = info;
    s.move = !!info.here?.models && !info.conflicts?.length && !info.active;
  } catch (e) {
    if (folderSheet() === s) s.err = message(e);
  }
  renderLayer();
}

act("folder-change", el => {
  const which = el.dataset.which as Folder;
  const st = S.settings?.storage;
  S.sheet = { kind: "folder", which, path: (which === "workspace" ? st?.workspace : st?.models_dir) ?? "", info: null, err: null, move: false };
  render();
});
act("folder-pick", async () => {
  const s = folderSheet();
  if (!s) return;
  const { path } = await api.pickFolder(s.which, s.path);
  if (!path || folderSheet() !== s) return;
  s.path = path;
  await inspectFolder();
});
act("folder-default", async () => {
  const s = folderSheet(), st = S.settings?.storage;
  if (!s || !st) return;
  s.path = (s.which === "workspace" ? st.default_workspace : st.default_models_dir) ?? s.path;
  await inspectFolder();
});
act("folder-reveal", async el => { await api.revealFolder(el.dataset.which as Folder); });
act("folder-go", async () => {
  const s = folderSheet();
  if (!s?.info || s.info.problem) return;
  const done = await busy(() => api.setFolder(s.which, s.path, s.which === "workspace" && s.move));
  S.sheet = null;
  if (!done.restart) { toast("Saved. Restart Studio to use the new folder."); render(); return; }
  S.restarting = { boot: done.boot, path: s.info.path, failed: false };
  render();
  // the same server comes back on the same port with a new boot id; then start the page afresh
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const st = await api.settings();
      if (st.boot && st.boot !== done.boot) { location.replace(location.pathname + location.search); return; }
    } catch { /* still restarting */ }
  }
  S.restarting.failed = true;
  render();
});
const applySettings = async (p: Promise<Settings | unknown>) => {
  const s = await p;
  if (s && typeof s === "object" && "keys" in s) S.settings = s as Settings; else await loadSettings();
  render();
};
// saving or removing a key answers with the key list only, not the whole view
const applyKeys = async (p: Promise<Pick<Settings, "keys">>) => {
  const { keys } = await p;
  S.teacherKeys = {};      // a teacher's key status may have changed with it
  if (S.settings) S.settings = { ...S.settings, keys }; else await loadSettings();
  render();
};
act("save-key", async () => {
  const s = S.sheet;
  const value = val("key-value");
  if (s?.kind !== "key" || !value) return;
  await busy(() => applyKeys(api.putKey(s.variable, value)));
  S.sheet = null;
  toast(`${s.variable} saved to the ${system().keystore}.`);
  render();
});
act("remove-key", async () => {
  const s = S.sheet;
  if (s?.kind !== "remove-key") return;
  await busy(() => applyKeys(api.deleteKey(s.variable)));
  S.sheet = null;
  render();
});
act("save-other-key", async () => {
  const variable = val("other-var").trim(), value = val("other-key");
  if (!variable || !value) { toast("Enter a variable name and a key."); return; }
  await applyKeys(api.putKey(variable, value));
  toast(`${variable} saved to the ${system().keystore}.`);
});
act("add-endpoint", async () => {
  const which = val("ep-which"), url = val("ep-url").trim();
  if (!which || !url) return;
  await applySettings(api.patchSettings({ endpoints: { [which]: url } }));
});
act("remove-endpoint", async () => {
  const s = S.sheet;
  if (s?.kind !== "remove-endpoint") return;
  await busy(() => applySettings(api.patchSettings({ endpoints: { [s.which]: null } })));
  S.sheet = null;
  render();
});
act("def-teacher-add", async () => {
  const name = val("def-teacher").trim(), s = S.settings;
  if (!name || !s || s.defaults.teachers.includes(name)) return;
  await applySettings(api.patchSettings({ defaults: { ...s.defaults, teachers: [...s.defaults.teachers, name] } }));
});
act("def-teacher-drop", async el => {
  const s = S.settings;
  if (!s || s.defaults.teachers.length <= 1) return;
  await applySettings(api.patchSettings({ defaults: { ...s.defaults, teachers: s.defaults.teachers.filter((_, i) => i !== +el.dataset.i!) } }));
});
act("add-price", async () => {
  const model = val("price-model").trim();
  if (!model || !S.settings) return;
  await applySettings(api.patchSettings({ prices: [...S.settings.prices, { model, input: 0, output: 0 }] }));
});
act("remove-price", async el => {
  if (!S.settings) return;
  await applySettings(api.patchSettings({ prices: S.settings.prices.filter((_, i) => i !== +el.dataset.i!) }));
});

export async function settingChanged(el: HTMLInputElement | HTMLSelectElement) {
  const s = S.settings;
  if (!s) return;
  try {
    if (el.dataset.price) {
      const prices = s.prices.map((p, i) => (i === +el.dataset.price! ? { ...p, [el.dataset.f!]: numOr(el.value, 0) } : p));
      await applySettings(api.patchSettings({ prices }));
      return;
    }
    const [group, key] = el.dataset.setting!.split(".") as ["defaults" | "compute", string];
    let v: unknown = el.value;
    if (key === "test_frac") v = s.defaults.test_frac <= 1 ? (numOr(el.value, 35)! / 100) : numOr(el.value, 35);
    else if (el instanceof HTMLInputElement && el.type === "number") v = numOr(el.value, 0);
    await applySettings(api.patchSettings({ [group]: { ...s[group], [key]: v } }));
    if (group === "compute") pollJobs();
  } catch (e) {
    toast(message(e));
  }
}
