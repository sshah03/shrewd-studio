// The title bar: what's running, then search across every model, at its right end. Search is a
// magnifying glass that widens into a field when clicked or on ⌘K; the desktop app's View menu
// can keep it open ("Always Show Search", html.search-pinned).
// In the app the traffic lights sit at its left end.
//
// The search field is drawn once and kept: redrawing it would restart its widening and lose the
// caret, and the title bar is redrawn on every render (jobs polling). Only the status and the
// results are redrawn, and only when they change.
import { S } from "../state";
import { esc } from "../util";
import { mod } from "../system";

const ICON_FIND = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3" stroke-linecap="round"/></svg>';

function skeleton() {
  return `<div class="tb-left" data-tauri-drag-region></div>
    <div class="tb-mid" data-tauri-drag-region></div>
    <div class="tb-right" data-tauri-drag-region>
      <div class="tb-status" id="tb-status" data-tauri-drag-region></div>
      <div class="tb-find" id="tb-find">
        <label class="find" title="Search models and documents (${mod()}K)">${ICON_FIND}<input id="find" type="search" placeholder="Search models and documents" aria-label="Search models and documents" autocomplete="off"><kbd>${mod()}K</kbd></label>
        <div id="find-results"></div>
      </div>
    </div>`;
}

const drawn = new WeakMap<Element, string>();
function setHtml(el: Element | null, html: string) {
  if (!el || drawn.get(el) === html) return;
  drawn.set(el, html);
  el.innerHTML = html;
}

/** Draw the title bar into its element, keeping the search field if it's already there. */
export function drawTitlebar(box: HTMLElement) {
  if (!box.querySelector("#find")) box.innerHTML = skeleton();
  setHtml(box.querySelector("#tb-status"), sandboxNote() + jobsIndicator());
  setHtml(box.querySelector("#find-results"), S.find.open && S.find.results ? findResults() : "");
  box.querySelector("#tb-find")!.classList.toggle("open", S.find.expanded);
  const input = box.querySelector<HTMLInputElement>("#find")!;
  if (input.value !== S.find.q) input.value = S.find.q;
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

/** Sandbox mode, on every screen: its jobs show what real calls would have cost. */
function sandboxNote() {
  if (!S.settings?.sandbox) return "";
  return `<span class="tb-sandbox" title="Studio was started with --sandbox. Teachers are simulated on this computer, so nothing is sent anywhere and nothing is charged. Prices and costs show what the same calls would cost for real.">Sandbox: teachers are simulated</span>`;
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
