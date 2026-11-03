// The Playground: pick trained models (and which method of each), type documents, and see every
// answer side by side. Local answers are free; teachers answer a document only when asked.
import { A, fmtP } from "../answers";
import type { PlayCell, PlayDoc, PlayModel, PlayPick } from "../api";
import { pickKey } from "../data";
import { S } from "../state";
import { approx, esc, SHIPPED_TAG } from "../util";
import { mod } from "../system";

const modelOf = (id: string) => S.play.models?.find(x => x.id === id);

function picker(models: PlayModel[]) {
  const P = S.play;
  const chips = P.picks.map((p, i) => {
    const m = modelOf(p.model);
    if (!m) return "";
    return `<span class="pick"><b>${esc(m.name)}</b>
      <select data-play-method="${i}" aria-label="Method for ${esc(m.name)}">${m.methods.map(x => `<option value="${esc(x.id)}" ${x.id === p.method ? "selected" : ""}>${esc(x.name)}${x.shipped ? ", shipped" : ""}</option>`).join("")}</select>
      <button class="x" data-act="play-unpick" data-i="${i}" aria-label="Remove ${esc(m.name)}" title="Remove">✕</button></span>`;
  }).join("");
  return `<div class="play-picks">${chips}
    <select data-play-add aria-label="Add a model"><option value="">Add a model…</option>${models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></div>`;
}

/** One model's answer to one document: each question's answer and confidence, marked against
 * the teachers' answer once asked. */
function cell(m: PlayModel, p: PlayPick, d: PlayDoc) {
  const c: PlayCell | undefined = S.play.local[pickKey(p)]?.[d.text];
  if (!c) return `<td>${A("none", S.play.running ? "…" : "–")}</td>`;
  const theirs = d.asked?.[m.id];
  const multi = m.questions.length > 1;
  return `<td><div class="play-ans">${m.questions.map((q, j) => {
    const v = c.answers[j] ?? null;
    const ref = theirs?.[j] ?? null;
    // a difference matters more than routing, so ≠ wins and routing is noted beside it
    const cls = v == null ? "none" : ref != null && ref !== v ? "off" : c.routed ? "routed" : "agree";
    const note = [ref != null && ref !== v ? `teachers: ${ref}` : ref != null ? "teachers agree" : "",
      cls === "off" && c.routed ? "would go to the teachers" : ""].filter(Boolean).join(", ");
    return `<div>${multi ? `<small>${esc(q.id)}</small>` : ""}${A(cls, v ?? "–", fmtP(c.p?.[j]))}${note ? `<span class="sub">${esc(note)}</span>` : ""}</div>`;
  }).join("")}</div></td>`;
}

function askButton(d: PlayDoc, i: number) {
  const P = S.play;
  const unasked = [...new Set(P.picks.map(p => p.model))].map(modelOf).filter((m): m is PlayModel => !!m && !d.asked?.[m.id]);
  if (P.asking[d.text]) return '<span class="dim">Asking…</span>';
  if (!unasked.length) return "";
  const cost = unasked.some(m => m.per_doc == null) ? null : unasked.reduce((s, m) => s + m.per_doc!, 0);
  return `<button class="btn plain" data-act="play-ask" data-i="${i}" title="Each model's teachers answer this document. Answers are cached, so asking again is free.">Ask teachers${cost == null ? "" : `, ${approx(cost)}`}</button>`;
}

function results() {
  const P = S.play;
  if (!P.docs.length) return `<p class="dim play-hint">Answers appear here. Try the documents you expect, and awkward ones too: very short, misspelled, off-topic, two requests in one.</p>`;
  const cols = P.picks.map(p => ({ p, m: modelOf(p.model) })).filter((x): x is { p: PlayPick; m: PlayModel } => !!x.m);
  const head = cols.map(({ p, m }) => {
    const meth = m.methods.find(x => x.id === p.method);
    return `<th scope="col"><div class="colname">${esc(m.name)}</div><div class="sub">${esc(meth?.name ?? p.method)}${meth?.shipped ? SHIPPED_TAG : ""}</div></th>`;
  }).join("");
  return `<table class="mini play-t"><thead><tr><th scope="col">Document</th>${head}<th></th></tr></thead><tbody>
    ${P.docs.map((d, i) => `<tr><td class="play-doc"><div>${esc(d.text)}</div></td>
      ${cols.map(({ p, m }) => cell(m, p, d)).join("")}
      <td class="r play-acts">${askButton(d, i)}<button class="x" data-act="play-drop" data-i="${i}" aria-label="Remove this document" title="Remove">✕</button></td></tr>`).join("")}
    </tbody></table>
    <div class="play-foot"><div class="grow"></div><button class="btn plain" data-act="play-clear">Clear documents</button></div>`;
}

export function playgroundPage() {
  const P = S.play;
  const head = `<header class="play-head"><div><h1>Playground</h1>
      <p>Type documents and see what your models say. Local models answer for free, on this computer; teachers answer only when you ask.</p></div>
      <button class="btn plain" data-act="guide">How this works</button></header>`;
  if (!P.models) return `<div class="play" data-keep-scroll="play">${head}${P.err ? `<p class="err" style="margin:0">${esc(P.err)}</p>` : '<p class="dim" style="margin:0">Loading…</p>'}</div>`;
  if (!P.models.length) return `<div class="play" data-keep-scroll="play">${head}
    <div class="jobs-empty"><h2>No trained models yet</h2><p>The Playground uses models with at least one trained method. Open a model and compare methods; they train on this computer in seconds to minutes, for free.</p></div></div>`;
  return `<div class="play" data-keep-scroll="play">${head}
    <section><h2>Models</h2>${picker(P.models)}</section>
    <section><h2>Documents</h2>
      <textarea id="play-text" rows="3" placeholder="Type a document, or paste several, one per line" aria-label="Documents to try"></textarea>
      <div class="inline"><button class="btn default" data-act="play-run" ${P.picks.length ? "" : "disabled"}>Answer</button><span class="dim">${mod()}↵</span></div>
    </section>
    <section>${results()}</section>
  </div>`;
}
