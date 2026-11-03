import type { Kind, ModelSummary } from "../api";
import { S } from "../state";
import { ICON_GEAR, ICON_JOBS, ICON_PLUS, esc, n } from "../util";

function status(m: ModelSummary) {
  if (m.review) return `<span class="c needs" aria-label="${n(m.review)} need you">${n(m.review)}</span>`;
  if (m.paused) return '<span class="c">paused</span>';
  if (m.archived) return '<span class="c">archived</span>';
  if (m.stage === "examples") return '<span class="c">new</span>';
  return "";
}

function group(title: string, kind: Kind) {
  const open = S.route.page === "model" ? S.route.id : null;
  const items = (S.models ?? []).filter(m => m.kind === kind);
  if (!items.length) return "";
  return `<h3>${title}</h3>` + items.map(m => `
    <button class="nav" data-model="${esc(m.id)}" title="${esc(m.how)}" ${m.id === open ? 'aria-current="page"' : ""}><span class="lbl">${esc(m.name)}</span>${status(m)}</button>`).join("");
}

function jobsCount() {
  const now = S.jobs?.now ?? [];
  const running = now.filter(j => j.state === "running").length;
  const waiting = now.filter(j => j.state === "queued").length;
  if (running) return `<span class="c">${running} running</span>`;
  if (waiting) return `<span class="c">${waiting} waiting</span>`;
  return "";
}

const ICON_GUIDE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.6c0 1.1-1.6 1.4-1.6 2.4" stroke-linecap="round"/><circle cx="8" cy="11.3" r=".55" fill="currentColor" stroke="none"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5 7 8l-2 1.5M8.5 10H11" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_COLLAPSE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6.5 3v10"/></svg>';

export function sidebar() {
  if (S.sideHidden) {
    const busy = (S.jobs?.now ?? []).some(j => j.state === "running");
    return `<nav class="side rail" aria-label="Models">
    <button class="icon" data-act="toggle-side" title="Show sidebar" aria-label="Show sidebar" aria-expanded="false">${ICON_COLLAPSE}</button>
    <button class="icon" data-act="new" title="New model" aria-label="New model">${ICON_PLUS}</button>
    <div class="grow"></div>
    <button class="icon" data-act="playground" title="Playground" aria-label="Playground" ${S.route.page === "playground" ? 'aria-current="page"' : ""}>${ICON_PLAY}</button>
    <button class="icon" data-act="guide" title="Help" aria-label="Help" ${S.guide ? 'aria-current="page"' : ""}>${ICON_GUIDE}</button>
    <button class="icon ${busy ? "busy" : ""}" data-act="jobs" title="${busy ? "Jobs, running" : "Jobs"}" aria-label="Jobs" ${S.route.page === "jobs" ? 'aria-current="page"' : ""}>${ICON_JOBS}</button>
    <button class="icon" data-act="settings" title="Settings" aria-label="Settings" ${S.route.page === "settings" ? 'aria-current="page"' : ""}>${ICON_GEAR}</button>
  </nav>`;
  }
  const err = S.modelsErr && !S.models ? `<p class="err" style="margin:12px 9px;font-size:12px">${esc(S.modelsErr)}</p>` : "";
  return `<nav class="side" aria-label="Models">
    <div class="brand"><b>shrewd</b><span>studio</span><div class="brand-acts"><button class="icon" data-act="new" title="New model" aria-label="New model">${ICON_PLUS}</button><button class="icon" data-act="toggle-side" title="Hide sidebar" aria-label="Hide sidebar" aria-expanded="true">${ICON_COLLAPSE}</button></div></div>
    <div class="side-scroll" data-keep-scroll="side">${err}${group("Classifiers", "classifier")}${group("Decision panels", "panel")}</div>
    <div class="side-foot">
      <button class="nav" data-act="playground" ${S.route.page === "playground" ? 'aria-current="page"' : ""}>${ICON_PLAY}<span class="lbl">Playground</span></button>
      <button class="nav" data-act="guide" ${S.guide ? 'aria-current="page"' : ""}>${ICON_GUIDE}<span class="lbl">Help</span></button>
      <button class="nav" data-act="jobs" ${S.route.page === "jobs" ? 'aria-current="page"' : ""}>${ICON_JOBS}<span class="lbl">Jobs</span>${jobsCount()}</button>
      <button class="nav" data-act="settings" ${S.route.page === "settings" ? 'aria-current="page"' : ""}>${ICON_GEAR}<span class="lbl">Settings</span></button>
    </div>
  </nav>`;
}
