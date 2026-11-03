// Shrewd Studio frontend. render() draws the sidebar, page and layer from S; clicks, changes,
// typing and keys are handled here by delegation on data-* attributes and passed to actions.ts.
import { askTeachers, closeFind, inspectFolder, playRun, closePane, closeSheet, sheetImpact, fileChosen, jobCmd, markDirty, openPane, openSheet, pick, promptBudget, runAct, saveAndNext, select, settingChanged, taskField, tryText } from "./actions";
import { api, setTransport, type Filter } from "./api";
import { answerPlayground, loadModels, loadMore, loadPlayground, loadRows, loadSettings, openModel, refreshModels, savePlayground } from "./data";
import { pollJobs } from "./jobs";
import { render, renderDetails, renderLayer, renderTitlebar, scrolledTable } from "./render";
import { navigate, parse, replace } from "./router";
import { columnCss } from "./views/table";
import { wizardProblem, wizardStarted } from "./views/newmodel";
import { S, activeQ, currentRow, firstFlagged, isPanel, shownRows, type Pane } from "./state";
import { message, toast } from "./util";
import { system } from "./system";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/* ---------------- routing ---------------- */
function route() {
  const r = parse(location.hash);
  const prevId = S.route.page === "model" ? S.route.id : null;
  S.route = r;
  S.menu = null;
  if (r.page === "home" && S.models?.length) { goHome(); return; }
  if (r.page === "model") { if (r.id !== prevId || !S.model) void openModel(r.id); else render(); }
  else {
    S.pane = null;
    S.sheet = S.sheet?.kind === "new" ? S.sheet : null;
    if (r.page === "settings") void loadSettings();
    if (r.page === "jobs") pollJobs();
    if (r.page === "playground") void loadPlayground();
    render();
  }
}

function goHome() {
  const first = S.models?.[0];
  if (!first) { render(); return; }
  const to = `#/m/${encodeURIComponent(first.id)}`;
  replace(to);
  route();
}

/* ---------------- clicks ---------------- */
document.addEventListener("click", e => {
  const target = e.target as HTMLElement;
  if (S.find.open && !target.closest(".tb-find")) { S.find.open = false; renderTitlebar(); }
  if (S.menu && !target.closest(".menu")) {
    const was = S.menu.col;
    S.menu = null;
    const c = target.closest<HTMLElement>("[data-col]");
    if (!c || c.dataset.col === was) { renderLayer(); return; }
  }
  if (target.dataset.close === "pane") { closePane(); return; }
  if (target.dataset.close === "sheet") { closeSheet(); return; }
  if (target.dataset.close === "wizard") { if (S.wizard && !wizardStarted(S.wizard)) { S.wizard = null; render(); } return; }
  if (target.dataset.close === "guide") { S.guide = null; render(); return; }
  const el = target.closest<HTMLElement>("[data-act],[data-model],[data-set],[data-pane],[data-pick],[data-col],[data-ask],button[data-theme],[data-lines],[data-job-act],[data-key],[data-unkey],[data-unendpoint],[data-copy],[data-row]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  const d = el.dataset;
  if (d.act) void runAct(d.act, el);
  else if (d.model) navigate(`#/m/${encodeURIComponent(d.model)}`);
  else if (d.set) { S.view.set = d.set as typeof S.view.set; S.view.sel = 0; render(); void loadRows(); }
  else if (d.pane) openPane(d.pane as Pane);
  else if (d.pick) { const [j, k] = d.pick.split(":").map(Number); pick(j, k); }
  else if (d.col) openMenu(el, d.col);
  else if (d.ask) void askTeachers(d.ask).catch(err => toast(message(err)));
  else if (d.theme !== undefined) setTheme(d.theme);
  else if (d.lines) { S.twoLine = d.lines === "2"; store("studio.rows", d.lines); render(); }
  else if (d.jobAct) void jobCmd(d.jobAct as "pause" | "resume" | "cancel", d.job ?? null);
  else if (d.key) openSheet({ kind: "key", variable: d.key, provider: d.provider ?? d.key });
  else if (d.unkey) openSheet({ kind: "remove-key", variable: d.unkey });
  else if (d.unendpoint) openSheet({ kind: "remove-endpoint", which: d.unendpoint as "ollama" | "openai_compatible" });
  else if (d.copy) void navigator.clipboard?.writeText(d.copy).then(() => toast("Copied."), () => toast(d.copy!));
  else if (d.row && !target.closest("input,button,a")) select(+d.row);
});

function openMenu(el: HTMLElement, col: string) {
  const r = el.getBoundingClientRect(), b = $("main").getBoundingClientRect();
  S.menu = { col, x: Math.max(8, Math.min(r.left - b.left, b.width - 240)), y: r.bottom - b.top + 2 };
  renderLayer();
  document.querySelector<HTMLElement>(".menu button")?.focus();
}

const store = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage blocked */ } };
function setTheme(t: string) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  store("studio.theme", t);
  render();
}

/* ---------------- changes and typing ---------------- */
document.addEventListener("change", e => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  const v = S.view;
  if (t.matches("[data-q]")) { v.q = t.value === "all" ? "all" : +t.value; v.aq = v.q === "all" ? 0 : v.q; v.aqFor = currentRow()?.key ?? null; render(); void loadRows(); }
  else if (t.matches("[data-filter]")) { v.filter = t.value as Filter; v.sel = 0; render(); void loadRows(); }
  else if (t.matches("[data-rb]")) void rebudget(t.value === "off" ? null : +t.value);
  else if (t.matches("[data-cp]") && S.comparePick) { S.comparePick[t.dataset.cp!] = (t as HTMLInputElement).checked; renderLayer(); }
  else if (t.matches("select[data-tf], select[data-tq]")) taskField(t);
  else if (t.matches("[data-setting], [data-price]")) void settingChanged(t);
  else if (t.matches("[data-sheet]") && S.sheet) sheetField(t);
  else if (t.matches("[data-play-method]")) {
    const p = S.play.picks[Number(t.dataset.playMethod)];
    if (p) { p.method = t.value; savePlayground(); render(); void answerPlayground(); }
  } else if (t.matches("[data-play-add]") && t.value) {
    const m = S.play.models?.find(x => x.id === t.value);
    if (m) { S.play.picks.push({ model: m.id, method: m.methods[0].id }); savePlayground(); render(); void answerPlayground(); }
  }
  else if (t.matches("select[data-wz]") && S.wizard) wizField(t);   // text fields are kept as typed, on input
  else if (t.matches("[data-map]")) mapField(t);
});

/** A New model field: kept in S.wizard as typed; the step redraws only when its shape changes. */
function wizField(t: HTMLInputElement | HTMLSelectElement) {
  const w = S.wizard!;
  const [f, i] = t.dataset.wz!.split(":");
  const k = Number(i), v = t.value;
  if (f === "name") w.name = v;
  else if (f === "instructions") w.instructions = v;
  else if (f === "label-name") w.labels[k].name = v;
  else if (f === "label-desc") w.labels[k].description = v;
  else if (f === "q-id") w.questions[k].id = v.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
  else if (f === "q-text") w.questions[k].text = v;
  else if (f === "q-options") w.questions[k].options = v.split(",").map(o => o.trim()).filter(Boolean);
  else if (f === "q-type") { w.questions[k].type = v as "choice" | "yes/no" | "score"; renderLayer(); return; }
  w.err = null;
  const foot = document.querySelector(".wiz .foot");
  if (foot) {   // refresh only the footer, so the caret stays where it is
    const problem = wizardProblem(w);
    const next = foot.querySelector<HTMLButtonElement>("[data-act=wiz-next], [data-act=wiz-create]");
    if (next) next.disabled = !!problem;
    const msg = foot.querySelector(".wiz-problem");
    if (msg) msg.textContent = problem ?? ""; else if (problem) foot.insertAdjacentHTML("afterbegin", `<span class="wiz-problem">${problem}</span>`);
  }
}

/** A column choice in an import (New model's data step, or the import sheet). */
function mapField(t: HTMLInputElement | HTMLSelectElement) {
  const [scope, target] = t.dataset.map!.split(":");
  const pick = scope === "import" && S.sheet?.kind === "import" ? S.sheet.pick
    : scope === "examples" ? S.wizard?.examples : scope === "pool" ? S.wizard?.pool : null;
  if (!pick) return;
  if (t.value) pick.map[target] = t.value; else delete pick.map[target];
  renderLayer();
}

/** A field inside the remove or merge sheet changed. */
function sheetField(t: HTMLInputElement | HTMLSelectElement) {
  const s = S.sheet!, f = t.dataset.sheet!;
  if (s.kind === "delete-model") {
    if (f === "keep") s.keep = t.value === "1";
  } else if (s.kind === "folder") {
    if (f === "path" && t.value.trim() !== s.path) { s.path = t.value.trim(); void inspectFolder(); return; }
    if (f === "move") s.move = t.value === "1";
  } else if (s.kind === "routing") {
    if (f === "pick") s.pick = +t.value;
  } else if (s.kind === "export") {
    if (f === "format") s.format = t.value as typeof s.format;
    if (f === "half") s.half = (t as HTMLInputElement).checked;
    s.done = null; s.err = null;
  } else if (s.kind === "remove-label") {
    if (f === "mode") s.mode = t.value as "merge" | "drop";
    if (f === "into") s.into = t.value;
  } else if (s.kind === "merge-option") {
    if (f === "from") {
      s.from = t.value;
      const q = (S.task?.saved.questions ?? []).find(x => x.id === s.question);
      if (s.into === s.from) s.into = q?.options.find(o => o !== s.from) ?? "";
      s.impact = null;
      sheetImpact();
    }
    if (f === "into") s.into = t.value;
  }
  renderLayer();
}

async function rebudget(i: number | null) {
  const m = S.model;
  const b = i == null ? null : m?.routing?.curve[i]?.[0];
  if (!m?.routing || (i != null && b == null)) return;
  try {
    if (i == null) await api.routeOff(m.id); else await api.route(m.id, b!);
    m.routing.off = i == null;
    if (i != null) m.routing.selected = i;
    render();
    void loadRows(true);
  } catch (e) { toast(message(e)); render(); }
}

let searchTimer: number | undefined;
let findTimer = 0;
document.addEventListener("input", e => {
  const t = e.target as HTMLInputElement;
  if (t.id === "find") {
    window.clearTimeout(findTimer);
    const q = t.value;
    S.find.q = q;
    if (!q.trim()) { S.find.open = false; S.find.results = null; renderTitlebar(); return; }
    findTimer = window.setTimeout(async () => {
      try {
        const results = await api.search(q.trim());
        if (S.find.q === q) { S.find.results = results; S.find.open = true; renderTitlebar(); }
      } catch (err) { toast(message(err)); }
    }, 200);
    return;
  }
  if (t.matches("[data-wz]") && S.wizard) { wizField(t); return; }
  if (t.matches("[data-search]")) {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { S.view.search = t.value.trim(); S.view.sel = 0; void loadRows(); }, 250);
  } else if (t.matches("input[data-tf], textarea[data-tf], input[data-tl-name], input[data-tl-desc], input[data-tq]")) taskField(t);
  else if (t.matches("[data-prompt-budget]")) promptBudget(t.value);
  else if (t.closest(".drawer") && S.pane === "task" && t.matches("textarea")) markDirty();
});

$("file-pick").addEventListener("change", e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) fileChosen(f);
});

// Load the next page when the table is scrolled near its end.
document.addEventListener("scroll", e => {
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLElement) || !t.classList.contains("tablebox")) return;
  scrolledTable(t);
  if (t.scrollTop + t.clientHeight > t.scrollHeight - 600) void loadMore();
}, true);

/* ---------------- keyboard ---------------- */
function trapTab(e: KeyboardEvent) {
  const box = document.querySelector<HTMLElement>(S.sheet ? ".sheet" : S.pane ? ".drawer" : "");
  if (!box) return;
  const items = [...box.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')];
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (!box.contains(document.activeElement)) { first.focus(); e.preventDefault(); }
  else if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
}

document.addEventListener("keydown", e => {
  const t = e.target as HTMLElement;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); document.getElementById("find")?.focus(); return; }
  if (t.id === "find") {
    if (e.key === "Escape") { closeFind(); renderTitlebar(); (t as HTMLInputElement).blur(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); document.querySelector<HTMLElement>(".find-pop button")?.focus(); }
    else if (e.key === "Enter") { e.preventDefault(); document.querySelector<HTMLElement>(".find-pop button")?.click(); }
    return;
  }
  if (t.closest?.(".find-pop") && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Escape")) {
    e.preventDefault();
    if (e.key === "Escape") { closeFind(); renderTitlebar(); document.getElementById("find")?.focus(); return; }
    const items = [...document.querySelectorAll<HTMLElement>(".find-pop button")];
    const i = items.indexOf(t);
    (e.key === "ArrowDown" ? items[i + 1] : items[i - 1] ?? document.getElementById("find"))?.focus();
    return;
  }
  if (e.key === "Escape" && (S.wizard || S.guide) && !S.sheet) { S.wizard = null; S.guide = null; render(); return; }
  if (e.key === "Escape") {
    if (S.menu) { const col = S.menu.col; S.menu = null; renderLayer(); document.querySelector<HTMLElement>(`[data-col="${CSS.escape(col)}"]`)?.focus(); }
    else if (S.sheet) closeSheet();
    else if (S.pane) closePane();
    return;
  }
  if (e.key === "Tab" && (S.sheet || S.pane)) { trapTab(e); return; }
  if (S.menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    const items = [...document.querySelectorAll<HTMLElement>(".menu button")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    e.preventDefault();
    return;
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && t.id === "play-text") {
    e.preventDefault();
    void playRun().catch(err => toast(message(err)));
    return;
  }
  if (e.key === "Enter" && t.id === "try") {
    const text = (t as HTMLInputElement).value.trim();
    if (text) void tryText(text).catch(err => toast(message(err)));
    return;
  }
  if (e.key === "Enter" && t.id === "wz-teacher") {
    void runAct("wiz-add", t.nextElementSibling as HTMLElement).then(() => document.getElementById("wz-teacher")?.focus());
    return;
  }
  if (e.key === "Enter" && t.id === "new-teacher") { void runAct("add-teacher", t); return; }
  if (e.key === "Enter" && t.id === "key-value") { void runAct("save-key", t); return; }
  if (e.key === "Enter" && t.id === "def-teacher") { void runAct("def-teacher-add", t); return; }
  const inGrid = !!t.closest?.(".t tr.r");
  if (S.sheet || S.menu || S.route.page !== "model" || S.pane || !S.model || (!inGrid && t.matches("input,textarea,select,button,a"))) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  gridKey(e);
});

function gridKey(e: KeyboardEvent) {
  const m = S.model!;
  const rows = shownRows();
  const r = currentRow();
  const move = (to: number) => { e.preventDefault(); select(to); };
  if (e.key === "ArrowDown") move(S.view.sel + 1);
  else if (e.key === "ArrowUp") move(S.view.sel - 1);
  else if (e.key === "PageDown") move(S.view.sel + 10);
  else if (e.key === "PageUp") move(S.view.sel - 10);
  else if (e.key === "Home") move(0);
  else if (e.key === "End") move(rows.length - 1);
  else if ((e.key === "]" || e.key === "[") && isPanel(m)) {
    S.view.aq = (activeQ(m, r) + (e.key === "]" ? 1 : m.questions.length - 1)) % m.questions.length;
    S.gridFocus = true;
    pickRefresh();
  } else if (e.key === "Enter") { e.preventDefault(); void saveAndNext(); }
  else if (/^[1-9]$/.test(e.key) && r) {
    const j = isPanel(m) ? activeQ(m, r) : 0, k = +e.key - 1;
    if (k < m.questions[j].options.length) {
      e.preventDefault();
      pick(j, k);
      // on to the next question this row is queued for, else simply the next one
      const next = isPanel(m) ? firstFlagged(m, r, j) ?? (j < m.questions.length - 1 ? j + 1 : null) : null;
      if (next != null) { S.view.aq = next; pickRefresh(); }
    }
  }
}

const pickRefresh = () => renderDetails();

/* ---------------- column widths ---------------- */
let drag: { key: string; startX: number; startW: number; widths: Record<string, number> } | null = null;
const saveWidths = (id: string, widths: Record<string, number>) => {
  S.colW[id] = widths;
  try { localStorage.setItem(`studio.cols.${id}`, JSON.stringify(widths)); } catch { /* storage blocked */ }
};
const applyWidths = (widths: Record<string, number>) => {
  const style = document.getElementById("colw");
  if (style && S.model) style.textContent = columnCss(S.model, widths);
};
document.addEventListener("mousedown", e => {
  const rz = (e.target as HTMLElement).closest<HTMLElement>("[data-rz]");
  if (!rz || !S.model || e.button !== 0) return;
  e.preventDefault();
  const th = rz.closest("th")!;
  drag = { key: rz.dataset.rz!, startX: e.clientX, startW: th.getBoundingClientRect().width, widths: { ...(S.colW[S.model.id] ?? {}) } };
  document.body.classList.add("resizing");
});
document.addEventListener("mousemove", e => {
  if (!drag) return;
  const min = drag.key === "doc" ? 160 : 64;
  drag.widths[drag.key] = Math.round(Math.min(900, Math.max(min, drag.startW + e.clientX - drag.startX)));
  applyWidths(drag.widths);
});
document.addEventListener("mouseup", () => {
  if (!drag || !S.model) return;
  saveWidths(S.model.id, drag.widths);
  drag = null;
  document.body.classList.remove("resizing");
});
document.addEventListener("dblclick", e => {
  const rz = (e.target as HTMLElement).closest<HTMLElement>("[data-rz]");
  if (!rz || !S.model) return;
  const widths = { ...(S.colW[S.model.id] ?? {}) };
  delete widths[rz.dataset.rz!];
  saveWidths(S.model.id, widths);
  applyWidths(widths);
});

window.addEventListener("hashchange", route);
// coming back to the window: catch up on jobs and models changed elsewhere (shrewd from Python,
// or another window)
window.addEventListener("focus", () => { pollJobs(); void refreshModels(); });

/* ---------------- start ---------------- */
/** Inside the desktop app the window draws the frame; on macOS the traffic lights sit over the title bar. */
function markDesktop() {
  let desktop = new URLSearchParams(location.search).has("desktop");
  try { if (desktop) sessionStorage.setItem("desktop", "1"); else desktop = sessionStorage.getItem("desktop") === "1"; } catch { /* storage blocked */ }
  document.documentElement.classList.toggle("desktop", desktop);
  document.documentElement.classList.toggle("mac", system().os === "mac");
}

async function start() {
  markDesktop();
  const fixtures = new URLSearchParams(location.search).get("fixtures");
  if ((import.meta.env.DEV || import.meta.env.MODE === "fixtures") && fixtures !== null) {
    const { fixtureTransport } = await import("./fixtures");
    setTransport(fixtureTransport({ big: fixtures === "big" }));
  }
  S.route = parse(location.hash);
  render();
  pollJobs();
  await loadModels();
  if (!S.settings) void loadSettings();   // the title bar says when this is the sandbox
  if (S.route.page === "home") goHome(); else route();
}
void start();
