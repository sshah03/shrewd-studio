// Sample data for `?fixtures`: sample models, answered through the same API shapes as the
// server, so the UI can be built and checked without Python. Jobs progress on each poll
// and change their model the way the real ones would. Loaded only in dev or a `--mode fixtures` build.
import type { AskResult, Estimate, Job, JobsList, Model, ModelSummary, PromptInfo, Row, RowsPage, Settings, Task, TeacherAnswer, Transport, TryResult } from "./api";

type TK = "H" | "G" | "F" | string;
interface FxTeacher { short: string; name: string; per1k: number }
const T: Record<TK, FxTeacher> = {
  H: { short: "haiku-5-5", name: "anthropic/claude-haiku-5-5", per1k: 0.9 },
  G: { short: "gpt-5.1", name: "openai/gpt-5.1", per1k: 3.1 },
  F: { short: "fable-5-1", name: "anthropic/claude-fable-5-1", per1k: 3.6 },
};
type QT = "choice" | "yes/no" | "score";
interface FxQ { id: string; type: QT; opts: string[]; text?: string }
const C = (opts: string[]) => ({ type: "choice" as QT, opts });
const YN = { type: "yes/no" as QT, opts: ["no", "yes"] };
const SC = (opts: string[]) => ({ type: "score" as QT, opts });
interface FxRow {
  set: "pool" | "tuning" | "test"; text: string; truth: string[];
  t?: Record<number, (string | null)[]>; loc?: Record<string, (string | null)[]>; low?: number[]; q?: string; reviewed?: boolean;
  votes?: Record<number, string>; alt?: Record<number, string>; round?: number; unlabeled?: boolean; notAsked?: boolean;
}
const R = (set: FxRow["set"], text: string, truth: string | string[], o: Partial<FxRow> = {}): FxRow => ({ set, text, truth: ([] as string[]).concat(truth), ...o });
interface FxMethod { id: string; name: string; state: "done" | "running" | "queued" | "paused"; dev?: number[]; ms?: number; mb?: number; test?: number[]; shipped?: boolean; pct?: number; eta?: string; zeroShot?: string[] }
interface FxModel {
  id: string; name: string; kind: "classifier" | "panel"; how: string; instructions: string; qs: FxQ[]; teachers: TK[];
  tacc?: number[][]; combine?: "majority" | "weighted"; cacc?: number[]; votes?: number; escalate?: { budget: number; share: number };
  stage: Model["stage"]; finalTests: number; paused?: boolean;
  budget?: { n: number; labeled: number; rounds: [number, number, number, number][] };
  counts: { tuning: number; test: number; pool: number; review: number };
  methods: FxMethod[]; routing?: { curve: [number, number][]; rb: number }; rows: FxRow[];
  optimized?: boolean; promptInUse?: number;
}

const SAMPLE: FxModel[] = [
  { id: "tickets", name: "Ticket routing", kind: "classifier", how: "One teacher, shipped with teacher backup",
    instructions: "Route each support ticket to the team that should handle it.",
    qs: [{ id: "label", ...C(["billing", "technical", "shipping", "account", "other"]) }],
    teachers: ["H"], tacc: [[91]], stage: "shipped", finalTests: 1,
    counts: { tuning: 180, test: 120, pool: 2400, review: 0 },
    methods: [{ id: "tfidf", name: "tf-idf", dev: [93], ms: .2, mb: 1.1, test: [92], shipped: true, state: "done" }],
    routing: { curve: [[1, 58], [2, 74], [5, 86], [10, 94]], rb: 1 },
    rows: [
      R("pool", "My package says delivered but nothing arrived.", "shipping"),
      R("pool", "I was billed for a plan I cancelled last week.", "billing"),
      R("pool", "The app logs me out every few minutes.", "technical", { low: [0] }),
      R("pool", "Can I change the name on my account?", "account"),
      R("pool", "Do you ship to Iceland?", "shipping", { t: { 0: ["other"] }, reviewed: true }),
      R("pool", "Is there a student discount?", "other", { low: [0] }),
      R("tuning", "Refund hasn't shown up on my card yet.", "billing"),
      R("tuning", "Password reset link expired immediately.", "account", { t: { 0: ["technical"] } }),
      R("test", "Where is my order #4471?", "shipping"),
      R("test", "Charged in USD instead of EUR.", "billing", { loc: { tfidf: ["shipping"] } }),
    ] },

  { id: "sentiment", name: "Review sentiment", kind: "classifier", how: "Two teachers, majority vote, in review",
    instructions: "Classify the overall sentiment of each product review.",
    qs: [{ id: "label", ...C(["positive", "negative", "mixed", "neutral"]) }],
    teachers: ["H", "G"], tacc: [[84], [90]], combine: "majority", cacc: [86], stage: "review", finalTests: 0,
    counts: { tuning: 160, test: 100, pool: 1800, review: 259 }, methods: [],
    rows: [
      R("pool", "Battery life is great but the screen scratches easily.", "mixed", { t: { 0: ["positive"] }, q: "teachers disagree" }),
      R("pool", "Arrived on time, works as described.", "positive", { t: { 1: ["neutral"] }, q: "teachers disagree" }),
      R("pool", "Stopped working after two weeks.", "negative"),
      R("pool", "It's fine. Does what it says.", "neutral", { t: { 0: ["positive"] }, q: "teachers disagree" }),
      R("pool", "Love it, already ordered a second one.", "positive"),
      R("pool", "Customer service was helpful, the product less so.", "mixed", { t: { 1: ["negative"] }, q: "teachers disagree" }),
      R("tuning", "Not worth the price.", "negative"),
      R("tuning", "Okay for the money, nothing special.", "neutral", { t: { 0: ["mixed"], 1: ["mixed"] } }),
      R("test", "Five stars, would buy again.", "positive"),
    ] },

  { id: "news", name: "News topics", kind: "classifier", how: "Three teachers, weighted, comparing methods",
    instructions: "Assign each headline to its main topic.",
    qs: [{ id: "label", ...C(["politics", "business", "sport", "science", "culture"]) }],
    teachers: ["H", "G", "F"], tacc: [[83], [91], [90]], combine: "weighted", cacc: [93], stage: "shipped", finalTests: 1,
    counts: { tuning: 240, test: 160, pool: 3000, review: 41 },
    methods: [
      { id: "tfidf", name: "tf-idf", dev: [91], ms: .2, mb: 1.4, test: [90], shipped: true, state: "done" },
      { id: "embed", name: "embeddings", dev: [92], ms: .4, mb: 32, state: "done" },
      { id: "setfit", name: "SetFit", state: "running", pct: 40, eta: "epoch 2 of 4" },
      { id: "encoder", name: "encoder", state: "queued" },
    ],
    rows: [
      R("pool", "Central bank holds rates steady amid slowing growth.", "business"),
      R("pool", "Parliament passes revised data protection bill.", "politics"),
      R("pool", "Chipmaker shares jump after export rules eased.", "business", { t: { 0: ["politics"] }, q: "teachers disagree" }),
      R("pool", "Minister resigns over stadium funding row.", "politics", { t: { 0: ["sport"], 2: ["sport"] }, q: "teachers disagree", loc: { embed: ["politics"] } }),
      R("pool", "Striker signs three-year deal with league champions.", "sport"),
      R("pool", "Telescope captures earliest known galaxy cluster.", "science"),
      R("pool", "Festival lineup announced for the summer season.", "culture"),
      R("tuning", "Vaccine trial shows strong early results.", "science"),
      R("tuning", "Gallery sale sets record for living artist.", "culture", { t: { 0: ["business"] } }),
      R("test", "Museum returns artifacts to country of origin.", "culture"),
    ] },

  { id: "intent", name: "Booking intent", kind: "classifier", how: "One teacher asked three times, in review",
    instructions: "What does the guest want to do?",
    qs: [{ id: "label", ...C(["book", "cancel", "change", "question", "complaint"]) }],
    teachers: ["H"], votes: 3, tacc: [[88]], stage: "review", finalTests: 0,
    counts: { tuning: 150, test: 100, pool: 1200, review: 221 }, methods: [],
    rows: [
      R("pool", "Can I move my booking to Friday?", "change"),
      R("pool", "I want to cancel and get a refund, this was awful.", "cancel", { votes: { 0: "2/3" }, alt: { 0: "complaint" }, q: "votes split" }),
      R("pool", "Do you allow pets?", "question"),
      R("pool", "Table for four tonight at 8.", "book"),
      R("pool", "Why was I charged a no-show fee?", "complaint", { votes: { 0: "2/3" }, alt: { 0: "question" }, q: "votes split" }),
      R("pool", "Could you let me know if parking is free?", "question", { votes: { 0: "2/3" }, alt: { 0: "book" }, q: "votes split" }),
      R("tuning", "Cancel my Saturday booking please.", "cancel"),
      R("test", "Is breakfast included?", "question"),
    ] },

  { id: "leads", name: "Lead qualification", kind: "classifier", how: "One teacher, labeling under a budget",
    instructions: "Is this inbound message a sales-qualified lead?",
    qs: [{ id: "label", ...C(["qualified", "nurture", "disqualify"]) }],
    teachers: ["H"], tacc: [[86]], stage: "labeling", finalTests: 0, paused: true,
    budget: { n: 600, labeled: 412, rounds: [[1, 100, 71, .09], [2, 200, 78, .09], [3, 300, 81, .09], [4, 412, 83, .1]] },
    counts: { tuning: 120, test: 80, pool: 4000, review: 0 }, methods: [],
    rows: [
      R("pool", "We're a 200-person team evaluating vendors this quarter.", "qualified", { round: 2 }),
      R("pool", "Just a student researching tools for a project.", "disqualify", { round: 1 }),
      R("pool", "Interested, but budget opens next year.", "nurture", { round: 3 }),
      R("pool", "Can you send pricing for enterprise?", "qualified", { unlabeled: true }),
      R("pool", "Looking for a free alternative.", "disqualify", { unlabeled: true }),
      R("tuning", "Need a demo for our ops team next week.", "qualified"),
      R("test", "Saw your talk, curious to learn more.", "nurture"),
    ] },

  { id: "themes", name: "Feedback themes", kind: "classifier", how: "Examples imported, nothing else yet",
    instructions: "Sort product feedback by theme.",
    qs: [{ id: "label", ...C(["pricing", "performance", "missing feature", "praise", "other"]) }],
    teachers: ["H", "G"], stage: "examples", finalTests: 0, counts: { tuning: 130, test: 70, pool: 0, review: 0 }, methods: [],
    rows: [
      R("tuning", "Too expensive for a small team.", "pricing"),
      R("tuning", "Search takes forever on large projects.", "performance"),
      R("tuning", "Please add dark mode.", "missing feature"),
      R("tuning", "Honestly the best tool we use.", "praise"),
      R("test", "Export to PDF would help a lot.", "missing feature"),
    ] },

  { id: "moderation", name: "Content moderation", kind: "panel", how: "One teacher, shipped with teacher backup",
    instructions: "User comments posted on a public forum.",
    qs: [{ id: "harmful", ...YN }, { id: "category", ...C(["harassment", "hate", "self-harm", "spam", "none"]) }, { id: "severity", ...SC(["none", "mild", "severe"]) }],
    teachers: ["F"], tacc: [[96, 91, 88]], stage: "shipped", finalTests: 2,
    counts: { tuning: 220, test: 140, pool: 3000, review: 0 },
    methods: [
      { id: "embed", name: "embeddings", dev: [97, 92, 86], ms: .4, mb: 32, test: [96, 90, 85], shipped: true, state: "done" },
      { id: "tfidf", name: "tf-idf", dev: [95, 89, 83], ms: .2, mb: 1.2, state: "done" },
    ],
    routing: { curve: [[1, 61], [2, 77], [5, 88], [10, 95]], rb: 1 },
    rows: [
      R("pool", "Buy followers cheap, link in bio!!", ["yes", "spam", "mild"]),
      R("pool", "You're an idiot and everyone knows it.", ["yes", "harassment", "mild"]),
      R("pool", "Great match last night, what a finish.", ["no", "none", "none"]),
      R("pool", "Nobody would miss me if I was gone.", ["yes", "self-harm", "severe"], { low: [1, 2] }),
      R("pool", "This recipe is a crime against pasta.", ["no", "none", "none"], { t: { 0: ["yes", "harassment", "mild"] }, reviewed: true }),
      R("tuning", "People like you shouldn't be allowed to vote.", ["yes", "hate", "severe"], { t: { 0: [null, "harassment"] } }),
      R("test", "Free crypto giveaway, DM now.", ["yes", "spam", "mild"]),
      R("test", "I'll find where you live.", ["yes", "harassment", "severe"], { loc: { embed: [null, null, "mild"] } }),
    ] },

  { id: "clauses", name: "Contract clauses", kind: "panel", how: "Two teachers, in review",
    instructions: "Clauses from supplier contracts, read from our side as the customer.",
    qs: [{ id: "clause_type", ...C(["liability", "termination", "payment", "confidentiality", "other"]) }, { id: "favorable", ...YN }, { id: "risk", ...SC(["low", "medium", "high"]) }],
    teachers: ["H", "F"], tacc: [[80, 74, 70], [90, 85, 81]], combine: "weighted", cacc: [92, 87, 83], stage: "review", finalTests: 0,
    counts: { tuning: 140, test: 90, pool: 1100, review: 188 }, methods: [],
    rows: [
      R("pool", "Either party may terminate with 30 days' written notice.", ["termination", "yes", "low"]),
      R("pool", "Supplier's total liability shall not exceed fees paid in the prior 12 months.", ["liability", "no", "medium"], { t: { 0: [null, "yes"] }, q: "teachers disagree on favorable" }),
      R("pool", "Invoices are payable within 90 days of receipt.", ["payment", "yes", "low"], { t: { 0: [null, null, "medium"] }, q: "teachers disagree on risk" }),
      R("pool", "Customer shall indemnify Supplier against all third-party claims.", ["liability", "no", "high"], { t: { 0: ["other"] }, q: "teachers disagree on clause_type" }),
      R("pool", "Recipient shall keep Confidential Information secret for five years.", ["confidentiality", "yes", "low"], { q: "spot check" }),
      R("pool", "This Agreement renews automatically unless cancelled 90 days before term end.", ["termination", "no", "medium"], { q: "unsure on risk", low: [2] }),
      R("tuning", "Late payments accrue interest at 1.5% per month.", ["payment", "no", "medium"]),
      R("tuning", "Supplier may assign this Agreement without consent.", ["other", "no", "high"], { t: { 0: [null, null, "medium"], 1: [null, null, "medium"] } }),
      R("test", "Neither party is liable for indirect or consequential damages.", ["liability", "yes", "low"]),
    ] },

  { id: "pii", name: "PII check", kind: "panel", how: "Three teachers, cheapest first, shipped",
    instructions: "Text a user is about to send to a third-party service.",
    qs: [{ id: "contains_pii", ...YN }, { id: "kind", ...C(["contact", "financial", "identity", "credentials", "none"]) }, { id: "share_risk", ...SC(["low", "medium", "high"]) }],
    teachers: ["H", "G", "F"], tacc: [[93, 85, 80], [97, 92, 88], [96, 91, 89]], combine: "weighted", cacc: [98, 94, 90], escalate: { budget: 5, share: 39 },
    stage: "shipped", finalTests: 1, counts: { tuning: 260, test: 160, pool: 5000, review: 0 },
    methods: [
      { id: "tfidf", name: "tf-idf", dev: [95, 88, 82], ms: .2, mb: 1.4, state: "done" },
      { id: "encoder", name: "encoder", dev: [97, 93, 87], ms: 6.1, mb: 570, test: [96, 92, 86], shipped: true, zeroShot: ["kind"], state: "done" },
    ],
    routing: { curve: [[1, 52], [2, 70], [5, 84], [10, 92]], rb: 1 },
    rows: [
      R("pool", "Call me on 0412 555 019 after 5.", ["yes", "contact", "medium"], { notAsked: true }),
      R("pool", "My card ending 4421 was declined.", ["yes", "financial", "medium"]),
      R("pool", "Meeting moved to 3pm, room B.", ["no", "none", "low"], { notAsked: true }),
      R("pool", "Password is hunter2, don't tell anyone.", ["yes", "credentials", "high"], { t: { 0: [null, "identity"] } }),
      R("pool", "Passport number X1234567 for the booking.", ["yes", "identity", "high"], { notAsked: true, low: [2] }),
      R("tuning", "Send the invoice to jane@acme.io.", ["yes", "contact", "low"]),
      R("test", "The weather is lovely today.", ["no", "none", "low"]),
    ] },

  { id: "jobs", name: "Job postings", kind: "panel", how: "Two teachers checked, ready to label",
    instructions: "Job postings scraped from company career pages.",
    qs: [{ id: "remote", ...YN }, { id: "seniority", ...SC(["junior", "mid", "senior"]) }, { id: "function", ...C(["engineering", "sales", "design", "operations", "other"]) }],
    teachers: ["H", "G"], tacc: [[95, 78, 90], [97, 86, 94]], combine: "weighted", cacc: [97, 87, 95], stage: "checked", finalTests: 0,
    counts: { tuning: 150, test: 100, pool: 5000, review: 0 }, methods: [],
    rows: [
      R("tuning", "Senior backend engineer, fully remote, Go and Postgres.", ["yes", "senior", "engineering"]),
      R("tuning", "Junior account executive, hybrid in Austin.", ["no", "junior", "sales"], { t: { 0: [null, "mid"] } }),
      R("tuning", "Product designer, 3+ years, remote within the EU.", ["yes", "mid", "design"]),
      R("test", "Warehouse operations lead, on-site.", ["no", "senior", "operations"]),
      R("pool", "Staff ML engineer, remote-first team.", ["yes", "senior", "engineering"], { unlabeled: true }),
      R("pool", "Sales development rep, entry level, NYC office.", ["no", "junior", "sales"], { unlabeled: true }),
    ] },
];

/* ---------------- the mockup's answer logic, producing API rows ---------------- */
const hash = (s: string) => { let x = 7; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
const CUT = [0.9, 0.8, 0.7, 0.6];
const teachersOf = (m: FxModel) => m.teachers.map(k => T[k]);
const keyOf = (r: FxRow) => `${r.set}:${r.text}`;
const isPanel = (m: FxModel) => m.kind === "panel";

let MODELS: FxModel[] = [];
const picks: Record<string, (string | null)[]> = {};

function youVal(r: FxRow, j: number) {
  const p = picks[keyOf(r)]?.[j];
  if (r.set === "pool") return p ?? (r.reviewed ? r.truth[j] : null);
  return p ?? r.truth[j];
}
const needsYou = (r: FxRow) => !!r.q && !r.reviewed && !picks[keyOf(r)];
function teacherState(m: FxModel, r: FxRow, ti: number): TeacherAnswer["state"] {
  if (r.set === "test" && !m.finalTests) return "locked";
  if (m.stage === "examples") return "none";
  if (r.set === "pool" && (m.stage === "checked" || r.unlabeled)) return "none";
  if (r.notAsked && ti > 0) return "notasked";
  return "ok";
}
const teacherVal = (r: FxRow, ti: number, j: number) => r.t?.[ti]?.[j] ?? r.truth[j];
function prob(r: FxRow, salt: string, j: number, low: boolean) { const h = hash(r.text + salt + j) % 100 / 100; return low ? 0.52 + h * 0.14 : 0.86 + h * 0.13; }
function combinedVal(m: FxModel, r: FxRow, j: number) {
  const ts = m.teachers.map((_, ti) => ti).filter(ti => teacherState(m, r, ti) === "ok");
  if (!ts.length) return null;
  const votes: Record<string, number> = {};
  for (const ti of ts) { const v = teacherVal(r, ti, j); votes[v] = (votes[v] || 0) + (m.combine === "weighted" ? m.tacc?.[ti]?.[j] ?? 1 : 1); }
  const best = Math.max(...Object.values(votes));
  const tied = Object.keys(votes).filter(v => votes[v] === best);
  return tied.length === 1 ? tied[0] : teacherVal(r, ts[0], j);
}
function localState(m: FxModel, r: FxRow, x: FxMethod) {
  if (x.state !== "done") return x.state === "paused" ? "queued" : x.state;
  if (r.set === "test" && !(x.shipped && m.finalTests)) return "locked";
  return "ok";
}
const localVal = (m: FxModel, r: FxRow, x: FxMethod, j: number) => r.loc?.[x.id]?.[j] ?? (m.combine ? combinedVal(m, r, j) : null) ?? r.truth[j];
const localConf = (r: FxRow, x: FxMethod, j: number) => prob(r, x.id, j, !!(r.low?.includes(j) || r.q));
const routedRow = (m: FxModel, r: FxRow, x: FxMethod) => !!m.routing && !!x.shipped && r.set !== "test" && m.qs.some((_, j) => localConf(r, x, j) < CUT[m.routing!.rb]);
/** What shrewd reports: choice = the option's probability; yes/no = P(yes); score = weighted mean on 0..k-1. */
function num(m: FxModel, j: number, v: string, p: number) {
  const q = m.qs[j];
  if (q.type === "yes/no") return +(v === "yes" ? p : 1 - p).toFixed(2);
  if (q.type === "score") { const i = q.opts.indexOf(v); return +Math.max(0, i + (1 - p) * (i === 0 ? 0.6 : -0.6)).toFixed(2); }
  return +p.toFixed(2);
}

function toRow(m: FxModel, r: FxRow): Row {
  const qs = m.qs.map((_, j) => j);
  return {
    key: keyOf(r), set: r.set, text: r.text, you: qs.map(j => youVal(r, j)), needs: r.q ?? null, reviewed: !!r.reviewed || !!picks[keyOf(r)], round: r.round ?? null,
    teachers: m.teachers.map((_, ti) => {
      const state = teacherState(m, r, ti);
      if (state !== "ok") return { state, answers: [], p: null, votes: null, alt: null };
      return {
        state, answers: qs.map(j => teacherVal(r, ti, j)), p: qs.map(j => num(m, j, teacherVal(r, ti, j), prob(r, "t" + ti, j, !!r.q))),
        votes: m.votes ? qs.map(j => r.votes?.[j] ?? null) : null, alt: m.votes ? qs.map(j => r.alt?.[j] ?? null) : null,
      };
    }),
    combined: m.combine ? qs.map(j => combinedVal(m, r, j)) : null,
    methods: Object.fromEntries(m.methods.map(x => {
      const state = localState(m, r, x);
      if (state !== "ok") return [x.id, { state: state as "locked" | "running" | "queued", answers: [], p: null, routed: false }];
      return [x.id, { state: "ok", answers: qs.map(j => localVal(m, r, x, j)), p: qs.map(j => num(m, j, localVal(m, r, x, j), localConf(r, x, j))), routed: routedRow(m, r, x) }];
    })),
  };
}

function reference(m: FxModel, row: Row, j: number) {
  const y = row.you[j];
  if (y != null) return y;
  return m.combine ? row.combined?.[j] ?? null : row.teachers[0]?.state === "ok" ? row.teachers[0].answers[j] : null;
}
const disagree = (row: Row, j: number) => new Set(row.teachers.filter(t => t.state === "ok").map(t => t.answers[j])).size > 1;

function rowsFor(m: FxModel, p: URLSearchParams): RowsPage {
  const set = p.get("set") ?? "all", filter = p.get("filter") ?? "all", q = p.get("q") ?? "all", search = (p.get("search") ?? "").toLowerCase();
  const offset = +(p.get("offset") ?? 0), limit = +(p.get("limit") ?? 300);
  const qs = q === "all" ? m.qs.map((_, j) => j) : [+q];
  const order = { pool: 0, tuning: 1, test: 2 };
  let rows = m.rows.slice().sort((a, b) => order[a.set] - order[b.set]);
  if (set !== "all") rows = rows.filter(r => r.set === set);
  if (search) rows = rows.filter(r => r.text.toLowerCase().includes(search));
  let out = rows.map(r => [r, toRow(m, r)] as const);
  if (filter === "needs") out = out.filter(([r]) => needsYou(r));
  if (filter === "disagree") out = out.filter(([, row]) => qs.some(j => disagree(row, j)));
  if (filter === "vsyou") out = out.filter(([r, row]) => r.set === "tuning" && qs.some(j => row.teachers.some(t => t.state === "ok" && t.answers[j] !== row.you[j])));
  if (filter === "local") out = out.filter(([, row]) => Object.values(row.methods).some(a => a.state === "ok" && qs.some(j => { const ref = reference(m, row, j); return ref != null && a.answers[j] !== ref; })));
  if (filter === "routed") out = out.filter(([, row]) => Object.values(row.methods).some(a => a.routed));
  const total = m.counts.tuning + m.counts.test + m.counts.pool;
  return { total, matched: out.length, rows: out.slice(offset, offset + limit).map(([, row]) => row) };
}

/* ---------------- models ---------------- */
const labeled = (m: FxModel) => ["review", "labeled", "shipped"].includes(m.stage) ? m.counts.pool : m.stage === "labeling" ? m.budget?.labeled ?? 0 : 0;
const summary = (m: FxModel): ModelSummary => ({ id: m.id, name: m.name, kind: m.kind, how: m.how, stage: m.stage, review: m.counts.review, paused: !!m.paused });
function detail(m: FxModel): Model {
  return {
    id: m.id, name: m.name, kind: m.kind, how: m.how, instructions: m.instructions,
    questions: m.qs.map(q => ({ id: q.id, type: q.type, options: q.opts, text: isPanel(m) ? q.text ?? null : null })),
    descriptions: null,
    teachers: teachersOf(m).map((t, ti) => ({ name: t.name, short: t.short, per1k: t.per1k, key_set: true, accuracy: m.stage === "examples" ? null : m.tacc?.[ti] ?? null })),
    combine: m.combine ?? null, combined_accuracy: m.cacc ?? null, votes: m.votes ?? 1,
    escalate: m.escalate ? { ...m.escalate, delta: 0.05 } : null,
    stage: m.stage, paused: !!m.paused, counts: { ...m.counts, labeled: labeled(m) }, final_tests: m.finalTests, spent: 0,
    methods: m.methods.map(x => ({
      id: x.id, name: x.name, state: x.state, job: jobs.find(j => j.model === m.id && j.method === x.id && !ENDED.includes(j.state))?.id ?? null,
      progress: x.pct ?? null, note: x.eta ?? (x.state === "queued" ? "waiting for the GPU" : null), dev: x.dev ?? null, ms: x.ms ?? null, mb: x.mb ?? null,
      test: x.test ?? null, shipped: !!x.shipped, zero_shot: x.zeroShot ?? null,
    })),
    routing: m.routing ? { curve: m.routing.curve, selected: m.routing.rb } : null,
    budget: m.budget ?? null, prompt_optimized: !!m.optimized,
  };
}

function task(m: FxModel): Task {
  const t: Task = {
    instructions: m.instructions, teachers: teachersOf(m).map(x => ({ name: x.name, per1k: x.per1k })),
    combine: m.combine ?? null, votes: m.votes ?? 1, escalate: m.escalate ? { ...m.escalate, delta: 0.05 } : null,
    limit: m.budget ? { mode: "n", value: m.budget.n } : { mode: "all", value: null }, concurrency: 8,
  };
  if (isPanel(m)) t.questions = m.qs.map(q => ({ id: q.id, type: q.type, text: q.text ?? null, options: q.opts }));
  else t.labels = m.qs[0].opts.map(name => ({ name, description: "" }));
  return t;
}

function teacherKey(name: string): TK {
  const k = Object.keys(T).find(x => T[x].name === name);
  if (k) return k;
  T[name] = { name, short: name.split("/").pop() ?? name, per1k: 1 };
  return name;
}

function patchTask(m: FxModel, b: Partial<Task>) {
  if (b.instructions != null) m.instructions = b.instructions;
  if (b.labels) m.qs = [{ id: "label", type: "choice", opts: b.labels.map(l => l.name) }];
  if (b.questions) m.qs = b.questions.map(q => ({ id: q.id, type: q.type, opts: q.options, text: q.text ?? undefined }));
  if (b.teachers) m.teachers = b.teachers.map(t => teacherKey(t.name));
  if (b.combine !== undefined) m.combine = b.combine ?? undefined;
  if (b.votes) m.votes = b.votes > 1 ? b.votes : undefined;
  if (b.escalate !== undefined) m.escalate = b.escalate ? { budget: b.escalate.budget, share: m.escalate?.share ?? 40 } : undefined;
  return task(m);
}

function prompt(m: FxModel): PromptInfo {
  const ts = teachersOf(m);
  const seed = isPanel(m) ? m.instructions : `${m.instructions}\n\nLabels: ${m.qs[0].opts.join(", ")}.\nAnswer with the label only.`;
  const best = isPanel(m)
    ? `${m.instructions} Judge each question on its own. When the text is ambiguous, answer for the most likely reading and lower your confidence rather than picking a middle option.`
    : `${m.instructions}\n\nLabels: ${m.qs[0].opts.join(", ")}.\nIf a headline mentions several areas, pick the one the story is about, not where it happens. Company news is business even when a minister is quoted.\nAnswer with the label only.`;
  const tail = `${isPanel(m) ? "\n\n{questions}" : ""}\n\n{text}`;
  const cands = [0.84, 0.87, 0.86, 0.89, 0.88].map((score, i) => ({ score, prompt: i === 0 ? seed : i === 3 ? best : `${seed}\n${["", "Read the whole text before answering.", "Ignore greetings and signatures.", "", "Prefer the most specific answer."][i]}` }));
  const inUse = m.promptInUse ?? 3;
  return {
    text: (m.optimized ? cands[inUse].prompt : seed) + tail, optimized: !!m.optimized, metric: isPanel(m) ? "1 − Brier/2" : "accuracy",
    scored_on: m.counts.tuning, against: ts[0]?.short ?? "", last_run: m.optimized ? { candidates: cands, best: 3, in_use: inUse } : null,
  };
}

function report(m: FxModel) {
  const x = m.methods.find(y => y.shipped);
  if (!x?.test) return null;
  const t = (j: number) => (m.cacc ?? m.tacc?.[0] ?? [])[j] ?? 0;
  const local = m.routing ? m.routing.curve[m.routing.rb][1] / 100 : null;
  if (!isPanel(m)) {
    const s = x.test[0] / 100, tt = t(0) / 100, o = m.qs[0].opts;
    return {
      metrics: {
        student: { macro_f1: s, macro_f1_ci: [s - 0.04, s + 0.03], selective: [[1, s], [0.9, s + 0.03], [0.8, s + 0.05], [0.7, Math.min(1, s + 0.06)]].map(([coverage, accuracy]) => ({ coverage, accuracy })) },
        teacher: { macro_f1: tt, macro_f1_ci: [tt - 0.035, tt + 0.025] },
        gap_ci: [tt - s - 0.03, tt - s + 0.03],
        ...(local != null ? { routing: { test: { coverage: local, student_error: 0.013 } } } : {}),
      },
      findings: [
        { severity: "warn", title: `“${o[1]}” and “${o[3]}” are confused in both directions;`, detail: "their descriptions may overlap.", suggestion: "" },
        { severity: "info", title: `“${o[4]}” has 9 test examples.`, detail: "", suggestion: "" },
      ],
    };
  }
  return {
    questions: Object.fromEntries(m.qs.map((q, j) => [q.id, {
      student: { accuracy: x.test![j] / 100, brier: 0.02 + j * 0.02, ece: 0.02 + j * 0.01, ...(q.type === "yes/no" ? { auroc: 0.99 } : q.type === "score" ? { mae: 0.18, exact: 0.85, adjacent: 0.99 } : {}) },
      teacher: { accuracy: t(j) / 100 },
    }])),
    uncalibrated: 0.1, calibrated: 0.03,
    ...(m.teachers.length > 1 ? { teachers: Object.fromEntries(teachersOf(m).map((tt, ti) => [tt.name, Object.fromEntries(m.qs.map((q, j) => [q.id, { accuracy: ((m.tacc?.[ti]?.[j] ?? 1) - 1) / 100 }]))])) } : {}),
    ...(local != null ? { routing: { test: { coverage: local, student_error: 0.011 } } } : {}),
    ...(x.zeroShot ? { stacking: Object.fromEntries(x.zeroShot.map(k => [k, { kept: true }])) } : {}),
    findings: [],
  };
}

/* ---------------- jobs ---------------- */
interface FxJob extends Job { method?: string; done?: () => void; step: number }
const ENDED = ["done", "failed", "cancelled"];
let jobs: FxJob[] = [];
let seq = 10;
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60000).toISOString();
const job = (o: Partial<FxJob> & Pick<FxJob, "model" | "kind" | "title" | "uses">): FxJob => {
  const m = MODELS.find(x => x.id === o.model);
  return { id: `j${++seq}`, model_name: m?.name ?? o.model, state: "queued", progress: 0, message: null, started: null, finished: null, took: null, cost: null, error: null, step: 8, ...o };
};

function startJobs(m: FxModel, kind: string, params: Record<string, unknown>): FxJob[] {
  const add = (j: FxJob) => { jobs.push(j); return j; };
  if (kind === "compare") {
    const names: Record<string, string> = { tfidf: "tf-idf", embed: "embeddings", setfit: "SetFit", encoder: "encoder" };
    return (params.methods as string[]).map(id => {
      const gpu = id === "setfit" || id === "encoder";
      if (!m.methods.some(x => x.id === id)) m.methods.push({ id, name: names[id] ?? id, state: "queued" });
      const x = m.methods.find(y => y.id === id)!;
      x.state = "queued";
      return add(job({ model: m.id, kind, title: `Compare, ${x.name}`, uses: gpu ? "GPU" : "CPU", method: id, step: gpu ? 4 : 25,
        done: () => { const h = hash(id + m.id); x.state = "done"; x.pct = undefined; x.eta = undefined; x.dev = m.qs.map((_, j) => 84 + (h + j) % 10); x.ms = gpu ? 6.1 : 0.3; x.mb = gpu ? 570 : 12; } }));
    });
  }
  if (kind === "check") return [add(job({ model: m.id, kind, title: "Check teachers", uses: "API", step: 20,
    done: () => { m.tacc = m.teachers.map((_, ti) => m.qs.map((_, j) => 82 + (ti * 5 + j * 3) % 14)); if (m.teachers.length > 1) m.cacc = m.qs.map((_, j) => 90 + j % 5); if (m.stage === "examples") m.stage = "checked"; } }))];
  if (kind === "label") {
    m.stage = "labeling"; m.paused = false;
    return [add(job({ model: m.id, kind, title: `Label ${m.counts.pool.toLocaleString("en-US")} documents`, uses: "API", step: 10,
      done: () => { m.rows.forEach(r => { if (r.unlabeled) { r.unlabeled = false; if (m.teachers.length > 1) { r.t = { 0: [null, null, "medium"] }; r.q = "teachers disagree"; } } }); m.counts.review = m.rows.filter(needsYou).length; m.stage = m.counts.review ? "review" : "labeled"; } }))];
  }
  if (kind === "ship") {
    const x = m.methods.find(y => y.id === params.method);
    return [add(job({ model: m.id, kind, title: `Ship ${x?.name ?? params.method}, final test ${m.finalTests + 1}`, uses: params.method === "encoder" || params.method === "setfit" ? "GPU" : "CPU", step: 20,
      done: () => { m.methods.forEach(y => { y.shipped = y === x; if (y !== x) y.test = undefined; }); if (x) x.test = (x.dev ?? m.qs.map(() => 90)).map(v => v - 1); m.finalTests += 1; m.stage = "shipped";
        const rt = params.routing as { budget: number } | null; if (rt) m.routing = { curve: [[1, 55], [2, 72], [5, 85], [10, 93]], rb: Math.max(0, [1, 2, 5, 10].indexOf(rt.budget)) }; else m.routing = undefined; } }))];
  }
  if (kind === "optimize") return [add(job({ model: m.id, kind, title: "Optimize prompt", uses: "API", step: 10, done: () => { m.optimized = true; m.promptInUse = 3; } }))];
  if (kind === "reask") return [add(job({ model: m.id, kind, title: `Re-ask ${params.question}`, uses: "API", step: 20 }))];
  return [add(job({ model: m.id, kind, title: kind === "label-file" ? "Label a file" : kind, uses: "CPU", step: 25 }))];
}

const LIMITS = { cpu: 2, gpu: 1 };
function advance() {
  for (const j of jobs) {
    if (j.state !== "running") continue;
    j.progress = Math.min(100, (j.progress ?? 0) + j.step);
    const m = MODELS.find(x => x.id === j.model);
    const x = m?.methods.find(y => y.id === j.method);
    if (x) { x.pct = j.progress; x.eta = j.message ?? undefined; }
    if (j.kind === "compare" && j.uses === "GPU") j.message = `Epoch ${Math.min(4, Math.floor(j.progress / 25) + 1)} of 4, about ${Math.max(1, Math.round((100 - j.progress) / 10))} minutes left`;
    if (j.progress >= 100) {
      j.state = "done"; j.finished = new Date().toISOString(); j.took = j.uses === "GPU" ? 720 : j.uses === "API" ? 240 : 38;
      if (j.uses === "API") j.cost = 0.42;
      j.done?.();
      if (m && j.kind === "label") m.paused = false;
    }
  }
  // Start what fits: CPU and GPU limits, one API job per model.
  for (const j of jobs) {
    if (j.state !== "queued") continue;
    const running = jobs.filter(x => x.state === "running");
    const fits = j.uses === "API" ? !running.some(x => x.uses === "API" && x.model === j.model)
      : running.filter(x => x.uses === j.uses).length < LIMITS[j.uses === "GPU" ? "gpu" : "cpu"];
    if (!fits) { if (j.uses === "GPU") j.message = "Waiting for the GPU"; continue; }
    j.state = "running"; j.started = new Date().toISOString(); j.message = null;
    const x = MODELS.find(y => y.id === j.model)?.methods.find(y => y.id === j.method);
    if (x) x.state = "running";
  }
}

function jobsList(): JobsList {
  advance();
  const strip = ({ method: _m, done: _d, step: _s, ...j }: FxJob): Job => j;
  return {
    now: jobs.filter(j => !ENDED.includes(j.state)).map(strip),
    finished: jobs.filter(j => ENDED.includes(j.state)).sort((a, b) => (b.finished ?? "").localeCompare(a.finished ?? "")).map(strip),
    limits: LIMITS,
  };
}

function jobCmd(id: string, cmd: string) {
  const j = jobs.find(x => x.id === id);
  if (!j) return null;
  const m = MODELS.find(x => x.id === j.model);
  const x = m?.methods.find(y => y.id === j.method);
  if (cmd === "pause" && j.state === "running") { j.state = "paused"; if (x) x.state = "paused"; if (m && j.kind === "label") m.paused = true; }
  if (cmd === "resume" && j.state === "paused") { j.state = "queued"; if (x) x.state = "queued"; if (m && j.kind === "label") m.paused = false; }
  if (cmd === "cancel") { j.state = "cancelled"; j.finished = new Date().toISOString(); if (m && x && x.state !== "done") m.methods = m.methods.filter(y => y !== x); }
  return j;
}

/* ---------------- settings ---------------- */
const SETTINGS: Settings = {
  keys: [
    { provider: "Anthropic", variable: "ANTHROPIC_API_KEY", source: "keychain" }, { provider: "OpenAI", variable: "OPENAI_API_KEY", source: "shell" },
    { provider: "Google Gemini", variable: "GEMINI_API_KEY", source: null }, { provider: "Mistral", variable: "MISTRAL_API_KEY", source: null },
    { provider: "OpenRouter", variable: "OPENROUTER_API_KEY", source: null },
  ],
  endpoints: { ollama: "http://localhost:11434", openai_compatible: null },
  prices: [{ model: "ollama/qwen3:8b", input: 0, output: 0 }],
  defaults: { teachers: ["anthropic/claude-haiku-5-5"], concurrency: 8, test_frac: 0.35, seed: 42 },
  compute: { device: "auto", cpu_jobs: 2, gpu_jobs: 1, detected: "M3 Pro, 18 GB, Metal" },
  extras: [
    { id: "embed", name: "Embeddings", download: "about 50 MB", installed: true, install: null, job: null },
    { id: "encoder", name: "Encoder and zero-shot", download: "about 1 GB, mostly PyTorch", installed: true, install: null, job: null },
    { id: "setfit", name: "SetFit", download: "about 1 GB, mostly PyTorch", installed: false, install: 'python -m pip install "shrewd[setfit]==0.3.1"', job: null },
  ],
  storage: { workspace: "~/shrewd/runs", answers_mb: 38, models_mb: 1946, models_dir: "~/.cache/huggingface" },
  about: { studio: "0.1.0", shrewd: "0.4.0", python: "~/shrewd/.venv/bin/python, 3.12" },
};

/* ---------------- setup ---------------- */
function setup(big: boolean) {
  MODELS = structuredClone(SAMPLE);
  if (big) {
    const m = MODELS[0];
    const base = m.rows.filter(r => r.set === "pool");
    for (let i = 0; i < 1500; i++) {
      const r = base[i % base.length];
      m.rows.push({ ...structuredClone(r), text: `${r.text} (#${i + 1})`, q: i % 7 === 0 ? "unsure" : undefined, reviewed: false, low: i % 7 === 0 ? [0] : undefined });
    }
    m.counts.review = m.rows.filter(needsYou).length;
  }
  const news = MODELS.find(m => m.id === "news")!, leads = MODELS.find(m => m.id === "leads")!;
  const methodDone = (m: FxModel, id: string) => () => { const x = m.methods.find(y => y.id === id); if (x) { x.state = "done"; x.pct = undefined; x.eta = undefined; x.dev = [90 + hash(id) % 5]; x.ms = 6.1; x.mb = 570; } };
  jobs = [
    job({ model: "news", kind: "compare", title: "Compare, SetFit", uses: "GPU", method: "setfit", state: "running", progress: 40, message: "Epoch 2 of 4, about 6 minutes left", started: iso(4), step: 1, done: methodDone(news, "setfit") }),
    job({ model: "news", kind: "compare", title: "Compare, encoder", uses: "GPU", method: "encoder", message: "Starts when SetFit finishes", step: 3, done: methodDone(news, "encoder") }),
    job({ model: "leads", kind: "label", title: "Labeling, up to 600", uses: "API", state: "paused", progress: 69, message: "Paused after round 4, 412 labeled, $0.37 spent", step: 10,
      done: () => { leads.rows.forEach(r => { r.unlabeled = false; }); leads.stage = "labeled"; leads.budget!.labeled = 600; } }),
    job({ model: "news", kind: "compare", title: "Compare, embeddings", uses: "CPU", state: "done", progress: 100, took: 38, finished: iso(25) }),
    job({ model: "pii", kind: "ship", title: "Ship encoder, final test 1", uses: "GPU", state: "done", progress: 100, took: 840, finished: iso(180) }),
    job({ model: "clauses", kind: "label", title: "Label 1,100 documents", uses: "API", state: "done", progress: 100, took: 540, cost: 4.58, finished: iso(60 * 26) }),
  ];
}

/* ---------------- transport ---------------- */
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body ?? {}), { status, headers: { "Content-Type": "application/json" } });
const notFound = (what: string) => ok({ detail: `${what} not found` }, 404);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function fixtureTransport(opts: { big?: boolean } = {}): Transport {
  setup(!!opts.big);
  return async (path, init) => {
    await sleep(40);
    const url = new URL(path, location.origin);
    const p = url.pathname.replace(/^\/api/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const parts = p.split("/").filter(Boolean).map(decodeURIComponent);

    if (parts[0] === "jobs") {
      if (parts.length === 1) return ok(jobsList());
      const j = jobCmd(parts[1], parts[2]);
      return j ? ok(j) : notFound("Job");
    }
    if (parts[0] === "teacher-key") {
      const model = url.searchParams.get("model") ?? "";
      const known: [RegExp, string][] = [[/^(anthropic\/|claude)/, "ANTHROPIC_API_KEY"], [/^(openai\/|gpt|o\d)/, "OPENAI_API_KEY"], [/^gemini\//, "GEMINI_API_KEY"]];
      if (/^(ollama|hosted_vllm|lm_studio)\//.test(model)) return ok({ provider: model.split("/")[0], status: "local", needs: [] });
      const v = known.find(([re]) => re.test(model))?.[1];
      if (!v) return ok({ provider: null, status: "unknown", needs: [] });
      return ok({ provider: v.split("_")[0].toLowerCase(), status: SETTINGS.keys.find(k => k.variable === v)?.source ? "set" : "missing", needs: [v] });
    }
    if (parts[0] === "settings") {
      if (parts[1] === "keys") {
        const v = method === "DELETE" ? parts[2] : body.variable;
        const k = SETTINGS.keys.find(x => x.variable === v);
        if (method === "DELETE") { if (k) k.source = null; }
        else if (k) k.source = "keychain";
        else SETTINGS.keys.push({ provider: v, variable: v, source: "keychain" });
        return ok(SETTINGS);
      }
      if (method === "PATCH") {
        for (const [k, v] of Object.entries(body)) {
          if (k === "endpoints") Object.assign(SETTINGS.endpoints, v);
          else (SETTINGS as unknown as Record<string, unknown>)[k] = v;
        }
        LIMITS.cpu = SETTINGS.compute.cpu_jobs; LIMITS.gpu = SETTINGS.compute.gpu_jobs;
      }
      return ok(SETTINGS);
    }
    if (parts[0] !== "models") return notFound("Route");
    if (parts.length === 1) {
      if (method === "POST") {
        const id = `untitled-${++seq}`;
        MODELS.push({ id, name: body.name, kind: body.kind, how: "Examples not added yet", instructions: body.instructions ?? "",
          qs: body.kind === "panel" ? [] : [{ id: "label", type: "choice", opts: body.labels ?? [] }], teachers: (body.teachers ?? []).map(teacherKey),
          stage: "examples", finalTests: 0, counts: { tuning: 0, test: 0, pool: 0, review: 0 }, methods: [], rows: [] });
        return ok({ id });
      }
      return ok(MODELS.map(summary));
    }
    const m = MODELS.find(x => x.id === parts[1]);
    if (!m) return notFound("Model");
    const sub = parts.slice(2).join("/");
    switch (sub) {
      case "": return ok(detail(m));
      case "rows": return ok(rowsFor(m, url.searchParams));
      case "answers": {
        const r = m.rows.find(x => keyOf(x) === body.key);
        if (!r) return notFound("Row");
        const was = needsYou(r);
        picks[keyOf(r)] = m.qs.map((q, j) => body.answers[q.id] ?? youVal(r, j));
        if (r.set === "pool") r.reviewed = true;
        if (was) { m.counts.review = Math.max(0, m.counts.review - 1); if (!m.counts.review && m.stage === "review") m.stage = m.methods.some(x => x.shipped) ? "shipped" : "labeled"; }
        return ok(toRow(m, r));
      }
      case "examples/from-pool": {
        const r = m.rows.find(x => keyOf(x) === body.key);
        if (r) { const you = m.qs.map((_, j) => youVal(r, j) ?? r.truth[j]); r.set = "tuning"; r.truth = you; r.reviewed = true; m.counts.tuning++; m.counts.pool--; }
        return ok({});
      }
      case "try": {
        const out: TryResult["methods"] = {};
        for (const x of m.methods.filter(y => y.state === "done")) {
          const ans = m.qs.map((q, j) => q.opts[hash(body.text + j) % q.opts.length]);
          const ps = m.qs.map((_, j) => 0.6 + (hash(body.text + x.id + j) % 39) / 100);
          out[x.id] = { answers: ans, p: ans.map((v, j) => num(m, j, v, ps[j])), routed: !!m.routing && !!x.shipped && ps.some(v => v < CUT[m.routing!.rb]) };
        }
        return ok({ methods: out });
      }
      case "ask": {
        const ans = m.qs.map((q, j) => q.opts[hash(body.text + j) % q.opts.length]);
        const res: AskResult = { teachers: m.teachers.map(() => ({ answers: ans, p: ans.map((v, j) => num(m, j, v, 0.9)) })), combined: m.combine ? ans : null };
        return ok(res);
      }
      case "task": return ok(method === "PATCH" ? patchTask(m, body) : task(m));
      case "prompt": return ok(prompt(m));
      case "prompt/use": m.optimized = true; m.promptInUse = body.index; return ok(prompt(m));
      case "estimate": {
        const kind = url.searchParams.get("kind");
        const docs = kind === "check" ? m.counts.tuning : m.counts.pool - labeled(m);
        const rows = teachersOf(m).map((t, ti) => { const d = kind === "label" && m.escalate && ti > 0 ? Math.round(docs * m.escalate.share / 100) : docs; return { teacher: t.name, documents: d, usd: t.per1k * d / 1000 }; });
        const est: Estimate = { rows, total: rows.reduce((s, r) => s + r.usd, 0) };
        return ok(est);
      }
      case "jobs": { const js = startJobs(m, body.kind, body.params ?? {}); return ok(js.length === 1 ? js[0] : js); }
      case "route": { const i = m.routing?.curve.findIndex(([b]) => b === body.budget) ?? -1; if (m.routing && i >= 0) m.routing.rb = i; return ok(detail(m)); }
      case "report": { const r = report(m); return r ? ok(r) : notFound("Report"); }
      case "reveal": case "pool": case "examples": return ok({});
      case "label-file": return ok(startJobs(m, "label-file", {})[0]);
    }
    if (parts[2] === "questions" && parts[4] === "reask") return ok(startJobs(m, "reask", { question: parts[3] })[0]);
    if (parts[2] === "methods" && method === "DELETE") { m.methods = m.methods.filter(x => x.id !== parts[3]); return ok({}); }
    return notFound("Route");
  };
}

