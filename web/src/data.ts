// Loading data from the API into S. Views never fetch: they read S and ask for what's missing here.
import { api } from "./api";
import { render } from "./render";
import { S, freshView } from "./state";
import type { PlayPick } from "./api";
import { message, toast } from "./util";

export const PAGE = 300;

/** Ask the server what a teacher name needs, once per name; the views show it when it comes. */
export function wantTeacherKey(model: string) {
  if (model in S.teacherKeys) return;
  S.teacherKeys[model] = null;
  // a failed ask isn't retried on every redraw; reopening Settings or the form asks again
  api.teacherKey(model).then(k => { S.teacherKeys[model] = k; render(); }, () => { /* stays "checking" */ });
}

export async function loadModels() {
  try {
    S.models = await api.models();
    S.modelsErr = null;
    if (!S.models.length && !S.settings) void loadSettings();
  } catch (e) {
    S.modelsErr = message(e);
  }
  render();
}

/** Re-read the model list and redraw only if it changed: another window, or shrewd from Python,
 * can add or change models in the same folder. */
export async function refreshModels() {
  let next;
  try { next = await api.models(); } catch { return; }
  if (JSON.stringify(next) === JSON.stringify(S.models)) return;
  S.models = next;
  S.modelsErr = null;
  render();
}

/** Open a model: fresh view state, its detail and the first page of rows. */
export async function openModel(id: string) {
  S.view = freshView();
  if (!S.colW[id]) {
    try { S.colW[id] = JSON.parse(localStorage.getItem(`studio.cols.${id}`) ?? "{}"); } catch { S.colW[id] = {}; }
  }
  if (S.pendingSearch) { Object.assign(S.view, S.pendingSearch); S.pendingSearch = null; }
  S.model = S.model?.id === id ? S.model : null;
  S.modelErr = null;
  S.rows = []; S.total = 0; S.matched = 0; S.rowsErr = null;
  S.pane = null; S.sheet = null; S.menu = null;
  S.task = null; S.prompt = null; S.report = null; S.comparePick = null; S.dirty = false; S.promptView = null;
  render();
  await Promise.all([loadModel(id), loadRows()]);
}

export async function loadModel(id = S.model?.id ?? routeId()) {
  if (!id) return;
  try {
    const m = await api.model(id);
    if (routeId() !== id) return;
    S.model = m;
    S.modelErr = null;
    if (typeof S.view.q === "number" && S.view.q >= m.questions.length) S.view.q = 0;
  } catch (e) {
    if (routeId() === id) S.modelErr = message(e);
  }
  render();
}

const routeId = () => (S.route.page === "model" ? S.route.id : null);

let seq = 0;
/** The first page of rows for the current set, filter, question and search. */
export async function loadRows(keepSel = false) {
  const id = routeId();
  if (!id) return;
  const mine = ++seq;
  S.rowsLoading = true;
  const v = S.view;
  try {
    const page = await api.rows(id, { set: v.set, filter: v.filter, q: v.q, search: v.search, offset: 0, limit: PAGE });
    if (mine !== seq) return;
    S.rows = page.rows; S.total = page.total; S.matched = page.matched; S.rowsErr = null;
    if (!keepSel) v.sel = 0;
  } catch (e) {
    if (mine !== seq) return;
    S.rowsErr = message(e);
  } finally {
    if (mine === seq) S.rowsLoading = false;
  }
  render();
}

/** The next page, when the table is scrolled near its end. */
export async function loadMore() {
  const id = routeId();
  if (!id || S.rowsLoading || S.rows.length >= S.matched) return;
  const mine = ++seq;
  S.rowsLoading = true;
  const v = S.view;
  try {
    const page = await api.rows(id, { set: v.set, filter: v.filter, q: v.q, search: v.search, offset: S.rows.length, limit: PAGE });
    if (mine !== seq) return;
    S.rows = S.rows.concat(page.rows); S.total = page.total; S.matched = page.matched;
  } catch (e) {
    if (mine === seq) S.rowsErr = message(e);
  } finally {
    if (mine === seq) S.rowsLoading = false;
  }
  render();
}

export async function loadSettings() {
  try {
    S.settings = await api.settings();
    S.settingsErr = null;
    S.teacherKeys = {};
  } catch (e) {
    S.settingsErr = message(e);
  }
  render();
}

export async function loadTask() {
  const id = routeId();
  if (!id) return;
  try {
    const t = await api.task(id);
    S.task = { saved: t, draft: structuredClone(t) };
    S.taskErr = null;
    S.dirty = false;
  } catch (e) {
    S.taskErr = message(e);
  }
  render();
}

export async function loadPrompt() {
  const id = routeId();
  if (!id) return;
  try {
    S.prompt = await api.prompt(id);
    S.promptErr = null;
  } catch (e) {
    S.promptErr = message(e);
  }
  render();
}

export async function loadReport() {
  const id = routeId();
  if (!id) return;
  try {
    S.report = await api.report(id);
    S.reportErr = null;
  } catch (e) {
    S.reportErr = message(e);
  }
  render();
}

/* ---------------- Playground ---------------- */
export const pickKey = (p: PlayPick) => `${p.model}:${p.method}`;

/** The models it can use and what was there last time; the first visit starts with one model. */
export async function loadPlayground() {
  try {
    const { models, saved } = await api.playground();
    const P = S.play;
    P.models = models; P.err = null;
    if (!P.loaded) {
      P.loaded = true;
      const known = (p: PlayPick) => models.some(x => x.id === p.model && x.methods.some(y => y.id === p.method));
      P.picks = (saved?.picks ?? []).filter(known);
      P.docs = saved?.docs ?? [];
      if (!P.picks.length && models.length) P.picks = [{ model: models[0].id, method: models[0].methods[0].id }];
    }
  } catch (e) {
    S.play.err = message(e);
  }
  render();
  await answerPlayground();
}

/** Ask each picked method about the documents it hasn't answered yet. Local, so free. */
export async function answerPlayground() {
  const P = S.play;
  const todo = P.picks.map(p => ({ p, texts: P.docs.map(d => d.text).filter(t => !P.local[pickKey(p)]?.[t]) })).filter(x => x.texts.length);
  if (!todo.length) return;
  P.running = true;
  render();
  try {
    await Promise.all(todo.map(async ({ p, texts }) => {
      const out = await api.tryMany(p.model, texts, [p.method]);
      const cells = out.methods[p.method] ?? [];
      const into = (P.local[pickKey(p)] ??= {});
      texts.forEach((t, i) => { if (cells[i]) into[t] = cells[i]; });
    }));
  } catch (e) {
    toast(message(e));
  } finally {
    P.running = false;
    render();
  }
}

let saveTimer: number | undefined;
/** Keep what's typed and picked with the workspace, a moment after the last change. */
export function savePlayground() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void api.savePlayground(S.play.picks, S.play.docs).catch(() => undefined); }, 400);
}
