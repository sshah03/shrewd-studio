// The model's table: Document, You, each teacher, Combined, each method. Rows are grouped by set
// (pool, tuning, test); typed-in documents come last, then the "Try a document…" row.
import { A, combinedJudged, fmtP, judge, needsYou, teacherNote, youVal } from "../answers";
import type { Method, Model, Row, Teacher } from "../api";
import { jobFor } from "../jobs";
import { S, perK, qIdx } from "../state";
import { approx, esc, methodSize, n, pctOf, SHIPPED_TAG } from "../util";

export const FILTERS = { all: "All rows", needs: "Needs you", disagree: "Teachers disagree", vsyou: "Teachers differ from you", local: "Local model differs", routed: "Sent to teachers by backup" } as const;

export const shownMethods = (m: Model) => (S.allMethods ? m.methods : m.methods.filter(x => x.shipped));
const colsAfter = (m: Model) => m.teachers.length + (m.combine ? 1 : 0) + shownMethods(m).length;

/** Scores under a column name; `who` names what matched, for the hover text. */
// one question's score under the column name; with every question shown there's no room for
// several, so they go in the column name's tooltip instead (scoresTip)
const scoreLine = (m: Model, vals: number[], who?: string) => {
  const qi = qIdx(m);
  if (qi.length > 1) return "";
  const j = qi[0];
  const tip = who && vals[j] != null
    ? ` title="${esc(`${who} matched your answer on ${vals[j]}% of your ${n(m.counts.tuning)} tuning examples`)}"` : "";
  return `<div class="score"><span${tip}>${vals[j] ?? "–"}%</span></div>`;
};
const scoresTip = (m: Model, vals: number[] | null) =>
  qIdx(m).length > 1 && vals ? `, on your tuning examples: ${m.questions.map((q, j) => `${q.id} ${vals[j] ?? "–"}%`).join(", ")}` : "";
const colhead = (label: string, col: string, title?: string) =>
  `<button data-col="${esc(col)}" aria-haspopup="menu" title="${esc(title || label)}">${esc(label)}<span class="chev" aria-hidden="true">▾</span></button>`;

function thTeacher(m: Model, t: Teacher, ti: number) {
  const body = m.stage === "examples" || !t.accuracy ? '<div class="sub">not checked</div>'
    : scoreLine(m, t.accuracy, t.short) + (m.escalate && ti > 0 ? `<div class="sub">asked on ${m.escalate.share}%</div>` : "");
  return `<th scope="col" class="${ti === 0 ? "grp gs" : ""}" data-ck="t${ti}"><div class="colname">${colhead(t.short, `t${ti}`, t.name + scoresTip(m, t.accuracy))}</div>${body}${RZ(`t${ti}`)}</th>`;
}

function methodBody(m: Model, x: Method) {
  const job = jobFor(x.job);
  const qi = qIdx(m);
  if (x.state === "running" || x.state === "paused") {
    const note = x.state === "paused" ? "paused" : job?.message ?? x.note ?? "training";
    return `<span class="colprog ${x.state === "paused" ? "paused" : ""}" role="progressbar" aria-label="${esc(x.name)} progress" aria-valuenow="${pctOf(job?.progress ?? x.progress)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pctOf(job?.progress ?? x.progress)}%"></i></span><div class="sub">${esc(note)}</div>`;
  }
  if (x.state === "queued") return `<div class="sub">${esc(job?.message ?? x.note ?? "waiting")}</div>`;
  // the same tuning examples as the teachers' scores, so columns compare; speed, size and the
  // test score live in the Compare drawer
  const tip = [x.test ? `Test ${qi.map(j => `${x.test![j]}%`).join(" ")}` : "", x.ms != null ? `${x.ms} ms per document` : "", methodSize(x)?.text ?? ""].filter(Boolean).join(", ");
  return x.dev ? `<div title="On your tuning examples${tip ? `. ${esc(tip)}` : ""}">${scoreLine(m, x.dev)}</div>` : "";
}

function thMethod(m: Model, x: Method, k: number) {
  const sort = S.view.sort?.col === x.id ? `aria-sort="${S.view.sort.dir > 0 ? "ascending" : "descending"}"` : "";
  return `<th scope="col" class="${k === 0 ? "grp gs" : ""}" data-mcol="${esc(x.id)}" data-ck="m:${esc(x.id)}" ${sort}><div class="colname">${colhead(x.name, `m:${x.id}`)}${x.shipped ? SHIPPED_TAG : ""}</div>${methodBody(m, x)}${RZ(`m:${x.id}`)}</th>`;
}

/** A drag handle on a header's right edge; double-click puts the column back to its default. */
const RZ = (key: string) => `<span class="rz" data-rz="${esc(key)}" title="Drag to resize, double-click to reset" aria-hidden="true"></span>`;

/** The keys of the columns in order, matching thead(). */
export function columnKeys(m: Model) {
  return ["doc", "you", ...m.teachers.map((_, ti) => `t${ti}`), ...(m.combine ? ["comb"] : []), ...shownMethods(m).map(x => `m:${x.id}`)];
}

/** The dragged widths as CSS: header and body cells of a column share the width, and the pinned
 * You column moves with the Document column. */
export function columnCss(m: Model, widths: Record<string, number> = S.colW[m.id] ?? {}) {
  const keys = columnKeys(m);
  const rules = keys.map((k, i) => {
    const w = widths[k];
    if (!w) return "";
    return `.t tr > :nth-child(${i + 1}):not([colspan]) { width: ${w}px; min-width: ${w}px; max-width: ${w}px; overflow: hidden; text-overflow: ellipsis; }`;
  }).join("\n");
  const doc = widths.doc;
  return `${rules}${doc ? `\n.t .you { left: ${doc}px; }` : ""}`;
}

export function thead(m: Model) {
  const comb = m.combine ? `<th scope="col" class="grp" data-ck="comb"><div class="colname" title="${m.combine === "weighted" ? "Weighted by accuracy on your labels" : "Majority vote; the first teacher breaks ties"}">Combined</div>${m.combined_accuracy ? scoreLine(m, m.combined_accuracy, "The combined answer") : ""}${RZ("comb")}</th>` : "";
  // a band over the columns that belong together: the teachers' answers (and their combination),
  // then the local models trained from them
  const nT = m.teachers.length + (m.combine ? 1 : 0), nM = shownMethods(m).length;
  const bands = `<tr class="bands"><th colspan="2" class="lead"></th>
    <th colspan="${nT}" class="gs" scope="colgroup">${m.teachers.length === 1 && !m.combine ? "Teacher" : "Teachers"}</th>
    ${nM ? `<th colspan="${nM}" class="gs" scope="colgroup" title="Small models trained on the teachers' answers; they run on this computer">Local model${nM === 1 ? "" : "s"}</th>` : ""}</tr>`;
  return `<thead>${bands}<tr>
    <th scope="col" class="doc" data-ck="doc"><div class="colname">Document</div>${RZ("doc")}</th><th scope="col" class="you" data-ck="you"><div class="colname">You</div>${RZ("you")}</th>
    ${m.teachers.map((t, ti) => thTeacher(m, t, ti)).join("")}${comb}
    ${shownMethods(m).map((x, k) => thMethod(m, x, k)).join("")}</tr></thead>`;
}

function teacherCell(m: Model, r: Row, ti: number) {
  const cls = ti === 0 ? "grp gs" : "";
  const t = r.teachers[ti];
  const st = t?.state ?? "none";
  const td = (inner: string) => `<td class="${cls}" role="gridcell">${inner}</td>`;
  if (st === "locked") return td(A("none", "locked"));
  if (st === "notasked") return td(A("none", "not asked"));
  if (st === "ask") return td(ti === 0 ? `<button class="btn" data-ask="${esc(r.key)}">Ask teachers${perK(m) == null ? "" : `, ${approx(perK(m)! / 1000)}`}</button>` : "");
  if (st !== "ok") return td(A("none", "–"));
  return td(qIdx(m).map(j => {
    const v = t.answers[j] ?? null;
    return v == null ? A("none", "–") : A(judge(m, r, j, v, true), v, teacherNote(m, r, ti, j));
  }).join(""));
}

function combinedCell(m: Model, r: Row) {
  const qi = qIdx(m);
  const vals = qi.map(j => r.combined?.[j] ?? null);
  if (vals.every(v => v == null)) return `<td class="grp" role="gridcell">${A("none", r.set === "test" && !m.final_tests ? "locked" : "–")}</td>`;
  return `<td class="grp" role="gridcell">${vals.map((v, k) =>
    v == null ? A("none", "–") : A(combinedJudged(m, r, qi[k], v), v)).join("")}</td>`;
}

function methodCell(m: Model, r: Row, x: Method, k: number) {
  const cls = k === 0 ? "grp gs" : "";
  const a = r.methods[x.id];
  const st = a?.state ?? (x.state === "done" ? "none" : x.state);
  if (st === "locked") return `<td class="${cls}" role="gridcell">${A("none", "locked")}</td>`;
  if (st !== "ok" || !a) return `<td class="${cls}" role="gridcell">${A("none", st === "running" ? "…" : "")}</td>`;
  return `<td class="${cls}" role="gridcell">${qIdx(m).map(j => {
    const v = a.answers[j] ?? null;
    if (v == null) return A("none", "–");
    return A(a.routed ? "routed" : r.set === "try" ? "mine" : judge(m, r, j, v, false), v, fmtP(a.p?.[j]));
  }).join("")}</td>`;
}

export function rowHtml(m: Model, r: Row, i: number) {
  const nd = needsYou(r);
  const you = qIdx(m).map(j => youVal(r, j));
  const youCell = nd ? `<td class="you needscell" role="gridcell">?<span class="sr"> needs you</span></td>`
    : `<td class="you" role="gridcell">${you.every(v => v == null) ? A("none", r.set === "try" ? "" : "–") : you.map(v => A(v == null ? "none" : "mine", v ?? "–")).join("")}</td>`;
  const sel = i === S.view.sel;
  return `<tr class="r" role="row" data-row="${i}" aria-rowindex="${i + 1}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}">
      <td class="doc" role="rowheader"><span class="tx" title="${esc(r.text)}">${esc(r.text)}</span>${nd ? `<span class="why">${esc(r.needs)}</span>` : ""}</td>${youCell}${m.teachers.map((_, ti) => teacherCell(m, r, ti)).join("")}${m.combine ? combinedCell(m, r) : ""}${shownMethods(m).map((x, k) => methodCell(m, r, x, k)).join("")}</tr>`;
}

const LABEL = { pool: "Pool", tuning: "Tuning", test: "Test" } as const;
function groupRow(m: Model, set: "pool" | "tuning" | "test") {
  const c = m.counts;
  const note = set === "test" ? `${n(c.test)}, ${m.final_tests ? `${m.final_tests} final test${m.final_tests > 1 ? "s" : ""}` : "locked until a model ships"}` : n(c[set]);
  return `<tr class="group"><td class="doc">${LABEL[set]}<span class="dim">${note}</span></td><td class="you"></td><td colspan="${colsAfter(m)}"></td></tr>`;
}

function emptyRow(m: Model) {
  const span = 2 + colsAfter(m);
  const v = S.view;
  const body = S.rowsErr ? `<span class="err">${esc(S.rowsErr)}</span> <button class="btn" data-act="reload-rows">Try again</button>`
    : S.rowsLoading ? "Loading…"
    : v.search ? `No documents match “${esc(v.search)}”. <button class="btn" data-act="clear-search">Clear search</button>`
    : v.filter !== "all" ? `No rows match “${FILTERS[v.filter]}”. <button class="btn" data-act="clear">Clear filter</button>`
    : m.archived ? "The documents went with the rest of the model. Type one in below to see what the shipped model says."
    : v.set === "pool" ? `No documents in the pool yet. Teachers label these, and the local model learns from them. <button class="btn" data-act="pool">Add documents…</button>`
    : "Nothing here yet.";
  return `<tr><td class="emptyrow" colspan="${span}">${body}</td></tr>`;
}

/** Past WINDOWED rows, only the rows near the visible part of the table are on the page, with
 * spacer rows of the same height for the rest: a page holding thousands of rows is slow to
 * redraw and to scroll. BUFFER rows are kept on each side of what's visible. */
const WINDOWED = 400, BUFFER = 40;
export const tableWindow = { top: 0, height: 1200, rowH: 0, groupH: 0, start: 0, end: 0, on: false, groups: [] as number[], twoLine: false,
  range: null as [number, number] | null };

const rowHeight = () => tableWindow.rowH || (S.twoLine ? 53 : 37);
const groupHeight = () => tableWindow.groupH || 30;
const groupsBefore = (i: number) => tableWindow.groups.filter(g => g < i).length;

/** Where row i's line starts, in pixels from the top of the table body. */
export function rowTop(i: number) {
  return i * rowHeight() + (groupsBefore(i + 1)) * groupHeight();
}

function rowsHtml(m: Model, rows: Row[], from: number, to: number) {
  let last: string | null = from > 0 ? rows[from - 1].set : null;
  let html = "";
  for (let i = from; i < to; i++) {
    const r = rows[i];
    if (S.view.set === "all" && r.set !== last && r.set !== "try") { last = r.set; html += groupRow(m, r.set); }
    html += rowHtml(m, r, i);
  }
  return html;
}

function spacer(m: Model, px: number) {
  return px > 0 ? `<tr class="spacer" aria-hidden="true"><td colspan="${2 + colsAfter(m)}" style="height:${Math.round(px)}px"></td></tr>` : "";
}

function windowedRows(m: Model, rows: Row[]) {
  const n = rows.length, w = tableWindow;
  if (w.twoLine !== S.twoLine) { w.twoLine = S.twoLine; w.rowH = 0; }
  w.on = n > WINDOWED;
  if (!w.on) { w.start = 0; w.end = n; return rowsHtml(m, rows, 0, n); }
  w.groups = [];
  if (S.view.set === "all") rows.forEach((r, i) => { if (r.set !== "try" && (i === 0 || rows[i - 1].set !== r.set)) w.groups.push(i); });
  const row = rowHeight(), total = n * row + w.groups.length * groupHeight();
  const top = Math.max(0, Math.min(w.top, total - w.height));
  w.start = Math.max(0, Math.floor(top / row) - BUFFER);
  w.end = Math.min(n, Math.ceil((top + w.height) / row) + BUFFER);
  const above = w.start * row + groupsBefore(w.start) * groupHeight();
  const below = total - (w.end * row + groupsBefore(w.end) * groupHeight());
  return spacer(m, above) + rowsHtml(m, rows, w.start, w.end) + spacer(m, below);
}

/** Everything inside the table body: the rows on the page, then the closing rows. */
export function tbodyHtml(m: Model, rows: Row[]) {
  const loaded = S.rows.length;
  const more = loaded && loaded < S.matched ? `<tr class="more"><td class="doc" colspan="${2 + colsAfter(m)}">${S.rowsErr ? `<span class="err">${esc(S.rowsErr)}</span>` : `Showing ${n(loaded)} of ${n(S.matched)}, scroll for more`}</td></tr>` : "";
  const empty = !rows.length ? emptyRow(m) : "";
  // type or paste a document: trained methods answer it for free, and you can answer it and
  // keep it as an example or add it to the pool
  // only where typed rows show (state.ts shownRows): all rows, no search
  const tryRow = !m.archived && S.view.filter === "all" && !S.view.search ? `<tr class="trow"><td class="doc"><input id="try" placeholder="Type or paste a document…" aria-label="Type or paste a document" title="Enter adds it here. Trained methods answer it for free; answer it yourself to keep it as an example, or add it to the documents."></td><td class="you"></td><td colspan="${colsAfter(m)}"></td></tr>` : "";
  return windowedRows(m, rows) + more + empty + tryRow;
}

export function table(m: Model, rows: Row[]) {
  const box = document.querySelector<HTMLElement>(".tablebox");
  if (box) { tableWindow.top = box.scrollTop; tableWindow.height = box.clientHeight || tableWindow.height; }
  const body = tbodyHtml(m, rows);
  const loaded = S.rows.length;
  return `<style id="colw">${columnCss(m)}</style><table class="t ${S.twoLine ? "two" : ""}" role="grid" aria-label="${esc(m.name)} documents" aria-rowcount="${S.matched + (rows.length - loaded)}">${thead(m)}<tbody>${body}</tbody></table>`;
}

