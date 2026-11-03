// Centered sheets for things that spend money or discard work. The outcome is on the button.
import type { DeleteInfo, ExportFormat, Model } from "../api";
import { S, isPanel, perK, shipped, type Sheet } from "../state";
import { approx, esc, n, size, usd } from "../util";
import { MIN_PER_LABEL, exampleTargets, mapping, tooFew } from "./newmodel";
import { keyPlace, showIn, system } from "../system";

function wrap(title: string, inner: string, action: string, actionLabel: string, still: boolean, opts: { danger?: boolean; disabled?: boolean } = {}) {
  return `<div class="scrim ${still ? "still" : ""}" data-close="sheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <h2 id="sheet-title">${title}</h2>${inner}
    <div class="foot"><button class="btn" data-act="cancel">Cancel</button><button class="btn default ${opts.danger ? "danger" : ""}" data-act="${action}" ${opts.disabled || S.busy ? "disabled" : ""}>${actionLabel}</button></div></div></div>`;
}

const estimateTable = (s: { est: { rows: { teacher: string; documents: number; usd: number | null }[] } | null; err: string | null }, docs: boolean, about: (i: number) => string) => {
  if (s.err) return `<p class="err">${esc(s.err)}</p>`;
  if (!s.est) return '<p class="dim">Working out the cost…</p>';
  const priced = s.est.rows.some(r => r.usd != null);     // no price before a check has measured one
  return `<table class="mini"><thead><tr><th>Teacher</th>${docs ? '<th class="r">Documents</th>' : ""}${priced ? '<th class="r">Cost</th>' : ""}</tr></thead><tbody>
    ${s.est.rows.map((r, i) => `<tr><td>${esc(r.teacher)}</td>${docs ? `<td class="r">${about(i)}${n(r.documents)}</td>` : ""}${priced ? `<td class="r">${r.usd == null ? "–" : approx(r.usd)}</td>` : ""}</tr>`).join("")}</tbody></table>`;
};
const priceOn = (verb: string, total: number | null | undefined) => (total == null ? verb : `${verb}, ${approx(total)}`);

const counts = (i: { tuning: number; test: number; pool: number } | null, what: string) => i
  ? `<table class="mini"><tbody><tr><td>Your tuning examples</td><td class="r">${n(i.tuning)}</td></tr><tr><td>Your test examples</td><td class="r">${n(i.test)}</td></tr><tr><td>Pool documents ${what}</td><td class="r">${n(i.pool)}</td></tr></tbody></table>`
  : '<p class="dim">Counting…</p>';

function removeLabelSheet(s: Extract<Sheet, { kind: "remove-label" }>, still: boolean) {
  const labels = (S.task?.saved.labels ?? []).map(l => l.name);
  const name = labels[s.index] ?? "";
  const others = labels.filter(l => l !== name);
  const merge = s.mode === "merge";
  return wrap(`Remove ${esc(name)}`, `${counts(s.impact, "labeled with it")}
    <div class="choice-rows">
      <label class="check"><input type="radio" name="rl-mode" data-sheet="mode" value="merge" ${merge ? "checked" : ""}> Merge into
        <select data-sheet="into" aria-label="Merge into" ${merge ? "" : "disabled"}>${others.map(o => `<option ${o === s.into ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>
      <p class="dim">Your examples and the pool's labels are rewritten in place, so nothing is asked again.</p>
      <label class="check"><input type="radio" name="rl-mode" data-sheet="mode" value="drop" ${merge ? "" : "checked"}> Remove its examples and documents</label>
      <p class="dim">The test set shrinks${s.impact?.test ? ` by ${n(s.impact.test)}` : ""}, so earlier test scores aren't comparable. Label the pool again to cover the dropped documents.</p>
    </div>
    <p class="dim" style="margin:0">Compare and ship again afterwards; trained models still know ${esc(name)}.</p>`,
  "remove-label", merge ? `Merge into ${esc(s.into)}` : "Remove label", still, { danger: !merge, disabled: !name });
}

const PART: Record<DeleteInfo["parts"][number]["what"], string> = {
  examples: "Your examples", pool: "The pool and its labels", cache: "Cached teacher answers",
  candidates: "Compared methods", checkpoints: "Fine-tuning checkpoints", model: "The shipped model and its prompt", other: "Other files",
};

/** Delete a model, or archive it: keep what using its shipped model needs. Either way it goes to the Trash (the Recycle Bin on Windows). */
function deleteSheet(m: Model, s: Extract<Sheet, { kind: "delete-model" }>, still: boolean) {
  const i = s.info;
  if (!i) return wrap(`Delete ${esc(m.name)}?`, '<p class="dim">Adding up its files…</p>', "delete-model", `Move to ${system().trash}`, still, { danger: true, disabled: true });
  const keep = s.keep && i.can_archive;
  const removed = keep ? i.parts.reduce((t, p) => t + p.removed_mb, 0) : i.total_mb;
  const rows = i.parts.filter(p => p.what !== "other" || p.mb > 0).map(p => {
    const goes = keep ? p.removed_mb : p.mb;
    const stays = p.mb - goes;
    return `<tr class="${goes ? "" : "dim"}"><td>${PART[p.what]}</td><td class="r">${size(p.mb)}</td><td class="r">${goes && stays > 0.0005 ? "Partly kept" : goes ? "Removed" : "Kept"}</td></tr>`;
  }).join("");
  const choice = i.can_archive ? `<div class="choice-rows">
      <label class="check"><input type="radio" name="dm-keep" data-sheet="keep" value="1" ${keep ? "checked" : ""}> Keep the shipped model, remove the rest</label>
      <p class="dim">It still answers from Python, on a CSV and in Try, and teacher backup still reaches the teachers. Labeling, review and comparing are gone.</p>
      <label class="check"><input type="radio" name="dm-keep" data-sheet="keep" value="0" ${keep ? "" : "checked"}> Delete the whole model</label>
    </div>` : "";
  const blocked = i.running ? `<p class="err" style="margin:0">A job is running on this model. Wait for it, or pause it, first.</p>` : "";
  return wrap(i.archived ? `Delete ${esc(m.name)}?` : keep ? `Archive ${esc(m.name)}?` : `Delete ${esc(m.name)}?`, `${choice}
    <table class="mini"><tbody>${rows}</tbody></table>
    <p class="dim" style="margin:0">${size(removed)} moves to the ${system().trash}, so you can put it back from there${i.paused ? `. ${n(i.paused)} paused job${i.paused === 1 ? " is" : "s are"} cancelled` : ""}.</p>${blocked}`,
  "delete-model", keep ? "Archive" : `Move to ${system().trash}`, still, { danger: true, disabled: !!i.running });
}

/** After a failed install: the command for this Python, what the error usually means, and the
 * installer's own output. */
function installHelp(s: Extract<Sheet, { kind: "install-help" }>, still: boolean) {
  const e = S.settings?.extras.find(x => x.id === s.extra);
  if (!e) return "";
  const err = e.job?.error ?? "";
  const tip = /managed by your system/.test(err)
    ? "Studio is running on a Python your system manages. Make a virtual environment for Studio, install Studio and the extra there, and start Studio from it."
    : /no pip/.test(err) ? "Add pip to this Python with <code>-m ensurepip</code>, or install uv; Studio uses uv when Python has no pip."
    : /reach the package index/.test(err) ? "Check the network connection. Behind a proxy, set <code>HTTPS_PROXY</code> before starting Studio."
    : /can't write/.test(err) ? "Use a Python you own, such as a virtual environment, rather than the system's."
    : "Run the command below in Terminal; its output says what's missing.";
  const cmd = e.install ?? "";
  return `<div class="scrim ${still ? "still" : ""}" data-close="sheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <h2 id="sheet-title">Install ${esc(e.name)} yourself</h2>
    ${err ? `<p><span class="err">${esc(err)}</span></p>` : ""}
    <p>${tip}</p>
    <p>In Terminal, for the Python Studio runs on:</p>
    <pre>${esc(cmd)}</pre>
    <p class="dim" style="margin:0">Studio notices it the next time Settings or Compare opens; there's no need to restart.</p>
    ${e.job?.log.length ? `<details><summary class="dim">Installer output</summary><pre>${esc(e.job.log.join("\n"))}</pre></details>` : ""}
    <div class="foot"><button class="btn" data-copy="${esc(cmd)}">Copy command</button><button class="btn default" data-act="cancel">Done</button></div></div></div>`;
}

/** Choosing another folder for models or downloads. Studio restarts to use it. */
function folderSheet(s: Extract<Sheet, { kind: "folder" }>, still: boolean) {
  const st = S.settings?.storage;
  const ws = s.which === "workspace", i = s.info;
  const def = ws ? st?.default_workspace : st?.default_models_dir;
  const current = ws ? st?.workspace : st?.models_dir;
  const field = `<div class="inline"><input type="text" class="mono" data-sheet="path" value="${esc(s.path)}" aria-label="Folder" style="flex:1" spellcheck="false">${system().picker === false ? "" : '<button class="btn" data-act="folder-pick">Choose…</button>'}</div>
    ${def && s.path !== def && current !== def ? `<p class="dim" style="margin:0"><button class="link" data-act="folder-default">Use the default, ${esc(def)}</button></p>` : ""}`;
  const problem = s.err ?? i?.problem ?? null;
  let body = "", label = "Use and restart", ok = !!i && !problem;
  if (!ws) {
    body = `<p>Embedding, encoder and SetFit methods download their base models from Hugging Face into this folder. Nothing is moved: models download again the first time a method needs them${st ? `, and the ${size(st.models_mb)} in ${esc(st.models_dir)} stays there` : ""}.</p>${field}`;
  } else {
    const here = i?.here?.models ?? S.models?.length ?? 0;
    const blocked = !!i && (!!i.conflicts?.length || !!i.active);
    const there = i?.there ? `It already holds ${n(i.there)} model${i.there === 1 ? "" : "s"}.` : i?.exists ? "It has no models yet." : i ? "It doesn't exist yet; Studio creates it." : "";
    body = `<p>Where Studio keeps your models. Studio restarts to switch folders.</p>${field}
      ${i && !problem ? `<p class="dim" style="margin:0">${there}</p>` : ""}
      ${i && !problem && here ? `<div class="choice-rows">
        <label class="check"><input type="radio" name="fd-move" data-sheet="move" value="1" ${s.move ? "checked" : ""} ${blocked ? "disabled" : ""}> Move my ${n(here)} model${here === 1 ? "" : "s"} there${i.here?.mb ? `, ${size(i.here.mb)}` : ""}</label>
        <p class="dim">${i.conflicts?.length ? `Can't move: ${esc(i.conflicts.join(", "))} ${i.conflicts.length === 1 ? "is" : "are"} already there.` : i.active ? "Wait for the running jobs, or pause them, to move models." : "Paused jobs move with them. Other files in the current folder stay where they are."}</p>
        <label class="check"><input type="radio" name="fd-move" data-sheet="move" value="0" ${s.move ? "" : "checked"}> Just switch</label>
        <p class="dim">Your current models stay in ${esc(current ?? "")}; switch back here to see them.</p>
      </div>` : ""}`;
    label = s.move ? "Move and restart" : "Switch and restart";
    ok = ok && !(s.move && blocked);
  }
  return wrap(ws ? "Models folder" : "Downloads folder", `${body}${problem ? `<p class="err" style="margin:0">${esc(problem)}</p>` : ""}`, "folder-go", label, still, { disabled: !ok });
}

function mergeOptionSheet(s: Extract<Sheet, { kind: "merge-option" }>, still: boolean) {
  const q = (S.task?.saved.questions ?? []).find(x => x.id === s.question);
  const options = q?.options ?? [];
  return wrap(`Merge options of ${esc(s.question)}`, `<div class="form">
      <label for="mo-from">Merge:</label><select id="mo-from" data-sheet="from">${options.map(o => `<option ${o === s.from ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>
      <label for="mo-into">Into:</label><select id="mo-into" data-sheet="into">${options.filter(o => o !== s.from).map(o => `<option ${o === s.into ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>
    </div>${counts(s.impact, "answered with it")}
    <p class="dim" style="margin:0">The pool's probabilities add up and your examples are rewritten, so nothing is asked again. Compare and ship again afterwards.</p>`,
  "merge-option", `Merge into ${esc(s.into)}`, still, { disabled: !s.from || !s.into || s.from === s.into });
}

function importSheet(m: Model | null, s: Extract<Sheet, { kind: "import" }>, still: boolean) {
  if (!m) return "";
  const ex = s.target === "examples";
  const targets = ex ? exampleTargets(m.kind, m.questions.map(q => ({ ...q }))) : [["text", "Text column"]] as [string, string][];
  const first = ex && !m.counts.tuning && !m.counts.test;
  const short = first && m.kind === "classifier" ? tooFew(s.pick, m.questions[0]?.options ?? []) : [];
  const missing = !s.pick.map.text || (ex && m.kind === "classifier" && !s.pick.map.label) || short.length > 0;
  return wrap(ex ? "Add examples" : "Add documents", `<p><b>${esc(s.pick.file.name)}</b>: ${n(s.pick.count)} ${ex ? "rows" : "documents"}.${ex ? (first ? " Part of them become the locked test set." : " They're added to both tuning and test without re-splitting.") : ""}</p>
    ${mapping(s.pick, targets, "import")}${short.length ? `<p class="wiz-problem">Each label needs at least ${MIN_PER_LABEL} examples, so the test set gets some of each. Too few: ${esc(short.join(", "))}.</p>` : ""}`, "import-go", ex ? `Add ${n(s.pick.count)} examples` : `Add ${n(s.pick.count)} documents`, still, { disabled: missing });
}

function shipSheet(m: Model, s: Extract<Sheet, { kind: "ship" }>, still: boolean) {
  const x = m.methods.find(y => y.id === s.method);
  const est = s.est;
  const testCost = s.err ? "–" : est == null ? "working it out…"
    : est.total === 0 ? "already cached" : est.total == null ? `${n(m.counts.test)} documents` : approx(est.total);
  if (!x) return "";
  const routed = !!m.routing && !m.routing.off;
  return wrap(`Ship ${esc(x.name)}${x.shipped ? " again" : ""}`, `
    <div class="form">
      ${isPanel(m) ? `<label for="cal">Calibration:</label><select id="cal">${["auto", "auto-full", "temperature", "platt", "isotonic", "none"].map(c => `<option>${c}</option>`).join("")}</select>
        <label>Options:</label><span class="inline"><label class="check"><input type="checkbox" id="soft" checked> Soft labels</label><label class="check"><input type="checkbox" id="calt"> Calibrate teachers</label><label class="check"><input type="checkbox" id="zs" ${x.zero_shot ? "checked" : ""}> Zero-shot stack</label></span>`
        : `<label for="abs">Abstain below:</label><span class="inline"><input id="abs" type="number" value="0" step="0.05" min="0" max="1"> confidence</span>`}
      <label for="rt" title="For running the model through shrewd: documents it's unsure of go to the teachers, within a limit on how often it may disagree with them. It needs shrewd and the teachers' API keys wherever the model runs. The model on its own doesn't use it.">Teacher backup:</label><span class="inline"><select id="rt"><option value="off">Off</option><option value="on" ${routed ? "selected" : ""}>On</option></select>
        <span class="dim">${routed && m.routing?.chosen !== false ? `keeps your limit, ≤ ${m.routing!.curve[m.routing!.selected]?.[0] ?? 2}% disagree` : "optional"}</span></span>
    </div>
    <p class="dim">Backup only applies when the model runs through shrewd, and holds 30% of the pool out of training.</p>
    <table class="mini"><tbody>
      <tr><td>Retrains on</td><td class="r">the labeled pool and ${n(m.counts.tuning)} tuning examples</td></tr>
      <tr><td>Final test</td><td class="r">${n(m.counts.test)} locked examples, test ${m.final_tests + 1}</td></tr>
      <tr><td>Teachers answer the test set</td><td class="r">${testCost}</td></tr></tbody></table>`,
    "do-ship", "Ship and test", still);
}

/** Choose how much routing sends to the teachers, from what the trained model measured: each
 * limit's share answered locally, and what the rest costs. Changing it later doesn't retrain. */
function routingSheet(m: Model, pick: number, still: boolean) {
  const rt = m.routing;
  if (!rt) return "";
  const cost = perK(m);
  const rows = rt.curve.map(([b, local], i) => `<tr><td><label class="check"><input type="radio" name="rt-pick" data-sheet="pick" value="${i}" ${i === pick ? "checked" : ""}> ≤ ${b}%</label></td>
      <td class="r">${local}%</td><td class="r">${100 - local}%</td><td class="r">${cost != null ? approx(cost * (100 - local) / 100) : "–"}</td></tr>`).join("");
  return wrap("Teacher backup limit", `<p>When the model runs through shrewd with teacher backup, documents it may get wrong go to the teachers instead. The limit is the most it may disagree with them, guaranteed at 95% confidence on documents it held out. A looser limit answers more locally.</p>
    <table class="mini"><thead><tr><th>Disagrees at most</th><th class="r">Local</th><th class="r">To teachers</th><th class="r" title="What the teachers cost for the documents sent to them, per 1,000 documents">Per 1,000</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="dim" style="margin:0">You can change it any time, here or above the table; it doesn't retrain.</p>`,
    "routing-go", "Use this limit", still);
}

const EXPORTS: Record<ExportFormat, [string, string]> = {
  plain: ["Python and JavaScript", "The weights and a small runtime next to them: shrewd_model.py needs only numpy, shrewd_model.js needs nothing."],
  onnx: ["ONNX", "model.onnx and the tokenizer.json it expects, for any ONNX runtime."],
  hf: ["Hugging Face", "A transformers model folder. pipeline(\"text-classification\", model=folder) loads it."],
};

/** Writing the shipped model to a folder that runs without shrewd. */
function exportSheet(m: Model, s: Extract<Sheet, { kind: "export" }>, still: boolean) {
  const o = s.opts, d = s.done;
  let inner: string;
  if (!o) inner = '<p class="dim">Checking what it can be exported as…</p>';
  else if (!o.supported) inner = `<p>Exporting needs shrewd 0.5 or later. Studio is running on shrewd ${esc(S.settings?.about.shrewd ?? "0.4")}.</p>`;
  else if (!o.formats.length) inner = `<p>${esc(shipped(m)?.name ?? "This method")} can't be exported yet${isPanel(m) ? "; a panel exports when it ships with tf-idf or embeddings" : ""}.</p>`;
  else {
    const choices = o.formats.map(f => `<div><label class="check" title="${esc(EXPORTS[f.id][1])}"><input type="radio" name="export-format" data-sheet="format" value="${f.id}" ${f.id === s.format ? "checked" : ""} ${f.ready ? "" : "disabled"}> ${EXPORTS[f.id][0]}</label>${f.ready ? "" : '<span class="dim" style="margin-left:6px">needs ONNX export, from Settings</span>'}</div>`).join("");
    const half = o.half && s.format === "plain"
      ? `<div><label class="check" title="Stores the embedding table at half precision: about 15 MB instead of 30, with answers within 0.0001."><input type="checkbox" data-sheet="half" ${s.half ? "checked" : ""}> Half size</label></div>` : "";
    const result = d ? `<p>Exported to <code>${esc(d.path)}</code>, ${size(d.mb)}. ${d.checked ? `<span title="Largest difference in any probability: ${d.max_difference?.toExponential(1) ?? "–"}">It matches the model on ${n(d.checked)} documents.</span>` : esc(d.note ?? "")}</p>` : "";
    const into = d ? "" : `<p class="dim" style="margin:8px 0 0">Into ${esc(o.folder)}, replacing an earlier export of the same kind.</p>`;
    inner = `${choices}${half}${into}${s.err ? `<p class="err">${esc(s.err)}</p>` : ""}${result}`;
  }
  const ready = !!o?.supported && !!o.formats.find(f => f.id === s.format && f.ready);
  const foot = d
    ? `<button class="btn" data-act="export-reveal">${showIn()}</button><button class="btn default" data-act="cancel">Done</button>`
    : `<button class="btn" data-act="cancel">Cancel</button><button class="btn default" data-act="export-go" ${ready && !S.busy ? "" : "disabled"}>${S.busy ? "Exporting…" : "Export"}</button>`;
  return `<div class="scrim ${still ? "still" : ""}" data-close="sheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <h2 id="sheet-title">Export</h2>${inner}<div class="foot">${foot}</div></div></div>`;
}

function roundsSheet(m: Model, still: boolean) {
  const b = m.budget;
  const inner = b ? `
    <table class="mini"><thead><tr><th>Round</th><th class="r">Labeled</th><th class="r" title="A quick tf-idf probe on the labels so far, scored on tuning">Tuning accuracy</th><th class="r">Cost</th></tr></thead><tbody>
    ${b.rounds.map(([r, l, a, c]) => `<tr><td>${r}</td><td class="r">${n(l)}</td><td class="r">${a}%</td><td class="r">${usd(c)}</td></tr>`).join("")}</tbody></table>
    <p>Each round labels the documents the current model is least sure of, up to ${n(b.n)}.</p>`
    : `<p>Labeling stopped at ${n(m.counts.labeled)} of ${n(m.counts.pool)} documents. Answers already cached cost nothing.</p>`;
  return wrap("Resume labeling", inner, "resume-label", "Resume", still);
}

export function sheet(m: Model | null, s: Sheet, still: boolean): string {
  const cost = m ? perK(m) : null;
  switch (s.kind) {
    case "check": {
      if (!m) return "";
      const label = priceOn("Check", s.est?.total);
      return wrap(m.changes?.check ? "Check teachers again" : "Check teachers", `<p>${m.changes?.check && m.changes.prompt ? `The prompt changed since the last check. Each teacher answers your ${n(m.counts.tuning)} tuning examples with the new one, so you can see what it changed.` : m.changes?.check ? `Your examples changed since the last check. Each teacher answers your ${n(m.counts.tuning)} tuning examples again, and only new ones cost anything; the result weights the teachers.` : `Each teacher answers your ${n(m.counts.tuning)} tuning examples, so you can see how often it matches you before labeling the pool.`} The test set isn't sent.</p>
        ${estimateTable(s, false, () => "")}`, "start-check", label, still, { disabled: !s.est });
    }
    case "label": {
      if (!m) return "";
      const docs = s.est?.rows[0]?.documents ?? m.counts.pool;
      const more = m.changes?.unlabeled ?? 0;
      const label = priceOn("Label", s.est?.total);
      const why = m.relabel ? `The teachers' answers are combined ${m.combine === "weighted" ? "by how often each matches your examples" : "by majority vote"}, as you set in Task.`
        : m.changes?.labels && m.changes.prompt ? "The prompt changed since the pool was labeled, so the teachers answer every document again with the new one."
        : m.changes?.labels ? "The teachers were checked again, so their answers are combined using the new check."
        : more ? "The documents labeled already keep their labels and your answers." : "";
      return wrap(more ? `Label ${n(more)} more document${more === 1 ? "" : "s"}` : m.relabel || m.changes?.labels ? "Label again" : `Label ${n(docs)} documents`, `
        ${estimateTable(s, true, i => (m.escalate && i > 0 ? "about " : ""))}
        ${why ? `<p>${why}</p>` : ""}
        <p class="dim">Answers already cached cost nothing. You can pause and resume.</p>`, "start-label", label, still, { disabled: !s.est });
    }
    case "rounds": return m ? roundsSheet(m, still) : "";
    case "ship": return m ? shipSheet(m, s, still) : "";
    case "routing": return m ? routingSheet(m, s.pick, still) : "";
    case "remove-method": return wrap("Remove this method?", "<p>Its trained files are deleted. Comparing it again retrains it; no API calls are involved.</p>", "remove-method", "Remove", still, { danger: true });
    case "remove-teacher": return wrap("Remove this teacher?", "<p>Its cached answers are kept, so adding it back later costs nothing. Combined answers are recomputed without it.</p>", "remove-teacher", "Remove", still, { danger: true });
    case "remove-label": return removeLabelSheet(s, still);
    case "reask": return m ? wrap(`Ask ${esc(s.question)} again?`, `<p>Each teacher answers ${esc(s.question)} again for the ${n(m.counts.pool)} documents and ${n(m.counts.tuning)} tuning examples, and the combined answers are recomputed. The other questions keep their answers.</p>`, "reask", "Ask again", still) : "";
    case "remove-question": return wrap(`Remove ${esc(s.question)}?`, "<p>Its answers leave your examples, the judged pool and the review queue. The other questions keep their answers, so nothing is asked again. Compare and ship again afterwards.</p>", "remove-question", "Remove question", still, { danger: true });
    case "merge-option": return mergeOptionSheet(s, still);
    case "folder": return folderSheet(s, still);
    case "install-help": return installHelp(s, still);
    case "delete-model": return m ? deleteSheet(m, s, still) : "";
    case "export": return m ? exportSheet(m, s, still) : "";
    case "remove-example": return wrap("Remove this example?", `<p class="g-quote">${esc(s.text.length > 160 ? s.text.slice(0, 160) + "…" : s.text)}</p>
      <p>${s.set === "test"
        ? "It leaves the locked test set, so test scores from before aren't comparable with the next ship. The change is logged, so it isn't mistaken for tampering."
        : "It no longer checks the teachers, weights them or scores methods. Check teachers and compare again to see the effect."}</p>`, "remove-example", "Remove example", still, { danger: true });
    case "import": return importSheet(m, s, still);
    case "use-prompt": return m ? wrap("Use this prompt?", `<p>Teachers' answers are cached per prompt, so the pool is asked again${cost == null ? "" : `, about ${usd(cost * m.counts.pool / 1000)}`}. Check teachers first to see whether it helps.</p>`, "use-prompt", "Use prompt", still) : "";
    case "new": return `<div class="scrim ${still ? "still" : ""}" data-close="sheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title">New model</h2><div class="choice">
        <button data-act="blank" data-kind="classifier"><b>Classifier</b><span>One label per document</span></button>
        <button data-act="blank" data-kind="panel"><b>Decision panel</b><span>Several questions per document: choice, yes or no, score</span></button>
        <button disabled title="Not available yet"><b>Autotune</b><span>A classifier, built end to end under a spending cap</span></button></div>
      <div class="foot"><button class="btn" data-act="cancel">Cancel</button></div></div></div>`;
    case "key": return wrap(`${esc(s.provider)} key`, `<p>Stored in the ${system().keystore} as <code>${esc(s.variable)}</code> and passed to Studio's Python process.</p>
      <input type="password" id="key-value" placeholder="Key" aria-label="Key" autocomplete="off">`, "save-key", `Save to ${keyPlace()}`, still);
    case "remove-key": return wrap("Remove this key?", `<p><code>${esc(s.variable)}</code> is deleted from the ${system().keystore}. Teachers that need it stop working until you add it again.</p>`, "remove-key", "Remove", still, { danger: true });
    case "remove-endpoint": return wrap("Remove this endpoint?", `<p>Models named <code>${s.which === "ollama" ? "ollama/&lt;model&gt;" : "hosted_vllm/&lt;model&gt;"}</code> stop working until you add it again.</p>`, "remove-endpoint", "Remove", still, { danger: true });
  }
}
