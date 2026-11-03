// Reading a CSV in the browser, for column choices and previews before uploading.

/** Headers and up to `limit` rows. Handles quoted fields, doubled quotes and newlines in quotes. */
export function readCsv(text: string, limit = 200): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const end = () => { row.push(field); field = ""; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") end();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      end();
      if (row.some(f => f !== "")) rows.push(row);
      row = [];
      if (rows.length > limit) break;
    } else field += c;
  }
  if (field || row.length) { end(); if (row.some(f => f !== "")) rows.push(row); }
  const headers = (rows.shift() ?? []).map(h => h.trim());
  return { headers, rows: rows.slice(0, limit) };
}

/** The header that most likely holds `what`, by name. */
export function guessColumn(headers: string[], names: string[]) {
  const lower = headers.map(h => h.toLowerCase());
  for (const n of names) { const i = lower.indexOf(n); if (i >= 0) return headers[i]; }
  return "";
}
