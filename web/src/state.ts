// All UI state lives in S. The address holds only the page (#/m/<id>, #/jobs, #/settings); the
// selected row, set, filter, question and search are view state and reset when another model opens.
import type { Wizard } from "./views/newmodel";
import type { DeleteInfo, Estimate, ExportFormat, ExportOptions, ExportResult, PlayCell, PlayDoc, PlayModel, PlayPick, Filter, Folder, FolderInfo, Impact, JobsList, Model, ModelSummary, PromptInfo, Row, SearchResults, SetName, Settings, Task, TeacherKey } from "./api";

export type Route = { page: "model"; id: string } | { page: "jobs" } | { page: "settings" } | { page: "playground" } | { page: "home" };
export type Pane = "task" | "prompt" | "compare" | "use" | "report";

/** A CSV picked for import: its columns, a few rows to preview, its row count, and which column
 * goes where ("text", "label" or a question id -> CSV header). */
export interface CsvPick { file: File; headers: string[]; rows: string[][]; count: number; map: Record<string, string> }
export type GuideTab = "next" | "steps" | "flow" | "table" | "keys";

export type Sheet =
  | { kind: "check" | "label"; est: Estimate | null; err: string | null }
  | { kind: "rounds" }
  | { kind: "ship"; method: string; est?: Estimate | null; err?: string | null }
  | { kind: "routing"; pick: number }
  | { kind: "remove-method"; method: string }
  | { kind: "remove-teacher"; index: number }
  | { kind: "remove-label"; index: number; impact: Impact | null; mode: "merge" | "drop"; into: string }
  | { kind: "remove-question"; question: string }
  | { kind: "reask"; question: string }
  | { kind: "import"; target: "examples" | "pool"; pick: CsvPick }
  | { kind: "merge-option"; question: string; from: string; into: string; impact: Impact | null }
  | { kind: "use-prompt"; index: number }
  | { kind: "new" }
  | { kind: "key"; variable: string; provider: string }
  | { kind: "remove-key"; variable: string }
  | { kind: "remove-endpoint"; which: "ollama" | "openai_compatible" }
  | { kind: "install-help"; extra: string }
  | { kind: "remove-example"; key: string; set: "tuning" | "test"; text: string }
  | { kind: "delete-model"; info: DeleteInfo | null; keep: boolean }
  | { kind: "export"; opts: ExportOptions | null; format: ExportFormat | null; half: boolean; done: ExportResult | null; err: string | null }
  | { kind: "folder"; which: Folder; path: string; info: FolderInfo | null; err: string | null; move: boolean };

export interface View {
  set: "all" | SetName; filter: Filter; q: number | "all"; aq: number; aqFor: string | null; sel: number; search: string;
  sort: { col: string; dir: 1 | -1 } | null;
}
export const freshView = (): View => ({ set: "all", filter: "all", q: 0, aq: 0, aqFor: null, sel: 0, search: "", sort: null });

const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

export const S = {
  route: { page: "home" } as Route,
  models: null as ModelSummary[] | null,
  modelsErr: null as string | null,
  model: null as Model | null,
  modelErr: null as string | null,
  view: freshView(),
  rows: [] as Row[],
  total: 0,
  matched: 0,
  rowsLoading: false,
  rowsErr: null as string | null,
  /** Typed-in documents per model, shown under the table. */
  tries: {} as Record<string, Row[]>,
  /** Answers picked in Details but not saved yet, per row key. */
  picks: {} as Record<string, (string | null)[]>,
  insp: true,
  sideHidden: stored("studio.side") === "hidden",
  wizard: null as Wizard | null,
  guide: null as { tab: GuideTab } | null,
  /** Column widths the user dragged, per model, by column key. */
  colW: {} as Record<string, Record<string, number>>,
  /** The title bar's search across models and documents; expanded while it has focus. */
  find: { q: "", open: false, results: null as SearchResults | null, expanded: false },
  /** A search to apply once the model it points at has opened. */
  pendingSearch: null as { set: SetName; search: string } | null,
  allMethods: true,
  twoLine: stored("studio.rows") === "2",
  pane: null as Pane | null,
  sheet: null as Sheet | null,
  menu: null as { col: string; x: number; y: number } | null,
  gridFocus: false,
  jobs: null as JobsList | null,
  settings: null as Settings | null,
  /** What each teacher name needs (litellm's provider and key), by name; null while asking. */
  teacherKeys: {} as Record<string, TeacherKey | null>,
  settingsErr: null as string | null,
  task: null as { saved: Task; draft: Task } | null,
  taskErr: null as string | null,
  dirty: false,
  prompt: null as PromptInfo | null,
  promptErr: null as string | null,
  promptView: null as number | null,
  comparePick: null as Record<string, boolean> | null,
  report: null as Record<string, unknown> | null,
  reportErr: null as string | null,
  busy: false,
  /** The Playground: models to try, the documents typed, and local answers by pick and text. */
  play: { models: null as PlayModel[] | null, err: null as string | null, picks: [] as PlayPick[], docs: [] as PlayDoc[],
          local: {} as Record<string, Record<string, PlayCell>>, running: false, asking: {} as Record<string, boolean>, loaded: false },
  /** Set while the server restarts on other folders; the page reloads when it's back. */
  restarting: null as { boot: string; path: string; failed: boolean } | null,
};

export const isPanel = (m: Model) => m.kind === "panel";
export const done = (m: Model) => m.methods.filter(x => x.state === "done");
export const shipped = (m: Model) => m.methods.find(x => x.shipped);
/** Methods you compared, without the shipped one's as-compared copy. */
export const compared = (m: Model) => done(m).filter(x => !x.original);
/** What 1,000 documents cost across the teachers, or null before a check has measured it. */
export const perK = (m: Model) =>
  m.priced === false || m.teachers.some(t => t.per1k == null) ? null : m.teachers.reduce((s, t) => s + t.per1k!, 0);
export const reviewing = () => S.view.filter === "needs";
export const qIdx = (m: Model) => (S.view.q === "all" ? m.questions.map((_, j) => j) : [S.view.q]);
/** The rows the table shows: the loaded page, sorted if asked, then typed-in documents. */
export function shownRows(): Row[] {
  const m = S.model;
  if (!m) return [];
  let rows = S.rows;
  const sort = S.view.sort;
  if (sort) {
    const order = { pool: 0, tuning: 1, test: 2, try: 3 };
    const j = qIdx(m)[0];
    const conf = (r: Row) => r.methods[sort.col]?.p?.[j] ?? -1;
    rows = rows.slice().sort((a, b) => order[a.set] - order[b.set] || sort.dir * (conf(a) - conf(b)));
  }
  const tries = S.view.filter === "all" && !S.view.search ? S.tries[m.id] ?? [] : [];
  return rows.concat(tries);
}
export const currentRow = () => shownRows()[S.view.sel];

/** The panel question the number keys answer on row `r`: on a newly selected row, the first one
 * it's queued for review on, else the first question. */
export function activeQ(m: Model, r: Row | undefined): number {
  if (!isPanel(m) || !r) return 0;
  if (S.view.aqFor !== r.key) {
    S.view.aq = firstFlagged(m, r, -1) ?? 0;
    S.view.aqFor = r.key;
  }
  return S.view.aq;
}

/** The first question after `j` that row `r` is queued for, or null. */
export function firstFlagged(m: Model, r: Row, j: number): number | null {
  const at = (r.flagged ?? []).map(id => m.questions.findIndex(q => q.id === id)).filter(i => i > j);
  return at.length ? Math.min(...at) : null;
}
