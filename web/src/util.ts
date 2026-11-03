/** Escape every interpolated value that came from the user or the server. */
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const n = (x: number) => x.toLocaleString("en-US");
export const usd = (x: number) => "$" + (x < 0.1 ? x.toFixed(3) : x.toFixed(2));
/** An estimate: "~$0.034"; nothing is "$0", and a fraction of a tenth of a cent "under $0.001". */
export const approx = (x: number) => (x <= 0 ? "$0" : x < 0.0005 ? "under $0.001" : `~${usd(x)}`);
export const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Progress is an integer percent; a fraction in (0, 1) is read as a share, in case a server sends one. */
export const pctOf = (v: number | null | undefined) => {
  if (v == null || Number.isNaN(v)) return 0;
  const p = v > 0 && v < 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(p)));
};

/** "Today 13:52", "Yesterday", "Oct 21"; anything that isn't a date is shown as is. */
export function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 864e5);
  if (diff === 0) return `Today ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

export const ICON_TAG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2.5 8.6V3a.5.5 0 0 1 .5-.5h5.6l5 5-6 6z" stroke-linejoin="round"/><circle cx="5.5" cy="5.5" r="1"/></svg>';
export const ICON_PANEL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 6h6M5 8.5h6M5 11h3.5" stroke-linecap="round"/></svg>';
export const ICON_JOBS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3" stroke-linecap="round"/></svg>';
export const ICON_GEAR = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M12.63 6.40 L14.36 6.65 L14.36 9.35 L12.63 9.60 L12.40 10.15 L13.45 11.54 L11.54 13.45 L10.15 12.40 L9.60 12.63 L9.35 14.36 L6.65 14.36 L6.40 12.63 L5.85 12.40 L4.46 13.45 L2.55 11.54 L3.60 10.15 L3.37 9.60 L1.64 9.35 L1.64 6.65 L3.37 6.40 L3.60 5.85 L2.55 4.46 L4.46 2.55 L5.85 3.60 L6.40 3.37 L6.65 1.64 L9.35 1.64 L9.60 3.37 L10.15 3.60 L11.54 2.55 L13.45 4.46 L12.40 5.85Z"/><circle cx="8" cy="8" r="2.1"/></svg>';
export const ICON_PLUS = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke-linecap="round"/></svg>';

let toastTimer: number | undefined;
export function toast(text: string) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 4200);
}

/** A method's size with what it loads from Hugging Face counted in, and a sentence saying so. */
export function methodSize(x: { mb: number | null; base?: { name: string; mb: number | null } | null }): { text: string; why: string } | null {
  if (x.mb == null) return null;
  if (!x.base) return { text: size(x.mb), why: "" };
  const name = x.base.name.split("/").pop();
  return x.base.mb == null
    ? { text: `${size(x.mb)} + ${name}`, why: `Also loads ${name} from Hugging Face the first time it runs, so that computer needs to reach huggingface.co once.` }
    : { text: size(x.mb + x.base.mb), why: `Includes ${name} (${size(x.base.mb)}), which it loads from Hugging Face the first time it runs on a computer, so that computer needs to reach huggingface.co once.` };
}

/** A size given in MB, in MB or GB. */
export const size = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(mb * 1000))} KB`);

/** The shipped tag: what shipping means in shrewd, since it isn't a label you set. */
export const SHIPPED_TAG = '<span class="tag" title="What load() and Use… serve, retrained on everything labeled. The only method scored on your locked test examples. Ship another from Compare to replace it.">shipped</span>';
