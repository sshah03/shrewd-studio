// A model's page: title bar with the next step, the toolbar, the table with Details, the status line.
import type { Filter, Model } from "../api";
import { S, compared, done, isPanel, reviewing, shipped, shownRows } from "../state";
import { esc, n } from "../util";
import { right } from "./details";
import { FILTERS, table, tableWindow } from "./table";

export function nextStep(m: Model): [string, string] | null {
  // a step already running isn't offered again; its progress shows in the title bar
  const running = (kind: string) => !!S.jobs?.now.some(j => j.model === m.id && j.kind === kind && j.state !== "paused");
  if (m.stage === "examples") return running("check") ? null : ["Check teachers…", "check"];
  if (m.stage === "checked" && !m.counts.pool) return ["Add documents…", "pool"];
  if (m.stage === "checked") return [`Label ${n(m.counts.pool)} documents…`, "label"];
  if (m.stage === "labeling") return m.paused ? ["Resume labeling…", "rounds"] : null;
  // after data changes, only the steps it made out of date, in order
  const c = m.changes;
  if (c?.unlabeled) return running("label") ? null : [`Label ${n(c.unlabeled)} more document${c.unlabeled === 1 ? "" : "s"}…`, "label"];
  if (c?.check) return running("check") ? null : ["Check teachers again…", "check"];
  if (m.relabel || c?.labels) return running("label") ? null : ["Label again…", "label"];
  if (m.counts.review) return [`Review ${n(m.counts.review)}`, "review"];
  const cmp = compared(m);
  if (!cmp.length) return running("compare") ? null : ["Compare methods", "compare"];
  // once one method is compared on the current data, shipping is next
  if (cmp.every(x => x.stale)) return running("compare") ? null : ["Compare again", "compare"];
  if (!shipped(m)) return running("ship") ? null : ["Ship…", "ship"];
  if (c?.shipped) return running("ship") ? null : ["Ship again…", "ship"];
  return null;
}

function header(m: Model) {
  const [label, act] = nextStep(m) ?? [];
  const meta = `${isPanel(m) ? `Decision panel, ${m.questions.length} questions` : `Classifier, ${m.questions[0]?.options.length ?? 0} labels`}. ${m.how}.`;
  const primary = label && !(act === "review" && reviewing());
  if (m.archived) return `<div class="head"><div><h1>${esc(m.name)}</h1><div class="meta">${esc(meta)}</div></div><div class="grow"></div>
    <button class="btn" data-pane="report">Report</button><button class="btn" data-pane="use">Use…</button>
    <button class="btn plain danger" data-act="delete-model-open">Delete…</button></div>`;
  // the next step comes first: the group is right-aligned, so Task, Prompt, Compare and Use stay
  // put while the next step appears, goes or changes its label
  return `<div class="head"><div><h1>${esc(m.name)}</h1><div class="meta">${esc(meta)}</div></div><div class="grow"></div>
    ${primary ? `<button class="btn next ${reviewing() ? "" : "default"}" data-act="${act}">${esc(label)}</button>` : ""}
    <button class="btn" data-pane="task">Task</button><button class="btn" data-pane="prompt">Prompt</button>
    <button class="btn" data-pane="compare">Compare…</button><button class="btn" data-pane="use">Use…</button></div>`;
}

function filters(m: Model): Filter[] {
  const fs: Filter[] = ["all"];
  if (m.counts.review) fs.push("needs");
  if (m.teachers.length > 1 && m.stage !== "examples") fs.push("disagree");
  if (m.stage !== "examples") fs.push("vsyou");
  if (done(m).length) fs.push("local");
  if (m.routing && !m.routing.off) fs.push("routed");
  if (!fs.includes(S.view.filter)) fs.push(S.view.filter);
  return fs;
}

function toolbar(m: Model) {
  const v = S.view;
  const sets: [string, string, number?][] = [["all", "All"], ["pool", "Pool", m.counts.pool], ["tuning", "Tuning", m.counts.tuning], ["test", "Test", m.counts.test]];
  const hidden = S.allMethods ? 0 : m.methods.filter(x => !x.shipped).length;
  const rt = m.routing;
  return `<div class="toolbar" role="toolbar" aria-label="Table view">
    <div class="scope" role="group" aria-label="Which documents">${sets.map(([k, l, c]) => `<button aria-pressed="${v.set === k}" data-set="${k}">${l}${c != null ? `<span class="c">${n(c)}</span>` : ""}</button>`).join("")}</div>
    ${isPanel(m) ? `<select data-q aria-label="Question"><option value="all" ${v.q === "all" ? "selected" : ""}>All questions</option>${m.questions.map((q, j) => `<option value="${j}" ${v.q === j ? "selected" : ""}>${esc(q.id)}</option>`).join("")}</select>` : ""}
    <select data-filter aria-label="Show rows">${filters(m).map(k => `<option value="${k}" ${v.filter === k ? "selected" : ""}>${FILTERS[k]}${k === "needs" ? ` (${n(m.counts.review)})` : ""}</option>`).join("")}</select>
    ${v.filter !== "all" ? `<span class="chip">${FILTERS[v.filter]}<button data-act="clear" aria-label="Clear filter">✕</button></span>` : ""}
    <input type="text" data-search placeholder="Search" style="width:140px" aria-label="Search documents" value="${esc(v.search)}">
    <div class="tools-right">
      ${rt && rt.curve.length ? `<label class="check" title="${rt.off ? "Ship again with teacher backup off to train on the whole pool." : "With teacher backup, the model run through shrewd sends documents it may get wrong to the teachers. The limit is the most it may disagree with them, guaranteed at 95% confidence."}">Teacher backup
        <select data-rb aria-label="Most the local model may disagree with the teachers"><option value="off" title="Ship again with teacher backup off to train on the whole pool." ${rt.off ? "selected" : ""}>Off, everything local</option>${rt.curve.map(([b, local], i) => `<option value="${i}" ${!rt.off && i === rt.selected ? "selected" : ""}>≤ ${b}%, ${local}% local</option>`).join("")}</select></label>` : ""}
      ${m.methods.length > 1 ? `<button class="btn" data-act="methods" title="Methods you compared but didn't ship">${S.allMethods ? "Hide compared" : "Show compared"}</button>${hidden ? `<span class="dim">${hidden} hidden</span>` : ""}` : ""}
      <button class="btn" data-act="insp" aria-pressed="${S.insp}">${S.insp ? "Hide details" : "Details"}</button>
    </div>
  </div>`;
}

/** The status line's count, or once the table is scrolled, which rows are on screen. */
export function statusLead(m: Model) {
  const r = tableWindow.range;
  const need = m.counts.review ? `, ${n(m.counts.review)} need you` : "";
  if (r && r[0] > 0) return `Rows ${n(r[0] + 1)}–${n(r[1] + 1)} of ${n(S.matched)}${S.matched < S.total ? ` (${n(S.total)} in all)` : ""}${need}`;
  return `${n(S.matched)} of ${n(S.total)} shown${need}`;
}

function status(m: Model) {
  return `<div class="status" role="status"><span class="lead" aria-live="off">${statusLead(m)}</span><div class="grow"></div>
    <span class="a differ"><span class="g">✕</span>differs from you</span>${m.teachers.length > 1 || m.methods.length ? '<span class="a disagree"><span class="g">≠</span>differs from the teachers</span>' : ""}${m.routing && !m.routing.off ? '<span class="a routed" title="With teacher backup, when the model runs through shrewd"><span class="g">↗</span>sent to teachers by backup</span>' : ""}</div>`;
}

export function modelPage(m: Model) {
  const rows = shownRows();
  if (S.view.sel >= rows.length) S.view.sel = Math.max(0, rows.length - 1);
  const work = `<div class="work ${S.insp ? "" : "noinsp"}"><div class="tablebox" data-keep-scroll="table">${table(m, rows)}</div>${S.insp ? right(m, rows[S.view.sel]) : ""}</div>`;
  if (m.archived) return header(m) + `<div class="toolbar archived-note"><span>Archived: only the shipped model and what teacher backup needs are kept. Try a document below, or use it from Python or on a CSV.</span></div>` + work + status(m);
  return header(m) + toolbar(m) + work + status(m);
}
