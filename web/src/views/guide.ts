// Help, a modal over whatever is open. With a model open it leads with that model's step: what
// it means now, with its numbers, and a button that does it. The tabs hold the general reference:
// the steps, how documents move, reading the table, and keys.
import type { Model, ModelSummary, Settings } from "../api";
import { S, compared, isPanel, shipped, type GuideTab } from "../state";
import { esc, ICON_PLUS, n } from "../util";
import { nextStep } from "./model";
import { mod, system } from "../system";

const STEPS = [
  { title: "Describe the task", where: "+ New model", cost: "Free",
    body: "A classifier gives each document one label. A decision panel answers several questions about it: pick one, yes or no, or a score. Write the instructions and the labels or questions." },
  { title: "Add your examples", where: "Import examples", cost: "Free",
    body: "A CSV you labeled by hand, around 200 rows. About a third is set aside as the locked test set; the rest are tuning examples." },
  { title: "Check the teachers", where: "Check teachers…", cost: "A little",
    body: "Each LLM answers your tuning examples, so you see how often it matches you before paying for the whole pool." },
  { title: "Label the pool", where: "Label documents…", cost: "API calls, cached",
    body: "The teachers answer every pool document. With several teachers, their answers are combined, each weighted by how often it matched you." },
  { title: "Review", where: "Review", cost: "Free",
    body: "Only the documents the teachers disagreed on or weren't sure about. Your answer overrides theirs." },
  { title: "Compare and ship", where: "Compare… then Ship…", cost: "Free, on this computer",
    body: "Train local methods on the labeled pool and compare them on your tuning examples. Shipping the one you pick retrains it with your tuning examples too, and scores it once on the locked test set. The shipped model is the one Use…, Python and the export serve." },
  { title: "Use it", where: "Use… or Playground", cost: "Free, or teachers with backup on",
    body: "Try it on your own documents in the Playground, then use it from Python or on a CSV, where it answers everything locally, or export it to run without shrewd. Run through shrewd, teacher backup can also send documents it may get wrong to the teachers, within a guaranteed limit." },
];

/** The step a model is on, what that means for it right now, and the action that moves it on. */
function now(m: Model): { step: number; text: string; go: [string, string] | null } {
  const c = m.counts;
  const teachers = m.teachers.length === 1 ? "Your teacher" : `Each of your ${m.teachers.length} teachers`;
  const acc = m.teachers.map(t => t.accuracy?.[0]).filter((v): v is number => v != null);
  const next = nextStep(m);
  if (!c.tuning && !c.test) return { step: 1, go: ["Import examples…", "examples-file"],
    text: `Add a CSV of documents you labeled by hand, around 200 rows, with a text column and ${isPanel(m) ? "a column per question" : "a label column"}. About a third is locked away as the test set.` };
  if (m.stage === "examples") return { step: 2, go: next,
    text: `${teachers} answers your ${n(c.tuning)} tuning examples, so you can see how often it matches you before paying for the whole pool. It costs a little, and the locked test set isn't sent.` };
  if (m.stage === "checked" && !c.pool) return { step: 3, go: ["Add documents…", "pool"],
    text: "The teachers are checked. Add the documents you want labeled: a CSV with a text column." };
  if (m.stage === "checked") return { step: 3, go: next,
    text: `${acc.length ? `Your teachers match your examples ${Math.min(...acc) === Math.max(...acc) ? Math.min(...acc) : `${Math.min(...acc)}–${Math.max(...acc)}`}% of the time. ` : ""}Next they answer all ${n(c.pool)} documents in the pool. Answers are cached, so nothing is paid for twice.` };
  if (m.stage === "labeling") return { step: 3, go: next,
    text: m.paused ? `Labeling is paused${m.budget ? ` after ${n(m.budget.labeled)} of ${n(m.budget.n)} documents` : ""}. Resume to carry on where it stopped; nothing already answered is asked again.` : "The teachers are labeling the pool. Follow it in Jobs." };
  const ch = m.changes;
  if (ch?.unlabeled) return { step: 3, go: next,
    text: `${n(ch.unlabeled)} document${ch.unlabeled === 1 ? " in the pool isn't" : "s in the pool aren't"} labeled yet. Labeling asks the teachers about ${ch.unlabeled === 1 ? "it" : "those"} only; the documents labeled already keep their labels and your answers.` };
  if (ch?.check) return { step: 2, go: next,
    text: ch.prompt ? "The prompt changed since the teachers were checked. Checking again shows how each one does with the new prompt, on your tuning examples." : "Your examples changed since the teachers were checked, and the check is what weights them. Checking again uses the examples you have now; answers already cached cost nothing." };
  if (m.relabel || ch?.labels) return { step: 3, go: next,
    text: m.relabel ? "You changed how the teachers' answers are combined. Labeling again recombines the answers they already gave."
      : ch?.prompt ? "The pool was labeled with the old prompt. Labeling again has the teachers answer every document with the new one, then compare and ship again to train on those labels."
      : "The teachers were checked again since the pool was labeled. Labeling again recombines the answers they already gave, weighted by the new check." };
  if (c.review) return { step: 4, go: next,
    text: `${n(c.review)} ${c.review === 1 ? "document needs" : "documents need"} you: the teachers disagreed or weren't sure. Answer each with the number keys and press Enter; your answer overrides theirs. You can compare methods at any time, but reviewing first makes the local model better.` };
  const cmp = compared(m);
  if (!cmp.length) return { step: 5, go: ["Compare methods…", "pane:compare"],
    text: "The pool is labeled. Compare local methods: they train on this computer for free and are scored on your tuning examples, so you can pick the best before testing." };
  if (cmp.every(x => x.stale)) return { step: 5, go: next,
    text: "Your examples, the labels or your answers changed since you compared methods. Compare again to see how each does now; it runs on this computer and costs nothing." };
  const s = shipped(m);
  if (s && ch?.shipped) return { step: 5, go: next,
    text: `${s.name} was shipped before the data changed. Shipping again retrains it on everything you have now and runs final test ${m.final_tests + 1} on your ${n(c.test)} locked examples.` };
  if (!s) return { step: 5, go: ["Compare and ship…", "pane:compare"],
    text: `Pick a method in Compare and ship it. Shipping retrains it on everything labeled and runs the final test on your ${n(c.test)} locked examples.` };
  return { step: 6, go: ["Use…", "pane:use"],
    text: `${s.name} is shipped${s.test ? `, matching ${Math.min(...s.test)}% of your locked test examples` : ""}. Use it from Python or on a CSV, where it answers everything locally${m.routing && !m.routing.off ? "; run through shrewd, teacher backup sends documents it may get wrong to the teachers" : ""}.` };
}

function steps(here = -1) {
  return `<ol class="g-steps">${STEPS.map((s, i) => `<li class="g-step ${i === here ? "here" : ""} ${i < here ? "done" : ""}">
      <span class="g-num" aria-hidden="true">${i < here ? "✓" : i + 1}</span>
      <div class="g-body"><h3>${s.title}</h3>
        <p>${s.body}</p>
        <div class="g-meta"><span class="g-where">${esc(s.where)}</span><span class="dim">${s.cost}</span></div></div></li>`).join("")}</ol>`;
}

function nextTab(m: Model) {
  const w = now(m);
  const s = STEPS[w.step];
  return `<div class="g-now">
      <div class="g-now-head"><span class="g-num here" aria-hidden="true">${w.step + 1}</span><div><div class="dim">${esc(m.name)}, step ${w.step + 1} of ${STEPS.length}</div><h3>${s.title}</h3></div></div>
      <p>${esc(w.text)}</p>
      ${w.go ? `<div><button class="btn default" data-act="guide-go" data-go="${esc(w.go[1])}">${esc(w.go[0])}</button></div>` : ""}
    </div>
    <div class="g-track">${STEPS.map((x, i) => `<span class="${i < w.step ? "done" : i === w.step ? "here" : ""}"><b>${i < w.step ? "✓" : i + 1}</b><em>${esc(x.title)}</em></span>`).join("")}</div>`;
}

/** Whether teachers can be called: a key, a local endpoint, or the sandbox's simulated teachers. */
function teacherReady(st: Settings | null): { ok: boolean; text: string } {
  if (!st) return { ok: false, text: "Checking…" };
  if (st.sandbox) return { ok: true, text: "This is the sandbox: teachers are simulated, so nothing is paid for." };
  const keys = st.keys.filter(k => k.source).map(k => k.provider);
  const ends = [st.endpoints.ollama && "Ollama", st.endpoints.openai_compatible && "your OpenAI-compatible server"].filter(Boolean);
  const all = [...keys, ...ends];
  if (all.length) return { ok: true, text: `Teachers can use ${all.join(", ")}. More in Settings.` };
  return { ok: false, text: `Teachers are LLMs called with your own API keys, or a model on Ollama. Keys are kept in the ${system().keystore}.` };
}

/** Before the first model: connect a teacher, then make a model. Used on the empty home page and in Help. */
export function firstRun(inHelp = false) {
  const t = teacherReady(S.settings);
  const go = (label: string, act: string, primary: boolean) => inHelp
    ? `<button class="btn ${primary ? "default" : ""}" data-act="guide-go" data-go="${act}">${label}</button>`
    : act === "nav:settings" ? `<a class="btn ${primary ? "default" : ""}" href="#/settings">${label}</a>` : `<button class="btn ${primary ? "default" : ""}" data-act="${act}">${label}</button>`;
  const items = [
    { title: t.ok ? "Teachers are ready" : "Connect a teacher", done: t.ok, body: t.text, btn: t.ok ? "" : go("Add a key…", "nav:settings", true) },
    { title: "Make your first model", done: false, body: "Describe the task, pick teachers and import a CSV of documents you labeled by hand: a text column and the answer, around 200 rows. The documents you want labeled can come later.", btn: go(`${ICON_PLUS}New model…`, "new", t.ok) },
  ];
  const here = items.findIndex(x => !x.done);
  return `<ol class="g-steps">${items.map((x, i) => `<li class="g-step ${x.done ? "done" : i === here ? "here" : ""}">
      <span class="g-num" aria-hidden="true">${x.done ? "✓" : i + 1}</span>
      <div class="g-body"><h3>${x.title}</h3><p>${esc(x.body)}</p>${x.btn ? `<div class="g-act">${x.btn}</div>` : ""}</div></li>`).join("")}</ol>`;
}

const STAGE: Record<ModelSummary["stage"], number> = { examples: 2, checked: 3, labeling: 3, review: 4, labeled: 5, shipped: 6 };

/** Help with no model open: where each model is, and a way back into it. */
function modelsTab(ms: ModelSummary[]) {
  return `<p>Open a model to see its next step. The button at the top right of a model is always that step.</p>
    <table class="mini g-models"><thead><tr><th>Model</th><th>Step</th><th></th></tr></thead><tbody>
    ${ms.map(m => {
      const i = STAGE[m.stage];
      const note = m.stage === "labeling" && m.paused ? "Label the pool, paused" : m.stage === "review" ? `Review, ${n(m.review)} need you` : STEPS[i].title;
      return `<tr><td>${esc(m.name)} <span class="dim">${m.kind === "panel" ? "panel" : "classifier"}</span></td><td><span class="dim">${i + 1}.</span> ${esc(note)}</td>
        <td class="r"><button class="btn" data-act="guide-go" data-go="nav:m/${esc(encodeURIComponent(m.id))}">Open</button></td></tr>`;
    }).join("")}</tbody></table>`;
}

/** Documents moving through shrewd: drawn with theme tokens so it reads in light and dark. */
const FLOW = `<svg class="g-flow" viewBox="0 0 760 248" role="img" aria-label="Your examples split into tuning and a locked test set. Pool documents go to the teachers, their answers are combined and train a local model. Tuning examples score and weight the teachers; the test set scores the shipped model; documents the local model is unsure of go back to the teachers.">
  <defs><marker id="g-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="g-head"/></marker></defs>
  <g class="g-box" data-act="guide-note" data-note="split"><title>Tuning and test</title><rect x="10" y="20" width="150" height="54" rx="10"/><text x="85" y="44">Your examples</text><text x="85" y="62" class="g-sub">labeled by you</text></g>
  <g class="g-box lock" data-act="guide-note" data-note="split"><title>Tuning and test</title><rect x="10" y="118" width="70" height="44" rx="9"/><text x="45" y="140">Test</text><text x="45" y="155" class="g-sub">locked</text></g>
  <g class="g-box" data-act="guide-note" data-note="split"><title>Tuning and test</title><rect x="90" y="118" width="70" height="44" rx="9"/><text x="125" y="145">Tuning</text></g>
  <path d="M60 74 45 118M110 74 125 118" class="g-line"/>
  <g class="g-box" data-act="guide-note" data-note="more"><title>Adding more later</title><rect x="220" y="20" width="150" height="54" rx="10"/><text x="295" y="44">Pool</text><text x="295" y="62" class="g-sub">documents to label</text></g>
  <path d="M370 47H418" class="g-line" marker-end="url(#g-arrow)"/>
  <g class="g-box" data-act="guide-note" data-note="combine"><title>Combining teachers</title><rect x="420" y="20" width="120" height="54" rx="10"/><circle cx="452" cy="47" r="7" class="g-dot"/><circle cx="480" cy="47" r="7" class="g-dot"/><circle cx="508" cy="47" r="7" class="g-dot"/></g>
  <text x="480" y="92" class="g-sub">teachers</text>
  <path d="M540 47H588" class="g-line" marker-end="url(#g-arrow)"/>
  <g class="g-box" data-act="guide-note" data-note="combine"><title>Combining teachers</title><rect x="590" y="20" width="160" height="54" rx="10"/><text x="670" y="44">Combined</text><text x="670" y="62" class="g-sub">weighted by match with you</text></g>
  <path d="M670 74V138" class="g-line" marker-end="url(#g-arrow)"/>
  <text x="680" y="110" class="g-sub g-left">trains</text>
  <g class="g-box main" data-act="guide-note" data-note="ship"><title>Shipping</title><rect x="590" y="140" width="160" height="54" rx="10"/><text x="670" y="164">Local model</text><text x="670" y="182" class="g-sub">fast, free, on this computer</text></g>
  <path d="M160 132C260 124 390 100 440 78" class="g-line dash" marker-end="url(#g-arrow)"/>
  <text x="262" y="100" class="g-sub">checks and weights the teachers</text>
  <path d="M45 162C110 238 470 236 588 178" class="g-line dash" marker-end="url(#g-arrow)"/>
  <text x="330" y="232" class="g-sub">final test of the shipped model</text>
  <g class="g-link" data-act="guide-note" data-note="backup"><title>Teacher backup</title><path d="M590 160C560 140 520 110 500 78" class="g-line dash route" marker-end="url(#g-arrow)"/>
  <text x="538" y="142" class="g-sub route" text-anchor="end" style="text-anchor:end">unsure documents</text></g>
</svg>`;

function reading() {
  const row = (doc: string, you: string, cells: [string, string][]) => `<tr><td class="g-doc">${doc}</td><td>${you}</td>${cells.map(([cls, v]) => `<td><span class="a ${cls}"><span class="g">${({ differ: "✕", disagree: "≠", routed: "↗" } as Record<string, string>)[cls] ?? ""}</span>${v}</span></td>`).join("")}</tr>`;
  return `<div class="g-table"><table class="mini"><thead><tr><th>Document</th><th>You</th><th>haiku</th><th>gpt</th><th>Combined</th><th>tf-idf</th></tr></thead><tbody>
      ${row("Charged twice for my order", "–", [["agree", "billing"], ["agree", "billing"], ["agree", "billing"], ["agree", "billing"]])}
      ${row("App crashes when I pay", '<span class="needs-chip">?</span>', [["disagree", "billing"], ["disagree", "technical"], ["agree", "technical"], ["routed", "technical"]])}
      ${row("Refund for a broken item", "billing", [["agree", "billing"], ["differ", "shipping"], ["agree", "billing"], ["agree", "billing"]])}
    </tbody></table></div>
    <dl class="g-keys">
      <dt><span class="needs-chip">?</span></dt><dd>Needs your answer: the teachers disagreed or weren't sure.</dd>
      <dt><span class="a disagree"><span class="g">≠</span></span></dt><dd>Differs from the teachers, where you haven't answered. On a teacher's answer: the teachers disagree with each other. On the combined answer: it overrides teachers who agree. On a local model's: it isn't what the teachers said.</dd>
      <dt><span class="a differ"><span class="g">✕</span></span></dt><dd>Differs from your answer.</dd>
      <dt><span class="a routed"><span class="g">↗</span></span></dt><dd>With teacher backup on, the model run through shrewd would send this one to the teachers.</dd>
      <dt>85%</dt><dd>In a column header: how often that column matches your tuning examples, so columns compare directly.</dd>
    </dl>`;
}

/** The ideas behind the diagram, in the order it reads. Each id is a stage the diagram links to. */
const NOTES: [string, string, string][] = [
  ["split", "Tuning and test", "Your examples are split once. Tuning examples are used freely: to check teachers, weight them and compare methods. The test set stays locked until you ship, so its score is an honest estimate of how the model does on new documents."],
  ["prompt", "Better prompts", "Prompt… can rewrite the teachers' instructions with GEPA: it tries new versions, scores each on your tuning examples and keeps the best, within a budget of teacher calls. A better score on tuning examples doesn't always hold on new documents; the locked test set shows whether it did. After a new prompt, the step at the top offers checking the teachers and labeling again."],
  ["combine", "Combining teachers", "With several teachers, each one's answers count in proportion to how often it matched you on tuning examples. A cheap teacher that's often right can outvote an expensive one that isn't."],
  ["cheapest", "Cheapest first", "Panels can ask the first teacher about every document and the others only where it might be overruled. Fewer calls, nearly the same answers."],
  ["ship", "Shipping", "Compare trains each method on the labeled pool alone and keeps your tuning examples aside to judge them by. Once you've picked one, those examples are your best labels, so shipping retrains it on the pool and them together. Then it gets its one honest score: the locked test set, which nothing has seen and the teachers answer too, so the two compare directly. Each ship is counted, because shipping again until that number looks good wears its honesty down. Shipping also measures routing on documents the saved model never trained on. The compared methods stay so you can try them, but only the shipped model is served. The shipped method's own version from Compare stays too, listed as, for example, “tf-idf, as compared”, so you can try the two side by side."],
  ["backup", "Teacher backup", "Optional, for running the model through shrewd. The model answers what it's sure of and sends the rest to the teachers, and the limit you pick is the most it may disagree with them, guaranteed with 95% confidence. It needs shrewd and the teachers' API keys wherever the model runs, and holds part of the pool out of training to measure the limit. The model on its own, and an export of it, answers everything itself. With a small pool, only loose limits can be guaranteed."],
  ["more", "Adding more later", "Add documents or examples at any time: from a CSV, or type one into the last row of the table and answer it. A typed example goes to tuning or the locked test set the way an import would. The step at the top then walks through only what the change made out of date: label the new documents, check the teachers again if your examples changed, compare again and ship again. Nothing already answered is paid for twice."],
  ["export", "Exporting", "Export… in Use writes the shipped model to a folder that runs without shrewd: Python with only numpy, or JavaScript with nothing, for tf-idf and embeddings; ONNX or Hugging Face for encoders and SetFit. Each export is checked against the model before it's written. Teacher backup stays in shrewd. To serve a model, load it once when the service starts and pass texts in batches."],
];

const KEYS = [["↑ ↓", "Move between rows"], ["1–9", "Answer the selected document"], ["[ ]", "Previous or next question, on panels"], ["Enter", "Save and go to the next row"], ["Esc", "Close a drawer or sheet"], [`${mod()}K`, "Search models and documents"]];

/** Help for the Playground page: what the columns, marks and buttons mean. */
function playTab() {
  const ex = (cls: string, v: string, p = "") => `<span class="a ${cls}"><span class="g">${({ differ: "✕", off: "≠", routed: "↗" } as Record<string, string>)[cls] ?? ""}</span>${v}${p ? `<span class="p">${p}</span>` : ""}</span>`;
  return `<p>Type documents and see what your trained models say, side by side. It's the quickest way to get a feel for a model before you use it: try what you expect to see, and the awkward cases too.</p>
    <dl class="g-keys g-play">
      <dt>Columns</dt><dd>Each is one model and one of its trained methods. The shipped one is what Use… serves; compared ones are here so you can try them before shipping. Add a model twice to put two of its methods next to each other, such as the shipped one and its version from Compare (“as compared”), before shipping retrained it.</dd>
      <dt>${ex("agree", "billing", "0.91")}</dt><dd>The answer, and how sure the method is, from 0 to 1. On panels there's a line per question.</dd>
      <dt>${ex("routed", "billing")}</dt><dd>Teacher backup would send this document to the teachers instead of answering it locally. Only for a shipped method with teacher backup on.</dd>
      <dt>${ex("off", "shipping")}</dt><dd>Differs from the teachers' answer, once you ask them.</dd>
      <dt>Ask teachers</dt><dd>Each model's teachers answer the document, for about the price on the button. Answers are cached, so asking again costs nothing.</dd>
      <dt>Cost</dt><dd>Local answers are free and never leave this computer. What you type is kept with the workspace for next time.</dd>
    </dl>`;
}

export function guideModal(tab: GuideTab, still = false) {
  const m = S.route.page === "model" ? S.model : null;
  const ms = S.models ?? [];
  const play = S.route.page === "playground";
  const first: [GuideTab, string] = play ? ["next", "Playground"] : m ? ["next", "Next step"] : ms.length ? ["next", "Your models"] : ["next", "Getting started"];
  const tabs: [GuideTab, string][] = [first, ["steps", "The steps"], ["flow", "How it works"], ["table", "Reading the table"], ["keys", "Keys"]];
  const t = tab;
  const body = t === "next" ? (play ? playTab() : m ? nextTab(m) : ms.length ? modelsTab(ms) : `<p>Shrewd turns a few hundred of your labels and some LLM teachers into a small model that runs on your computer. Two things to start:</p>${firstRun(true)}`)
    : t === "steps" ? `<p>Shrewd turns a few hundred of your labels and some LLM teachers into a small model that runs on your computer. Every model goes through these steps; the button at the top right of a model is always the next one.</p>${steps(m ? now(m).step : -1)}`
    // the drawing sits in a plain block: as a grid item of its own, Chrome sizes its row before
    // its width, and the ideas below drew over it
    : t === "flow" ? `<div>${FLOW}</div><div class="g-notes">${NOTES.map(([id, h, b]) => `<p id="g-n-${id}"><b>${h}.</b> ${b}</p>`).join("")}</div>`
    : t === "table" ? reading()
    : `<table class="mini g-shortcuts"><tbody>${KEYS.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join("")}</tbody></table>`;
  return `<div class="scrim ${still ? "still" : ""}" data-close="guide"><div class="sheet gmodal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
    <div class="gm-head"><h2 id="guide-title">Help</h2>
      <div class="scope" role="group" aria-label="Help sections">${tabs.map(([k, l]) => `<button aria-pressed="${t === k}" data-act="guide-tab" data-tab="${k}">${l}</button>`).join("")}</div>
      <div class="grow"></div><button class="btn plain" data-act="guide-close">Close</button></div>
    <div class="gm-body guide">${body}</div>
  </div></div>`;
}
