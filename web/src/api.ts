// Typed wrappers for the Studio JSON API.
// Percentages are integers 0–100; probabilities are floats 0–1. Errors come back as a non-2xx
// status with FastAPI's {"detail": "..."} body.

export type Kind = "classifier" | "panel";
export type Stage = "examples" | "checked" | "labeling" | "review" | "labeled" | "shipped";
export type QType = "choice" | "yes/no" | "score";
export type SetName = "pool" | "tuning" | "test";
export type Filter = "all" | "needs" | "disagree" | "vsyou" | "local" | "routed";
export type Combine = null | "majority" | "weighted";

export interface ModelSummary { id: string; name: string; kind: Kind; how: string; stage: Stage; review: number; paused: boolean; archived?: boolean }
/** A model's folder by what it holds; `removed_mb` is what archiving would remove. */
export type ExportFormat = "plain" | "onnx" | "hf";
export interface ExportOptions { supported: boolean; formats: { id: ExportFormat; ready: boolean }[]; half: boolean; folder: string }
export interface ExportResult { path: string; format: ExportFormat; files: string[]; checked: number; max_difference: number | null; changed_answers?: number; note?: string; mb: number }

export interface DeleteInfo {
  parts: { what: "examples" | "pool" | "cache" | "candidates" | "checkpoints" | "model" | "other"; mb: number; removed_mb: number }[];
  total_mb: number; can_archive: boolean; archived: boolean; running: number; paused: number;
}
export interface Question { id: string; type: QType; options: string[]; text: string | null }
export interface Teacher { name: string; short: string; per1k: number | null; key_set: boolean; key?: string | null; accuracy: number[] | null }
export type MethodState = "done" | "running" | "queued" | "paused";
export interface Method {
  id: string; name: string; state: MethodState; job: string | null; progress: number | null; note: string | null;
  dev: number[] | null; ms: number | null; mb: number | null; test: number[] | null; shipped: boolean; zero_shot: string[] | null;
  /** A Hugging Face model it loads by name instead of keeping in its folder; `mb` is null until downloaded. */
  base?: { name: string; mb: number | null } | null;
  /** Trained before the examples, labels or your answers last changed. */
  stale?: boolean;
  /** The shipped method's candidate as compared, before shipping retrained it. Not shippable
   * or removable on its own; it's there to try next to the shipped one. */
  original?: boolean;
}
/** Finished steps that are out of date because what they used changed later. */
export interface Changes {
  /** Pool documents not labeled yet: added later, or left by a run that stopped. */
  unlabeled: number;
  /** Your examples changed since the teacher check that weights the teachers. */
  check: boolean;
  /** The labels were combined before the latest teacher check. */
  labels: boolean;
  /** The shipped model was trained before the data changed. */
  shipped: boolean;
  /** The prompt changed (optimized, or another candidate picked) since the check or the labels. */
  prompt?: boolean;
}
export interface Escalate { budget: number; delta: number; share: number }
export interface Model {
  id: string; name: string; kind: Kind; how: string; instructions: string; archived?: boolean; path?: string;
  questions: Question[]; descriptions: Record<string, string> | null;
  teachers: Teacher[]; combine: Combine; combined_accuracy: number[] | null;
  /** The combine setting changed since the pool was labeled; labeling again applies it. */
  relabel?: boolean;
  changes?: Changes;
  /** A teacher check has measured what calls really cost; until then no price is shown. */
  priced?: boolean;
  /** On a panel, how many documents are queued for review on each question. */
  queued?: Record<string, number>;
  votes: number; escalate: Escalate | null;
  stage: Stage; paused: boolean; counts: { tuning: number; test: number; pool: number; labeled: number; review: number };
  final_tests: number; spent: number;
  methods: Method[];
  /** `chosen` is false after a first ship with routing, until a limit is picked. */
  routing: { curve: [number, number][]; selected: number; chosen?: boolean; off?: boolean } | null;
  budget: { n: number; labeled: number; rounds: [number, number, number, number][] } | null;
  prompt_optimized: boolean;
}

/** "ask" is client-only: a typed-in document the teachers haven't been asked about. */
export interface TeacherAnswer {
  state: "ok" | "locked" | "none" | "notasked" | "ask";
  answers: (string | null)[]; p: (number | null)[] | null; votes: (string | null)[] | null; alt: (string | null)[] | null;
}
export interface MethodAnswer { state: "ok" | "locked" | "running" | "queued"; answers: (string | null)[]; p: (number | null)[] | null; routed: boolean }
export interface Row {
  key: string; set: SetName | "try"; text: string; you: (string | null)[]; needs: string | null; reviewed: boolean; round: number | null;
  /** On a panel, the questions this row is queued for review on, in the panel's order. */
  flagged?: string[];
  teachers: TeacherAnswer[]; combined: (string | null)[] | null; methods: Record<string, MethodAnswer>;
}
export interface RowsPage { total: number; matched: number; rows: Row[] }
export interface RowsQuery { set: "all" | SetName; filter: Filter; q: number | "all"; search: string; offset: number; limit: number }

export interface Task {
  instructions: string;
  labels?: { name: string; description: string }[];
  questions?: { id: string; type: QType; text: string | null; options: string[] }[];
  teachers: { name: string; per1k: number | null }[];
  combine: Combine; votes: number; escalate: Escalate | null;
  limit: { mode: "all" | "n" | "usd"; value: number | null };
  concurrency: number;
}

export interface PromptInfo {
  text: string; optimized: boolean; metric: string; scored_on: number; against: string;
  last_run: { candidates: { score: number; prompt: string }[]; best: number; in_use: number } | null;
}

export type JobState = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export interface Job {
  id: string; model: string; model_name: string; kind: string; title: string; uses: "CPU" | "GPU" | "API"; state: JobState;
  progress: number | null; message: string | null; started: string | null; finished: string | null; took: number | null;
  cost: number | null; error: string | null; download?: string;
}
export interface JobsList { now: Job[]; finished: Job[]; limits: { cpu: number; gpu: number } }
export interface Estimate { rows: { teacher: string; documents: number; usd: number }[]; total: number }
export interface TryResult { methods: Record<string, { answers: (string | null)[]; p: (number | null)[] | null; routed: boolean }> }
/** /ask gives per-teacher answers, a combined answer, or both. */
export interface AskResult { teachers?: { answers: (string | null)[]; p?: (number | null)[] | null }[]; combined?: (string | null)[] | null; answers?: (string | null)[] }

/** One of shrewd's optional extras; `install` is the command for this Python, `job` its latest install. */
export interface Extra {
  id: string; name: string; download: string; installed: boolean; install: string | null;
  job: { id: string; state: Job["state"]; message: string | null; error: string | null; log: string[] } | null;
}
/** A model the Playground can use: one with at least one trained method, shipped first. */
export interface PlayModel {
  id: string; name: string; kind: Kind; questions: { id: string; options: string[] }[];
  methods: { id: string; name: string; shipped: boolean }[]; teachers: number; per_doc: number | null; routing: boolean;
}
export interface PlayCell { answers: (string | null)[]; p: (number | null)[] | null; routed: boolean }
/** A document in the Playground. `asked` holds the teachers' (combined) answers once asked.
 * Local answers aren't kept. */
export interface PlayDoc { text: string; asked?: Record<string, (string | null)[]> }
export interface PlayPick { model: string; method: string }
export type Folder = "workspace" | "models_dir";
/** What switching to a folder would mean. `here`, `there`, `conflicts` and `active` are for the workspace. */
export interface FolderInfo {
  path: string; exists: boolean; problem: string | null; mb?: number;
  here?: { models: number; mb: number }; there?: number; conflicts?: string[]; active?: number;
}

export interface Settings {
  sandbox?: boolean;
  keys: { provider: string; variable: string; source: "keychain" | "shell" | null }[];
  endpoints: { ollama: string | null; openai_compatible: string | null };
  prices: { model: string; input: number; output: number }[];
  defaults: { teachers: string[]; concurrency: number; test_frac: number; seed: number };
  compute: { device: string; cpu_jobs: number; gpu_jobs: number; detected: string };
  extras: Extra[];
  storage: { workspace: string; answers_mb: number; models_mb: number; models_dir: string;
    workspace_source?: "flag" | "env" | "settings" | "default"; models_source?: "shell" | "settings" | "default";
    default_workspace?: string; default_models_dir?: string };
  boot?: string;
  about: { studio: string; shrewd: string; python: string };
  system?: System;
}

/** What this computer calls the things Studio mentions. */
export interface System { os: "mac" | "windows" | "linux"; keystore: string; files: string; trash: string; picker?: boolean }

/** What a teacher name needs before it can be called: `local` is a server on this computer (no key),
 * `unknown` a name litellm can't place with a provider. */
export interface TeacherKey { provider: string | null; status: "set" | "missing" | "local" | "unknown"; needs: string[] }

export interface ShipParams {
  method: string; calibration: string; soft: boolean; calibrate_teacher: boolean; zero_shot: boolean;
  min_confidence: number; routing: { budget: number; delta: number } | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Swappable transport so `?fixtures` can answer requests without a server. */
export type Transport = (path: string, init: RequestInit) => Promise<Response>;
// the server refuses changes without this header: a page on another site can't send it
let transport: Transport = (path, init) => {
  const headers = new Headers(init.headers);
  headers.set("X-Shrewd-Studio", "1");
  return fetch(path, { ...init, headers });
};
export function setTransport(t: Transport) { transport = t; }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await transport(path, init);
  } catch {
    throw new ApiError("Can't reach the Studio server. Is shrewd-studio still running?", 0);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`.trim();
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") msg = body.detail;
      else if (Array.isArray(body?.detail)) msg = body.detail.map((d: { msg?: string }) => d.msg ?? String(d)).join("; ");
    } catch { /* not JSON */ }
    throw new ApiError(msg, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const upload = (file: File, fields: Record<string, string> = {}): RequestInit => {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return { method: "POST", body: form };
};

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const m = (id: string) => `/api/models/${encodeURIComponent(id)}`;
const j = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;

export interface SearchResults {
  models: { id: string; name: string }[];
  documents: { model: string; model_name: string; set: SetName; text: string }[];
}

export interface Impact { tuning: number; test: number; pool: number }
export interface Structural { notes: string[]; task: Task }

export const api = {
  impact: (id: string, q: { label?: string; question?: string; option?: string }) =>
    call<Impact>(`${m(id)}/impact?${new URLSearchParams(q as Record<string, string>)}`),
  removeLabel: (id: string, label: string, into: string | null) =>
    call<Structural>(`${m(id)}/labels/${encodeURIComponent(label)}/remove`, json("POST", { into })),
  removeQuestion: (id: string, question: string) =>
    call<Structural>(`${m(id)}/questions/${encodeURIComponent(question)}/remove`, { method: "POST" }),
  mergeOptions: (id: string, question: string, mapping: Record<string, string>) =>
    call<Structural>(`${m(id)}/questions/${encodeURIComponent(question)}/merge`, json("POST", { mapping })),
  search: (q: string) => call<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`),
  models: () => call<ModelSummary[]>("/api/models"),
  createModel: (body: { name: string; kind: Kind; instructions: string; labels?: { name: string; description: string }[]; questions?: Question[]; teachers: string[] }) =>
    call<{ id: string }>("/api/models", json("POST", body)),
  model: (id: string) => call<Model>(m(id)),
  rows: (id: string, q: RowsQuery) => call<RowsPage>(`${m(id)}/rows${qs({ ...q, q: String(q.q) })}`),
  answer: (id: string, key: string, answers: Record<string, string>) => call<Row>(`${m(id)}/answers`, json("POST", { key, answers })),
  fromPool: (id: string, key: string) => call<{ set: "tuning" | "test" }>(`${m(id)}/examples/from-pool`, json("POST", { key })),
  typedExample: (id: string, text: string, answers: Record<string, string>) => call<{ set: "tuning" | "test" }>(`${m(id)}/examples/typed`, json("POST", { text, answers })),
  typedDocument: (id: string, text: string) => call<{ n: number }>(`${m(id)}/pool/typed`, json("POST", { text })),
  clearAnswer: (id: string, key: string, question: string | null) => call<Row>(`${m(id)}/answers/clear`, json("POST", { key, question })),
  removeExample: (id: string, key: string) => call<{ tuning: number; test: number }>(`${m(id)}/examples/remove`, json("POST", { key })),
  try: (id: string, text: string) => call<TryResult>(`${m(id)}/try`, json("POST", { text })),
  ask: (id: string, text: string) => call<AskResult>(`${m(id)}/ask`, json("POST", { text })),

  task: (id: string) => call<Task>(`${m(id)}/task`),
  patchTask: (id: string, body: Partial<Task>) => call<Task>(`${m(id)}/task`, json("PATCH", body)),
  reask: (id: string, qid: string) => call<Job>(`${m(id)}/questions/${encodeURIComponent(qid)}/reask`, { method: "POST" }),
  addPool: (id: string, file: File, textColumn?: string) => call<unknown>(`${m(id)}/pool`, upload(file, textColumn ? { text_column: textColumn } : {})),
  addExamples: (id: string, file: File, mapping?: Record<string, string>) => call<unknown>(`${m(id)}/examples`, upload(file, mapping ? { mapping: JSON.stringify(mapping) } : {})),
  exportCsv: (id: string) => `${m(id)}/export.csv`,
  exportTar: (id: string) => `${m(id)}/export.tar.gz`,
  reveal: (id: string) => call<unknown>(`${m(id)}/reveal`, { method: "POST" }),
  exportOptions: (id: string) => call<ExportOptions>(`${m(id)}/export`),
  exportModel: (id: string, format: ExportFormat, precision: string) => call<ExportResult>(`${m(id)}/export`, json("POST", { format, precision })),
  exportReveal: (id: string, format: ExportFormat, precision: string) => call<unknown>(`${m(id)}/export/reveal`, json("POST", { format, precision })),
  deleteInfo: (id: string) => call<DeleteInfo>(`${m(id)}/delete`),
  deleteModel: (id: string, keepModel: boolean) => call<{ trash: string | null; archived?: boolean; deleted?: boolean }>(`${m(id)}/delete`, json("POST", { keep_model: keepModel })),

  prompt: (id: string) => call<PromptInfo>(`${m(id)}/prompt`),
  usePrompt: (id: string, index: number) => call<PromptInfo>(`${m(id)}/prompt/use`, json("POST", { index })),

  jobs: () => call<JobsList>("/api/jobs"),
  clearJobs: () => call<JobsList>("/api/jobs/clear", { method: "POST" }),
  estimate: (id: string, kind: "check" | "label" | "test") => call<Estimate>(`${m(id)}/estimate${qs({ kind })}`),
  startJob: (id: string, kind: string, params: Record<string, unknown> = {}) =>
    call<{ jobs: Job[] } | Job>(`${m(id)}/jobs`, json("POST", { kind, params })).then(r => ("jobs" in r ? r.jobs : [r])),
  pauseJob: (id: string) => call<Job>(`${j(id)}/pause`, { method: "POST" }),
  resumeJob: (id: string) => call<Job>(`${j(id)}/resume`, { method: "POST" }),
  cancelJob: (id: string) => call<Job>(`${j(id)}/cancel`, { method: "POST" }),

  route: (id: string, budget: number) => call<unknown>(`${m(id)}/route`, json("POST", { budget })),
  routeOff: (id: string) => call<unknown>(`${m(id)}/route`, json("POST", { off: true })),
  report: (id: string) => call<Record<string, unknown>>(`${m(id)}/report`),
  labelFile: (id: string, file: File, mode: "local" | "teachers") => call<Job>(`${m(id)}/label-file`, upload(file, { mode })),
  /** The Remove… item on a method column. */
  removeMethod: (id: string, method: string) => call<unknown>(`${m(id)}/methods/${encodeURIComponent(method)}`, { method: "DELETE" }),

  settings: () => call<Settings>("/api/settings"),
  teacherKey: (model: string) => call<TeacherKey>(`/api/teacher-key?model=${encodeURIComponent(model)}`),
  playground: () => call<{ models: PlayModel[]; saved: { picks: PlayPick[]; docs: PlayDoc[] } | null }>("/api/playground"),
  savePlayground: (picks: PlayPick[], docs: PlayDoc[]) => call<unknown>("/api/playground", json("PUT", { picks, docs })),
  tryMany: (id: string, texts: string[], methods: string[]) => call<{ methods: Record<string, PlayCell[]> }>(`${m(id)}/try`, json("POST", { texts, methods })),
  installExtra: (extra: string) => call<Job>(`/api/settings/extras/${encodeURIComponent(extra)}/install`, { method: "POST" }),
  inspectFolder: (which: Folder, path: string) => call<FolderInfo>("/api/settings/storage/inspect", json("POST", { which, path })),
  pickFolder: (which: Folder, path: string) => call<{ path: string | null }>("/api/settings/storage/pick", json("POST", { which, path })),
  revealFolder: (which: Folder) => call<{ path: string }>("/api/settings/storage/reveal", json("POST", { which })),
  setFolder: (which: Folder, path: string, move: boolean) => call<{ restart: boolean; boot: string }>("/api/settings/storage", json("POST", { which, path, move })),
  patchSettings: (body: Record<string, unknown>) => call<Settings>("/api/settings", json("PATCH", body)),
  putKey: (variable: string, value: string) => call<Pick<Settings, "keys">>("/api/settings/keys", json("PUT", { variable, value })),
  deleteKey: (variable: string) => call<Pick<Settings, "keys">>(`/api/settings/keys/${encodeURIComponent(variable)}`, { method: "DELETE" }),
};
