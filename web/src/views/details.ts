// The Details column: the selected document, every answer to each question, and your answer.
import { fmtP, needsYou, teacherNote, youVal } from "../answers";
import type { Model, Row } from "../api";
import { S, activeQ, isPanel, reviewing } from "../state";
import { esc } from "../util";

export const paneWrap = (inner: string, foot = "", keep = "pane") =>
  `<div class="pane" data-keep-scroll="${keep}">${inner}</div>${foot ? `<div class="pane-foot">${foot}</div>` : "<div></div>"}`;

const WHERE = { pool: "Pool", tuning: "Tuning example", test: "Test example", try: "Typed in" } as const;
const TSTATE = { locked: "locked", none: "–", notasked: "not asked", ask: "not asked" } as const;

function block(m: Model, r: Row, j: number) {
  const q = m.questions[j];
  const lines: [string, string, string][] = [];
  m.teachers.forEach((t, ti) => {
    const a = r.teachers[ti];
    const st = a?.state ?? "none";
    if (st !== "ok") { lines.push([t.short, TSTATE[st], ""]); return; }
    const v = a.answers[j] ?? "–";
    const alt = m.votes > 1 && a.alt?.[j] ? `, else ${a.alt[j]}` : "";
    lines.push([t.short, v + alt, teacherNote(m, r, ti, j)]);
  });
  if (m.combine) lines.push(["Combined", r.combined?.[j] ?? "–", ""]);
  for (const x of m.methods) {
    const a = r.methods[x.id];
    const st: string = a?.state ?? (x.state === "done" ? "none" : x.state);
    if (st === "ok" && a) lines.push([x.name, (a.answers[j] ?? "–") + (a.routed ? " ↗" : ""), fmtP(a.p?.[j])]);
    else lines.push([x.name, st === "running" ? "training" : st === "queued" ? "waiting" : st === "none" ? "–" : st, ""]);
  }
  const mine = youVal(r, j);
  const flag = r.flagged?.includes(q.id) ? " flag" : "";
  return `<div class="qb${isPanel(m) && activeQ(m, r) === j ? " act" : ""}${flag}"><h4>${isPanel(m) ? esc(q.id) : "Answers"}${clearLink(m, r, j)}</h4>
    <div class="who">${lines.map(([a, b, c]) => `<span>${esc(a)}</span><span>${esc(b)}</span><span>${esc(c)}</span>`).join("")}</div>
    <div class="opts" role="radiogroup" aria-label="Your answer for ${esc(q.id)}">${q.options.map((o, k) => `<button class="opt" role="radio" aria-checked="${mine === o}" data-pick="${j}:${k}"><span class="k">${k + 1}</span>${esc(o)}</button>`).join("")}</div></div>`;
}

/** Taking your answer back: an unsaved pick is undone; on the pool the teachers' answer
 * returns; on a panel example the question is left unanswered. A classifier example always has
 * a label, so it's removed instead (the footer). */
function clearLink(m: Model, r: Row, j: number) {
  const pending = S.picks[r.key]?.[j] != null;
  const saved = r.you?.[j] != null;
  const teachers = m.combine ? "the combined answer" : m.teachers.length > 1 ? "the teachers' answer" : "the teacher's answer";
  const [label, title] = pending ? ["Undo", "Drop the answer you haven't saved"]
    : saved && r.set === "pool" && r.reviewed ? [`Use ${teachers}`, `Take your answer back; ${teachers} is used again, with no API calls`]
    : saved && isPanel(m) && r.set !== "pool" ? ["Clear", "Leave this question unanswered on this example"]
    : [];
  return label ? `<button class="link" data-act="clear-answer" data-j="${j}" title="${esc(title!)}">${esc(label)}</button>` : "";
}

export function detailsPane(m: Model, r: Row | undefined) {
  if (!r) return paneWrap('<span class="dim">Select a row.</span>', "", "details");
  const status = needsYou(r) ? ` · <span class="needs">${esc(r.needs)}</span>` : r.reviewed ? ", reviewed" : "";
  const typed = r.set === "try";
  const keys = `<div class="keys"><span><kbd>1</kbd>–<kbd>9</kbd> answer</span>${isPanel(m) ? "<span><kbd>[</kbd> <kbd>]</kbd> question</span>" : ""}${typed ? "" : "<span><kbd>↵</kbd> save and next</span>"}<span><kbd>↑</kbd><kbd>↓</kbd> rows</span></div>`;
  const foot = typed ? typedFoot(m, r) : `${r.set === "pool" ? "" : '<button class="btn plain danger" data-act="remove-example-open">Remove…</button>'}<span class="dim">${r.set === "test" ? "Changes a locked example" : ""}</span>${r.set === "pool" ? '<button class="btn" data-act="to-examples">Add to examples</button>' : ""}<button class="btn ${reviewing() ? "default" : ""}" data-act="save" ${S.busy ? "disabled" : ""}>Save</button>`;
  return paneWrap(`
    <div class="where">${WHERE[r.set]}${r.round ? `, labeled in round ${r.round}` : ""}${status}</div>
    <p class="doctext">${esc(r.text)}</p>
    ${m.questions.map((_, j) => block(m, r, j)).join("")}
    ${keys}`, foot, "details");
}

/** A typed-in document is kept as an example (with your answers; a hash of its text puts it
 * in tuning or the locked test set, as an import would) or added to the documents. */
function typedFoot(m: Model, r: Row) {
  const picks = S.picks[r.key] ?? [];
  const answered = isPanel(m) ? picks.some(p => p != null) : picks[0] != null;
  const first = !m.counts.tuning && !m.counts.test;
  const why = first ? "Your first examples come from a CSV, which splits them into tuning and a locked test set"
    : !answered ? (isPanel(m) ? "Answer at least one question first" : "Pick a label first")
    : "Like an import, a share of new examples goes to the locked test set";
  const off = first || !answered || S.busy;
  return `<button class="btn" data-act="typed-document" ${S.busy ? "disabled" : ""} title="For the teachers to label">Add to documents</button><span class="dim"></span>
    <button class="btn ${answered && !first ? "default" : ""}" data-act="typed-example" ${off ? "disabled" : ""} title="${esc(why)}">Add as example</button>`;
}

export const right = (m: Model, r: Row | undefined) => `<aside class="right" aria-label="Details">${detailsPane(m, r)}</aside>`;
