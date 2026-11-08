// Drawing S into the page. The window has three regions: the sidebar, the page (model, Jobs or
// Settings) and the layer above it (drawer, menu, sheet). render() redraws all three, keeping focus,
// caret and scroll positions; the narrower functions below redraw less for frequent updates.
import { preserveFocus } from "./focus";
import { S, currentRow, shownRows } from "./state";
import { esc } from "./util";
import { detailsPane } from "./views/details";
import { drawer } from "./views/drawers";
import { firstRun, guideModal } from "./views/guide";
import { wizard } from "./views/newmodel";
import { jobsPage } from "./views/jobs";
import { menu } from "./views/menu";
import { modelPage, statusLead } from "./views/model";
import { settingsPage } from "./views/settings";
import { playgroundPage } from "./views/playground";
import { sheet } from "./views/sheets";
import { sidebar } from "./views/sidebar";
import { drawTitlebar } from "./views/titlebar";
import { rowHtml, rowTop, tableWindow, tbodyHtml, thead } from "./views/table";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function page() {
  const r = S.route;
  if (r.page === "jobs") return jobsPage();
  if (r.page === "settings") return settingsPage();
  if (r.page === "playground") return playgroundPage();
  if (r.page === "home") {
    if (S.models && !S.models.length) return `<div class="welcome"><div class="welcome-in">
      <h1>Shrewd Studio</h1>
      <p>Label a few hundred documents yourself, let LLM teachers label the rest, and ship a small model that runs on this computer. You can see where the teachers agree with you, and with each other, at every step.</p>
      ${firstRun()}
      <p class="dim">After that, the button at the top right of each model is always the next step. <button class="link" data-act="guide" data-tab="flow">How it works</button></p>
    </div></div>`;
    return `<div class="blank">${S.modelsErr ? `<p class="err" style="margin:0">${esc(S.modelsErr)}</p><button class="btn" data-act="reload-models">Try again</button>` : '<span class="dim">Loading…</span>'}</div>`;
  }
  if (!S.model) return `<div class="blank">${S.modelErr ? `<p class="err" style="margin:0">${esc(S.modelErr)}</p><button class="btn" data-act="reload-model">Try again</button>` : '<span class="dim">Loading…</span>'}</div>`;
  return modelPage(S.model);
}

/** While the server restarts on other folders. Nothing can be done meanwhile, so it has no buttons. */
function restarting() {
  const r = S.restarting;
  if (!r) return "";
  return `<div class="scrim still"><div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="rs-title">
    <h2 id="rs-title">${r.failed ? "Studio didn't come back" : "Restarting Studio…"}</h2>
    <p>${r.failed ? "Quit Studio and open it again. Your folders are saved, so it opens on the new one." : `Opening ${esc(r.path)}.`}</p></div></div>`;
}

let layerKey = "";
let wizardOpen = false, guideOpen = false;
function layer() {
  const m = S.route.page === "model" ? S.model : null;
  const key = `${m ? S.pane ?? "" : ""}|${S.sheet ? S.sheet.kind : ""}`;
  const paneStill = !!m && !!S.pane && layerKey.split("|")[0] === S.pane;
  const sheetStill = !!S.sheet && layerKey.split("|")[1] === S.sheet.kind;
  layerKey = key;
  const wizardStill = !!S.wizard && wizardOpen, guideStill = !!S.guide && guideOpen;
  wizardOpen = !!S.wizard; guideOpen = !!S.guide;
  const html = (m && S.pane ? drawer(m, paneStill) : "") + (m && S.menu ? menu(m) : "") + (S.wizard ? wizard(S.wizard, wizardStill) : "")
    + (S.guide ? guideModal(S.guide.tab, guideStill) : "") + (S.sheet ? sheet(m, S.sheet, sheetStill) : "") + restarting();
  return { html, sheetOpened: !!S.sheet && !sheetStill, paneOpened: !!S.pane && !paneStill };
}

export function render() {
  let l = { html: "", sheetOpened: false, paneOpened: false };
  preserveFocus(() => {
    drawTitlebar($("titlebar"));
    $("app").classList.toggle("side-hidden", S.sideHidden);
    $("side").innerHTML = sidebar();
    $("view").innerHTML = page();
    l = layer();
    $("layer").innerHTML = l.html;
  });
  afterRender(l.sheetOpened, l.paneOpened);
}

/** Only the title bar (search results as you type). */
export function renderTitlebar() {
  preserveFocus(() => drawTitlebar($("titlebar")));
}

/** Only the layer (a drawer's contents, a menu, a sheet). */
export function renderLayer() {
  let l = { html: "", sheetOpened: false, paneOpened: false };
  preserveFocus(() => { l = layer(); $("layer").innerHTML = l.html; });
  afterRender(l.sheetOpened, l.paneOpened);
}

/** Row heights as drawn, so the spacer rows of a windowed table match them (two-line rows, a
 * different font size). Redraws the window once if the guess was off. */
function measureRows(redraw = true) {
  const row = document.querySelector<HTMLElement>(".t tbody tr.r")?.getBoundingClientRect().height;
  const group = document.querySelector<HTMLElement>(".t tbody tr.group")?.getBoundingClientRect().height;
  let changed = false;
  if (row && Math.abs(row - tableWindow.rowH) > 0.5) { tableWindow.rowH = row; changed = true; }
  if (group && Math.abs(group - tableWindow.groupH) > 0.5) { tableWindow.groupH = group; changed = true; }
  if (changed && redraw && tableWindow.on) renderWindow();
}

/** Redraw only the table body, for the rows now near the visible part of a windowed table. */
export function renderWindow() {
  const m = S.model, tb = document.querySelector(".t tbody"), box = document.querySelector<HTMLElement>(".tablebox");
  if (!m || !tb || !box) return;
  tableWindow.top = box.scrollTop; tableWindow.height = box.clientHeight;
  preserveFocus(() => { tb.innerHTML = tbodyHtml(m, shownRows()); });
  measureRows(false);
}

let windowFrame = 0;
/** After a scroll: redraw the window once the visible rows near the edge of what's drawn. */
export function scrolledTable(box: HTMLElement) {
  tableWindow.top = box.scrollTop; tableWindow.height = box.clientHeight;
  if (windowFrame) return;
  windowFrame = requestAnimationFrame(() => {
    windowFrame = 0;
    if (tableWindow.on) {
      const h = tableWindow.rowH || 37, n = shownRows().length;
      const first = Math.floor(tableWindow.top / h), last = Math.ceil((tableWindow.top + tableWindow.height) / h);
      if ((first < tableWindow.start + 15 && tableWindow.start > 0) || (last > tableWindow.end - 15 && tableWindow.end < n)) renderWindow();
    }
    showRange();
  });
}

/** Which rows are on screen, for the status line once the table is scrolled. */
function showRange() {
  const box = document.querySelector<HTMLElement>(".tablebox"), m = S.model;
  if (!box || !m) return;
  const bottom = box.getBoundingClientRect().bottom;
  // the header cells are sticky, not the thead, so measure where the last header row's cells are
  const top = box.querySelector("thead tr:last-child th")?.getBoundingClientRect().bottom ?? box.getBoundingClientRect().top;
  let first = -1, last = -1;
  for (const tr of box.querySelectorAll<HTMLElement>("tbody tr.r")) {
    const r = tr.getBoundingClientRect();
    if (r.bottom > top + 4 && r.top < bottom - 4) { const i = Number(tr.dataset.row); if (first < 0) first = i; last = i; }
  }
  tableWindow.range = first < 0 ? null : [first, last];
  const lead = document.querySelector(".status .lead");
  if (lead) lead.textContent = statusLead(m);
}

/** Make sure row i is drawn, scrolling it into the middle of a windowed table if it isn't. */
function showRow(i: number) {
  const box = document.querySelector<HTMLElement>(".tablebox");
  if (!tableWindow.on || !box || (i >= tableWindow.start && i < tableWindow.end)) return;
  box.scrollTop = Math.max(0, rowTop(i) - box.clientHeight / 2);
  renderWindow();
}

function afterRender(sheetOpened: boolean, paneOpened: boolean) {
  measureRows();
  showRange();
  if (sheetOpened) document.querySelector<HTMLElement>(".sheet input:not([disabled]), .sheet select, .sheet button:not([disabled])")?.focus();
  else if (paneOpened) document.querySelector<HTMLElement>(".drawer .dhead button")?.focus();
  else if (S.gridFocus && !S.sheet && !S.pane && !S.menu) focusRow();
  const sel = document.querySelector('.t tr.r[aria-selected="true"]');
  if (sel && S.gridFocus) sel.scrollIntoView({ block: "nearest" });
  document.querySelector(".right .qb.act")?.scrollIntoView({ block: "nearest" });   // the question keys answer
}

function focusRow() {
  const a = document.activeElement;
  if (a && a !== document.body && !a.closest(".t tr.r") && a.matches("input, textarea, select")) return;
  document.querySelector<HTMLElement>('.t tr.r[aria-selected="true"]')?.focus({ preventScroll: true });
}

/** Move the selection without redrawing the table: two rows and the Details column. */
export function renderSelection(prev: number) {
  const m = S.model;
  if (!m) return;
  const rows = shownRows();
  showRow(S.view.sel);
  const tb = document.querySelector(".t tbody");
  for (const i of [prev, S.view.sel]) {
    const tr = tb?.querySelector<HTMLElement>(`tr.r[data-row="${i}"]`);
    if (!tr || !rows[i]) continue;
    tr.setAttribute("aria-selected", String(i === S.view.sel));
    tr.tabIndex = i === S.view.sel ? 0 : -1;
  }
  renderDetails();
  focusRow();
  document.querySelector('.t tr.r[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

/** Redraw one row in place (after picking or saving an answer) and the Details column. */
export function renderRow(i: number) {
  const m = S.model;
  const r = shownRows()[i];
  const tr = document.querySelector<HTMLElement>(`.t tr.r[data-row="${i}"]`);
  if (!m || !r || !tr) return;
  const hadFocus = tr.contains(document.activeElement);
  const tmp = document.createElement("tbody");
  tmp.innerHTML = rowHtml(m, r, i);
  const next = tmp.firstElementChild as HTMLElement;
  tr.replaceWith(next);
  if (hadFocus) next.focus({ preventScroll: true });
}

export function renderDetails() {
  const m = S.model;
  const aside = document.querySelector(".right");
  if (!m || !aside) return;
  preserveFocus(() => { aside.innerHTML = detailsPane(m, currentRow()); });
  aside.querySelector(".qb.act")?.scrollIntoView({ block: "nearest" });
}

/** After a jobs poll: the sidebar count, the Jobs page, and progress in method column headers. */
export function renderJobs() {
  preserveFocus(() => {
    drawTitlebar($("titlebar"));
    $("side").innerHTML = sidebar();
    if (S.route.page === "jobs") $("view").innerHTML = jobsPage();
    else if (S.route.page === "settings" && S.jobs?.now.some(j => j.kind === "install")) $("view").innerHTML = settingsPage();
    else if (S.route.page === "model" && S.model) {
      const th = document.querySelector(".t thead");
      if (th && S.model.methods.some(x => x.job)) th.outerHTML = thead(S.model);
    }
  });
}
