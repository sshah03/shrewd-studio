// The menu under a column name: filters for a teacher; sort, ship, report and remove for a method.
import type { Model } from "../api";
import { S } from "../state";

export function menu(m: Model) {
  if (!S.menu) return "";
  const { col, x, y } = S.menu;
  let items: [string, string][];
  if (col.startsWith("t")) {
    items = [["Rows where it differs from you", "f-vsyou"], ...(m.teachers.length > 1 ? [["Rows where teachers disagree", "f-disagree"]] as [string, string][] : []), ["sep", ""], ["Edit teachers", "pane-task"]];
  } else {
    const meth = m.methods.find(z => z.id === col.slice(2));
    if (!meth) return "";
    items = meth.state === "done"
      ? [["Sort by confidence, lowest first", "sort-asc"], ["Sort by confidence, highest first", "sort-desc"],
         ...(meth.original ? [] : meth.shipped ? [["sep", ""], ["Report", "report"], ["Ship again…", "ship-this"]] as [string, string][]
           : [["sep", ""], ["Ship…", "ship-this"], ["sep", ""], ["Remove…", "confirm-remove-method"]] as [string, string][])]
      : meth.state === "running" ? [["Pause", "job-pause"], ["Cancel", "job-cancel"]]
      : meth.state === "paused" ? [["Resume", "job-resume"], ["Cancel", "job-cancel"]]
      : [["Cancel", "job-cancel"]];
  }
  return `<div class="menu" role="menu" style="left:${x}px;top:${y}px">${items.map(([l, a]) => l === "sep" ? '<div class="sep" role="separator"></div>' : `<button role="menuitem" data-act="${a}">${l}</button>`).join("")}</div>`;
}
