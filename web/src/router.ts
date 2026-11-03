// Hash routes: #/m/<id>, #/jobs, #/settings, #/playground. Anything else opens the first model.
import type { Route } from "./state";

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "m" && parts[1]) return { page: "model", id: parts[1] };
  if (parts[0] === "jobs") return { page: "jobs" };
  if (parts[0] === "settings") return { page: "settings" };
  if (parts[0] === "playground") return { page: "playground" };
  return { page: "home" };
}

export const href = (r: Route) =>
  r.page === "model" ? `#/m/${encodeURIComponent(r.id)}` : r.page === "home" ? "#/" : `#/${r.page}`;

export function navigate(to: string) {
  if (location.hash === to) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = to;
}

/** Change the address without a new history entry. */
export function replace(to: string) {
  try { history.replaceState(null, "", to); } catch { /* sandboxed */ }
}
