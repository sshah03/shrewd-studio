// How one row's answers read: yours, the teachers', the combined answer and each method's, and the
// glyph each gets: ✕ differs from you; ≠ differs from the teachers (on a teacher's answer: the
// teachers split; on the combined answer: it overrides teachers who agree); ↗ sent to teachers.
import type { Model, Row } from "./api";
import { S, isPanel } from "./state";

export type Judged = "agree" | "differ" | "disagree" | "off" | "override" | "routed" | "none" | "mine";

/** Your answer to question j, including a pick not saved yet. */
export const youVal = (r: Row, j: number): string | null =>
  S.picks[r.key]?.[j] ?? r.you?.[j] ?? null;

export const needsYou = (r: Row) => !!r.needs && !r.reviewed && !S.picks[r.key];

export const teacherOk = (r: Row, ti: number) => r.teachers[ti]?.state === "ok";

/** What the answers are judged against: yours, else the combined answer, else the first teacher's. */
export function reference(m: Model, r: Row, j: number): { v: string; you: boolean } | null {
  const y = youVal(r, j);
  if (y != null) return { v: y, you: true };
  const c = m.combine ? r.combined?.[j] ?? null : teacherOk(r, 0) ? r.teachers[0].answers[j] ?? null : null;
  return c != null ? { v: c, you: false } : null;
}

export function teachersDisagree(r: Row, j: number) {
  const vals = r.teachers.filter(t => t.state === "ok").map(t => t.answers[j]).filter(v => v != null);
  return new Set(vals).size > 1;
}

/** The teachers' shared answer to question j when there are several and they all say the same. */
export function teachersAgreeOn(r: Row, j: number): string | null {
  const vals = r.teachers.filter(t => t.state === "ok").map(t => t.answers[j]);
  return vals.length > 1 && vals.every(v => v != null && v === vals[0]) ? vals[0] : null;
}

/** A teacher's or a method's answer against yours, else against the teachers. A teacher is only
 * marked when the teachers split: one that agrees with the others isn't wrong because the
 * combined answer went another way (the combined cell says so instead, see combinedJudged). */
export function judge(m: Model, r: Row, j: number, v: string | null, teacher: boolean): Judged {
  const ref = reference(m, r, j);
  if (!ref || v == null) return "agree";
  if (ref.you) return v === ref.v ? "agree" : "differ";
  if (teacher) return teachersDisagree(r, j) ? "disagree" : "agree";
  return v === ref.v ? "agree" : "off";
}

/** The combined answer against yours, else against teachers who all agree. */
export function combinedJudged(m: Model, r: Row, j: number, v: string): Judged {
  const ref = reference(m, r, j);
  if (ref?.you) return v === ref.v ? "agree" : "differ";
  const shared = teachersAgreeOn(r, j);
  return shared != null && shared !== v ? "override" : "agree";
}

/** The small number after a teacher's answer: votes when asked several times, else P(yes) or the mean score on panels. */
export function teacherNote(m: Model, r: Row, ti: number, j: number): string {
  const t = r.teachers[ti];
  if (m.votes > 1) return t.votes?.[j] ?? `${m.votes}/${m.votes}`;
  if (isPanel(m) && m.questions[j].type !== "choice") { const p = t.p?.[j]; return p == null ? "" : p.toFixed(2); }
  return "";
}

export const fmtP = (p: number | null | undefined) => (p == null ? "" : p.toFixed(2));

const GLYPH: Partial<Record<Judged, string>> = { differ: "✕", disagree: "≠", off: "≠", override: "≠", routed: "↗" };
const TITLE: Partial<Record<Judged, string>> = {
  differ: "Differs from you", disagree: "Teachers disagree", off: "Differs from the teachers",
  override: "Differs from the teachers, who agree", routed: "Teacher backup would send this to the teachers" };

/** One answer: glyph, text, then the small number. Screen readers hear the glyph's meaning. */
export function A(cls: Judged, text: string, p = "") {
  const t = TITLE[cls];
  return `<span class="a ${cls}" ${t ? `title="${t}"` : ""}><span class="g" aria-hidden="true">${GLYPH[cls] ?? ""}</span>${escText(text)}${p !== "" ? `<span class="p">${p}</span>` : ""}${t ? `<span class="sr">, ${t.toLowerCase()}</span>` : ""}</span>`;
}
const escText = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
