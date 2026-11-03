// The Jobs page: what's running or waiting, and what finished.
import type { Job } from "../api";
import { S } from "../state";
import { esc, n, pctOf, usd, when } from "../util";

function actions(j: Job) {
  const id = esc(j.id);
  if (j.state === "running" && j.kind === "install") return `<button class="btn plain danger" data-job-act="cancel" data-job="${id}">Cancel</button>`;
  if (j.state === "running") return `<button class="btn" data-job-act="pause" data-job="${id}">Pause</button><button class="btn plain danger" data-job-act="cancel" data-job="${id}">Cancel</button>`;
  if (j.state === "paused") return `<button class="btn default" data-job-act="resume" data-job="${id}">Resume</button><button class="btn plain danger" data-job-act="cancel" data-job="${id}">Cancel</button>`;
  return `<button class="btn plain danger" data-job-act="cancel" data-job="${id}">Cancel</button>`;
}

function note(j: Job) {
  if (j.message) return j.message;
  return j.state === "queued" ? "Waiting" : j.state === "paused" ? "Paused" : "";
}

/** Seconds as "3 s", "2 min 5 s" or "1 h 4 min". */
function duration(seconds: number | null | undefined) {
  if (seconds == null) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

function took(j: Job) {
  if (j.state === "failed") return `<span class="err" title="${esc(j.error ?? "")}">Failed</span>`;
  if (j.state === "cancelled") return '<span class="dim">Cancelled</span>';
  return esc([duration(j.took), j.cost ? usd(j.cost) : ""].filter(Boolean).join(", "));
}

export function jobsPage() {
  const J = S.jobs;
  if (!J) return '<div class="jobs" data-keep-scroll="jobs"><h1>Jobs</h1><p class="dim" style="margin:0">Loading…</p></div>';
  const { cpu, gpu } = J.limits;
  const limits = `This computer runs up to ${n(cpu)} CPU job${cpu === 1 ? "" : "s"} and ${n(gpu)} GPU job${gpu === 1 ? "" : "s"} at a time. Labeling follows each provider's rate limits. Change this in <a href="#/settings" style="color:inherit">Settings</a>.`;
  if (!J.now.length && !J.finished.length) return `<div class="jobs" data-keep-scroll="jobs">
    <h1>Jobs</h1>
    <div class="jobs-empty"><h2>No jobs</h2>
      <p>Checking teachers, labeling the pool, comparing methods and shipping all run here, so you can leave a model while they work. Running jobs can be paused and resumed: labeling carries on from the last answer, and fine-tuning from the last finished epoch.</p>
      <p class="dim">${limits}</p></div>
  </div>`;
  return `<div class="jobs" data-keep-scroll="jobs">
    <h1>Jobs</h1>
    <section><h2>Now</h2>
      <table class="mini"><thead><tr><th>Model</th><th>Job</th><th>Uses</th><th>Progress</th><th></th></tr></thead><tbody>
      ${J.now.map(j => `<tr><td>${j.model ? `<a href="#/m/${encodeURIComponent(j.model)}" style="color:inherit;text-decoration:none">${esc(j.model_name)}</a>` : esc(j.model_name)}</td><td>${esc(j.title)}</td><td class="dim">${esc(j.uses)}</td>
        <td><span class="meter ${j.state === "paused" ? "paused" : ""}" role="progressbar" aria-label="${esc(j.title)}" aria-valuenow="${pctOf(j.progress)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pctOf(j.progress)}%"></i></span><span class="dim">${esc(note(j))}</span></td><td class="r">${actions(j)}</td></tr>`).join("")}
      ${J.now.length ? "" : '<tr><td colspan="5" class="dim">Nothing running.</td></tr>'}
      </tbody></table>
      <p class="dim" style="margin:0">${limits}</p></section>
    <section><div class="inline"><h2>Finished</h2><div class="grow"></div>${J.finished.length ? '<button class="btn plain" data-act="jobs-clear" title="Removes finished jobs from this list. Files they made stay in each model\'s folder.">Clear</button>' : ""}</div>
      <table class="mini"><thead><tr><th>Model</th><th>Job</th><th>Uses</th><th class="r">Took</th><th class="r">When</th><th></th></tr></thead><tbody>
      ${J.finished.map(j => `<tr><td>${esc(j.model_name)}</td><td>${esc(j.title)}</td><td class="dim">${esc(j.uses)}</td><td class="r">${took(j)}</td><td class="r dim">${esc(when(j.finished))}</td><td class="r">${j.download ? `<a class="btn" href="${esc(j.download)}" download>Download</a>` : ""}</td></tr>`).join("")}
      ${J.finished.length ? "" : '<tr><td colspan="6" class="dim">No finished jobs yet.</td></tr>'}
      </tbody></table></section>
  </div>`;
}
