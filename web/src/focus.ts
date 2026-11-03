// Re-rendering with innerHTML throws away the focused element. Before a render we note what had
// focus (its id, or its data-* attributes) and the caret, then put focus back on its replacement.

export function signature(el: HTMLElement): string | null {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const attrs = [...el.attributes].filter(a => a.name.startsWith("data-") || a.name === "name");
  if (!attrs.length) return null;
  return el.tagName.toLowerCase() + attrs.map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join("");
}

export function preserveFocus(render: () => void) {
  const el = document.activeElement as HTMLElement | null;
  const sel = el && el !== document.body ? signature(el) : null;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  let caret: [number | null, number | null] = [null, null];
  try { if (field) caret = [field.selectionStart, field.selectionEnd]; } catch { /* inputs without selection */ }
  const scrolls = [...document.querySelectorAll<HTMLElement>("[data-keep-scroll]")].map(x => [x.dataset.keepScroll!, x.scrollTop] as const);
  render();
  for (const [k, top] of scrolls) {
    const x = document.querySelector<HTMLElement>(`[data-keep-scroll="${k}"]`);
    if (x) x.scrollTop = top;
  }
  if (!sel || (el && document.contains(el))) return;
  const next = document.querySelector<HTMLElement>(sel);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) {
    try { if (caret[0] != null) next.setSelectionRange(caret[0], caret[1] ?? caret[0]); } catch { /* no selection on this type */ }
  }
}
