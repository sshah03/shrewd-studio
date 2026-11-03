// The title bar: search across every model in the middle, and what's running on the right.
// In the app the traffic lights sit at its left end.
import { S } from "../state";
import { esc } from "../util";
import { mod } from "../system";

const ICON_FIND = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3" stroke-linecap="round"/></svg>';

export function titlebar() {
  return `<div class="tb-left" data-tauri-drag-region></div>
    <div class="tb-find" data-tauri-drag-region>
      <label class="find">${ICON_FIND}<input id="find" type="search" placeholder="Search models and documents" value="${esc(S.find.q)}" aria-label="Search models and documents" autocomplete="off"><kbd>${mod()}K</kbd></label>
      ${S.find.open && S.find.results ? findResults() : ""}
    </div>
    <div class="tb-right" data-tauri-drag-region>${jobsIndicator()}</div>`;
}

function findResults() {
  const r = S.find.results!;
  if (!r.models.length && !r.documents.length) return `<div class="find-pop" role="listbox"><div class="find-empty">Nothing matches “${esc(S.find.q)}”.</div></div>`;
  const set = { pool: "Pool", tuning: "Tuning", test: "Test" } as Record<string, string>;
  return `<div class="find-pop" role="listbox" aria-label="Results">
    ${r.models.length ? `<div class="find-h">Models</div>${r.models.map(m => `<button role="option" data-act="find-model" data-id="${esc(m.id)}">${esc(m.name)}</button>`).join("")}` : ""}
    ${r.documents.length ? `<div class="find-h">Documents</div>${r.documents.map(d => `<button role="option" data-act="find-doc" data-id="${esc(d.model)}" data-set="${esc(d.set)}"><span class="find-text">${esc(d.text)}</span><span class="dim">${esc(d.model_name)}, ${set[d.set] ?? d.set}</span></button>`).join("")}` : ""}
  </div>`;
}

function jobsIndicator() {
  const now = S.jobs?.now ?? [];
  const running = now.filter(j => j.state === "running");
  const waiting = now.filter(j => j.state === "queued").length;
  if (!running.length) return waiting ? `<button class="tb-jobs" data-act="jobs">${waiting} waiting</button>` : "";
  const j = running[0];
  const pct = j.progress == null ? null : Math.round(j.progress * 100);
  const more = running.length - 1 + waiting;
  return `<button class="tb-jobs" data-act="jobs" title="Open Jobs">
    <span class="tb-job">${esc(j.title)}</span>${pct == null ? "" : `<span class="tb-bar" aria-hidden="true"><i style="width:${pct}%"></i></span><span class="tb-pct">${pct}%</span>`}${more ? `<span class="dim">+${more}</span>` : ""}</button>`;
}
