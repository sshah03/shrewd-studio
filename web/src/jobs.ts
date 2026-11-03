// Background jobs. While anything is queued or running, poll GET /api/jobs every 1.5 s. When a job
// finishes, refresh the sidebar and, if its model is open, the model and its rows.
import { api, type Job } from "./api";
import { answerPlayground, loadModels, loadModel, loadRows, loadSettings } from "./data";
import { renderJobs } from "./render";
import { S } from "./state";
import { toast } from "./util";

let timer: number | undefined;
let inflight = false;
let again = false;
/** Jobs started from this window, so one that ends before the next poll still refreshes its model. */
const watched = new Set<string>();

const active = (j: Job) => j.state === "running" || j.state === "queued";
const sig = (jobs: Job[]) => JSON.stringify(jobs.map(j => [j.id, j.state, j.progress, j.message]));

async function tick() {
  timer = undefined;
  inflight = true;
  let next;
  try {
    next = await api.jobs();
  } catch {
    inflight = false;
    if (again || S.jobs?.now.some(active)) { again = false; schedule(); }
    return;
  }
  inflight = false;
  const before = S.jobs;
  const was = new Map((before?.now ?? []).map(j => [j.id, j.state]));
  const ended = next.finished.filter(j => was.has(j.id) || watched.has(j.id));
  for (const j of ended) watched.delete(j.id);
  const changed = !before || sig(before.now) !== sig(next.now) || before.finished.length !== next.finished.length;
  S.jobs = next;
  for (const j of ended) {
    if (j.kind === "install") {      // not about a model: "Install SetFit"
      const what = j.title.replace(/^Install /, "");
      if (j.state === "failed") toast(`${what} didn't install${j.error ? `: ${j.error}` : "."} Settings has a guide.`);
      else if (j.state === "done") toast(`${what} is installed.`);
    } else if (j.state === "failed") toast(`${j.model_name}: ${j.title.toLowerCase()} failed${j.error ? `. ${j.error}` : ""}`);
    else if (j.state === "done") toast(`${j.model_name}: ${j.title.toLowerCase()} finished`);
  }
  if (ended.some(j => j.kind === "install")) {
    // a method that couldn't answer without this extra can now: fill in what's on screen
    const fill = ended.some(j => j.kind === "install" && j.state === "done");
    void loadSettings().then(() => {
      if (!fill) return;
      if (S.route.page === "playground") void answerPlayground();
      else if (S.route.page === "model") void loadRows(true);
    });
  }
  if (ended.length) {
    void loadModels();
    const open = S.route.page === "model" ? S.route.id : null;
    if (open && ended.some(j => j.model === open)) { void loadModel(open); void loadRows(true); }
  }
  if (changed) renderJobs();
  if (again) { again = false; void tick(); }
  else if (next.now.some(active)) schedule();
}

function schedule() {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => void tick(), 1500);
}

/** Follow jobs the server just accepted, then poll. */
export function trackJobs(started: Job | Job[] | null | undefined) {
  for (const j of [started ?? []].flat()) {
    if (!j || !j.id) continue;
    watched.add(j.id);
    // listed right away, so what redraws before the next poll (the header's next step) knows
    if (S.jobs && !S.jobs.now.some(x => x.id === j.id)) S.jobs.now = [...S.jobs.now, j];
  }
  pollJobs();
}

/** Check jobs now (after starting one, or on load); polling continues while any is active. */
export function pollJobs() {
  if (inflight) { again = true; return; }
  window.clearTimeout(timer);
  timer = undefined;
  void tick();
}

export const jobFor = (id: string | null) => (id ? S.jobs?.now.find(j => j.id === id) ?? null : null);
