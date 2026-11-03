// New model: what kind, the task, the teachers, then your data. shrewd fixes a model's
// instructions and labels when it's created, so all of it is asked for before anything is made.
import type { Kind, Question } from "../api";
import { S, type CsvPick } from "../state";
import { esc, n } from "../util";
import { wantTeacherKey } from "../data";

export interface Wizard {
  step: 1 | 2 | 3 | 4;
  kind: Kind;
  name: string;
  instructions: string;
  labels: { name: string; description: string }[];
  questions: Question[];
  teachers: string[];
  examples: CsvPick | null;
  pool: CsvPick | null;
  err: string | null;
}

export const freshWizard = (teachers: string[]): Wizard => ({
  step: 1, kind: "classifier", name: "", instructions: "",
  labels: [{ name: "", description: "" }, { name: "", description: "" }],
  questions: [{ id: "", type: "choice", text: "", options: [] }],
  teachers, examples: null, pool: null, err: null,
});

/** Anything typed or chosen yet, beyond the kind of model. A click beside the wizard closes it
 * only before then, so a stray click doesn't throw work away; Cancel and Esc always close it. */
export const wizardStarted = (w: Wizard) =>
  !!(w.name.trim() || w.instructions.trim() || w.examples || w.pool
    || w.labels.some(l => l.name.trim() || l.description.trim())
    || w.questions.some(q => q.id.trim() || (q.text ?? "").trim() || q.options.length));

/** shrewd's rule for a classifier's first examples: every label at least this many times. */
export const MIN_PER_LABEL = 8;

/** Labels with fewer than MIN_PER_LABEL examples in a picked CSV, as "name (count)". */
export function tooFew(pick: CsvPick, labels: string[]) {
  const col = pick.headers.indexOf(pick.map.label ?? "");
  if (col < 0) return [];
  const counts = new Map(labels.map(l => [l.toLowerCase(), 0]));
  for (const r of pick.rows) { const v = (r[col] ?? "").trim().toLowerCase(); if (counts.has(v)) counts.set(v, counts.get(v)! + 1); }
  return labels.filter(l => counts.get(l.toLowerCase())! < MIN_PER_LABEL).map(l => `${l} (${counts.get(l.toLowerCase())})`);
}

/** Values in the examples' label (or choice question) columns that the task doesn't offer. */
function unknownAnswers(w: Wizard): string[] {
  const ex = w.examples!;
  const allowed: [string, string[]][] = w.kind === "classifier" ? [["label", w.labels.map(l => l.name.trim())]]
    : w.questions.filter(q => q.type === "choice" && q.id.trim()).map(q => [q.id.trim(), q.options] as [string, string[]]);
  const out = new Set<string>();
  for (const [target, options] of allowed) {
    const col = ex.headers.indexOf(ex.map[target] ?? "");
    if (col < 0) continue;
    const ok = new Set(options.map(o => o.toLowerCase()));
    for (const r of ex.rows) { const v = (r[col] ?? "").trim(); if (v && !ok.has(v.toLowerCase())) out.add(v); }
  }
  return [...out];
}

const STEPS = ["Kind", "Task", "Teachers", "Data"];

/** What blocks the step from going on, in plain words, or null. */
export function wizardProblem(w: Wizard): string | null {
  if (w.step === 2) {
    if (!w.name.trim()) return "Give the model a name.";
    if (!w.instructions.trim()) return "Describe the task in a sentence or two.";
    if (w.kind === "classifier") {
      const names = w.labels.map(l => l.name.trim()).filter(Boolean);
      if (names.length < 2) return "Add at least two labels.";
      if (new Set(names.map(x => x.toLowerCase())).size !== names.length) return "Each label needs a different name.";
    } else {
      const qs = w.questions.filter(q => q.id.trim() || (q.text ?? "").trim());
      if (!qs.length) return "Add at least one question.";
      for (const q of qs) {
        if (!q.id.trim() || !(q.text ?? "").trim()) return "Each question needs a short id and the question itself.";
        if (q.type !== "yes/no" && q.options.filter(Boolean).length < 2) return `Give "${q.id}" at least two options.`;
      }
    }
  }
  if (w.step === 3 && !w.teachers.length) return "Pick at least one teacher.";
  if (w.step === 4) {
    if (w.examples && !w.examples.map.text) return "Pick the column with the documents in your examples.";
    if (w.examples && w.kind === "classifier" && !w.examples.map.label) return "Pick the column with your labels.";
    if (w.pool && !w.pool.map.text) return "Pick the column with the documents to label.";
    const unknown = w.examples ? unknownAnswers(w) : [];
    if (unknown.length) return `Your examples use answers that aren't in the task: ${unknown.slice(0, 4).join(", ")}${unknown.length > 4 ? "…" : ""}. Go back and add them, or pick another column.`;
    const short = w.examples && w.kind === "classifier" ? tooFew(w.examples, w.labels.map(l => l.name.trim()).filter(Boolean)) : [];
    if (short.length) return `Each label needs at least ${MIN_PER_LABEL} examples, so the test set gets some of each. Too few: ${short.join(", ")}.`;
  }
  return null;
}

export function wizard(w: Wizard, still = false) {
  const body = [kindStep, taskStep, teacherStep, dataStep][w.step - 1](w);
  const problem = w.err ?? (w.step > 1 ? wizardProblem(w) : null);
  return `<div class="scrim top ${still ? "still" : ""}" data-close="wizard"><div class="sheet wiz" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
    <div class="wiz-head"><h2 id="wiz-title">New model</h2>
      <ol class="wiz-steps">${STEPS.map((s, i) => `<li class="${i + 1 === w.step ? "on" : i + 1 < w.step ? "done" : ""}"><span>${i + 1}</span>${s}</li>`).join("")}</ol></div>
    <div class="wiz-body">${body}</div>
    <div class="foot">${problem && w.step > 1 ? `<span class="wiz-problem">${esc(problem)}</span>` : ""}<div class="grow"></div>
      <button class="btn" data-act="${w.step === 1 ? "wiz-cancel" : "wiz-back"}">${w.step === 1 ? "Cancel" : "Back"}</button>
      ${w.step < 4 ? `<button class="btn default" data-act="wiz-next" ${w.step > 1 && problem ? "disabled" : ""}>Continue</button>`
        : `<button class="btn default" data-act="wiz-create" ${problem || S.busy ? "disabled" : ""}>Create model</button>`}</div>
  </div></div>`;
}

function kindStep(w: Wizard) {
  const card = (k: Kind, title: string, what: string, eg: string) => `<button class="wiz-kind ${w.kind === k ? "on" : ""}" data-act="wiz-kind" data-kind="${k}" aria-pressed="${w.kind === k}">
      <b>${title}</b><span>${what}</span><span class="dim">${eg}</span></button>`;
  return `<p>Each model is its own task, with its own examples, documents and teachers.</p>
    <div class="wiz-kinds">
      ${card("classifier", "Classifier", "One label per document.", "Route each support ticket to the team that should handle it.")}
      ${card("panel", "Decision panel", "Several questions per document: pick one, yes or no, or a score.", "Is this comment harmful, what kind, and how severe?")}
    </div>`;
}

function taskStep(w: Wizard) {
  const labels = w.labels.map((l, i) => `<tr><td><input type="text" data-wz="label-name:${i}" value="${esc(l.name)}" placeholder="name" aria-label="Label name"></td>
      <td><input type="text" data-wz="label-desc:${i}" value="${esc(l.description)}" placeholder="what it means, for the teachers" aria-label="Description"></td>
      <td class="r"><button class="btn plain" data-act="wiz-drop" data-what="label" data-i="${i}" aria-label="Remove label" ${w.labels.length <= 2 ? "disabled" : ""}>Remove</button></td></tr>`).join("");
  const questions = w.questions.map((q, i) => `<tr><td><input type="text" data-wz="q-id:${i}" value="${esc(q.id)}" placeholder="id, e.g. harmful" aria-label="Question id"></td>
      <td><select data-wz="q-type:${i}" aria-label="Type">${["choice", "yes/no", "score"].map(t => `<option ${q.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></td>
      <td class="r"><button class="btn plain" data-act="wiz-drop" data-what="question" data-i="${i}" aria-label="Remove question" ${w.questions.length <= 1 ? "disabled" : ""}>Remove</button></td></tr>
    <tr class="q-more"><td colspan="3"><input type="text" data-wz="q-text:${i}" value="${esc(q.text ?? "")}" placeholder="The question the teachers answer" aria-label="Question" style="width:100%">
      ${q.type === "yes/no" ? "" : `<input type="text" data-wz="q-options:${i}" value="${esc(q.options.join(", "))}" placeholder="${q.type === "score" ? "levels, lowest first: low, medium, high" : "options, comma separated"}" aria-label="Options" style="width:100%;margin-top:6px">`}</td></tr>`).join("");
  return `<div class="form">
      <label for="wz-name">Name:</label><input id="wz-name" type="text" data-wz="name" value="${esc(w.name)}" placeholder="${w.kind === "panel" ? "Content moderation" : "Ticket routing"}">
      <label for="wz-ins">Instructions:</label><textarea id="wz-ins" rows="3" data-wz="instructions" placeholder="${w.kind === "panel" ? "Comments users post on our forum." : "Route each support ticket to the team that should handle it."}">${esc(w.instructions)}</textarea>
      <label></label><span class="dim">Teachers read this with every document. It's fixed once the model is created.</span>
    </div>
    ${w.kind === "classifier"
      ? `<div class="sec"><h3>Labels<div class="grow"></div><button class="btn" data-act="wiz-add" data-what="label">Add label</button></h3><table class="mini"><tbody>${labels}</tbody></table></div>`
      : `<div class="sec"><h3>Questions<div class="grow"></div><button class="btn" data-act="wiz-add" data-what="question">Add question</button></h3><table class="mini wiz-q"><tbody>${questions}</tbody></table></div>`}`;
}

/** Whether a teacher can be called: its key in place, as litellm sees it on the server, which
 * knows the provider of a bare name too. `fix` adds a way to Settings when a key is missing. */
export function keyNote(model: string, fix = false) {
  if (S.settings?.sandbox) return '<span class="dim">simulated</span>';
  const k = S.teacherKeys[model];
  if (k === undefined) wantTeacherKey(model);
  if (!k) return '<span class="dim">checking…</span>';
  if (k.status === "set") return '<span class="ok">key set</span>';
  if (k.status === "local") return '<span class="dim">no key needed</span>';
  if (k.status === "unknown") return `<span class="wiz-problem" title="litellm can't tell which provider this is. Write it as provider/model, like openai/gpt-5.1 or ollama/llama3.">unknown provider</span>`;
  return `<span class="${fix ? "wiz-problem" : "dim"}">needs ${esc(k.needs.join(" and "))}</span>${fix ? ' <button class="btn plain" data-act="wiz-settings">Settings…</button>' : ""}`;
}

function teacherStep(w: Wizard) {
  return `<p>Teachers are the LLMs that label your documents. With two or more, their answers are combined, each weighted by how often it matches your examples.</p>
    <table class="mini"><tbody>${w.teachers.map((t, i) => `<tr><td class="mono">${esc(t)}</td><td>${keyNote(t, true)}</td>
      <td class="r"><button class="btn plain" data-act="wiz-drop" data-what="teacher" data-i="${i}" ${w.teachers.length <= 1 ? "disabled" : ""}>Remove</button></td></tr>`).join("")}</tbody></table>
    <div class="inline"><input type="text" id="wz-teacher" placeholder="any litellm model, e.g. openai/gpt-5.1" style="flex:1" aria-label="Add a teacher"><button class="btn" data-act="wiz-add" data-what="teacher">Add</button></div>`;
}

/** Column choices for a picked CSV. `targets` are what each column can be. */
export function mapping(pick: CsvPick, targets: [string, string][], scope: string) {
  const opts = (sel: string) => `<option value="">${"–"}</option>${pick.headers.map(h => `<option ${h === sel ? "selected" : ""}>${esc(h)}</option>`).join("")}`;
  const preview = pick.rows.slice(0, 3);
  const cols = targets.filter(([t]) => pick.map[t]);
  return `<div class="form">${targets.map(([t, label]) => `<label>${esc(label)}:</label><select data-map="${scope}:${esc(t)}" aria-label="${esc(label)}">${opts(pick.map[t] ?? "")}</select>`).join("")}</div>
    ${cols.length ? `<div class="map-preview"><table class="mini"><thead><tr>${cols.map(([, l]) => `<th>${esc(l.replace(/ column$/, ""))}</th>`).join("")}</tr></thead><tbody>
      ${preview.map(r => `<tr>${cols.map(([t]) => `<td>${esc(r[pick.headers.indexOf(pick.map[t])] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : ""}`;
}

export function exampleTargets(kind: Kind, questions: Question[]): [string, string][] {
  return [["text", "Text column"], ...(kind === "classifier" ? [["label", "Label column"]] as [string, string][]
    : questions.filter(q => q.id.trim()).map(q => [q.id.trim(), `${q.id.trim()} column`] as [string, string]))];
}

function dataStep(w: Wizard) {
  const testShare = S.settings?.defaults.test_frac != null ? Math.round(Number(S.settings.defaults.test_frac) <= 1 ? Number(S.settings.defaults.test_frac) * 100 : Number(S.settings.defaults.test_frac)) : 35;
  const ex = w.examples, pool = w.pool;
  return `<div class="sec"><h3>Your examples<div class="grow"></div><button class="btn" data-act="wiz-file" data-what="examples">${ex ? "Choose another…" : "Choose CSV…"}</button></h3>
      ${ex ? `<p><b>${esc(ex.file.name)}</b>: ${n(ex.count)} rows. About ${testShare}% become the locked test set; the rest are tuning examples.</p>${mapping(ex, exampleTargets(w.kind, w.questions), "examples")}`
        : `<p class="dim">A CSV of documents you labeled by hand, around 200 rows, with a text column and ${w.kind === "panel" ? "a column per question" : "a label column"}.</p>`}</div>
    <div class="sec"><h3>Documents to label<div class="grow"></div><button class="btn" data-act="wiz-file" data-what="pool">${pool ? "Choose another…" : "Choose CSV…"}</button></h3>
      ${pool ? `<p><b>${esc(pool.file.name)}</b>: ${n(pool.count)} documents.</p>${mapping(pool, [["text", "Text column"]], "pool")}`
        : '<p class="dim">The documents you want labeled: any CSV with a text column. Labels in it are ignored.</p>'}</div>
    <p class="dim" style="margin:0">Both are optional now; you can add either later from the model.</p>`;
}
