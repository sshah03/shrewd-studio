// The Settings page. Fields save on change; keys go to the system's key store through their own sheet.
import type { Extra, Folder } from "../api";
import { S } from "../state";
import { esc, n, size } from "../util";
import { keyNote } from "./newmodel";
import { envPlace, keyPlace, showIn, system } from "../system";

const theme = () => document.documentElement.dataset.theme ?? "";

function devices(detected: string) {
  const auto = /metal|mps/i.test(detected) ? "Metal" : /cuda/i.test(detected) ? "CUDA" : "CPU";
  return [["auto", `Automatic (${auto})`], ["cuda", "CUDA"], ["mps", "Metal"], ["cpu", "CPU"]];
}

/** An optional extra: installed, installing, or an Install button (and, after a failed try,
 * the reason and a guide to doing it by hand). */
/** What each extra adds, in the method names Compare uses. */
const ADDS: Record<string, string> = {
  embed: "The embeddings method: a small static embedding model (potion-base-8M) with a classifier on top. Trains in seconds, no PyTorch.",
  encoder: "The encoder method: fine-tunes a transformer (ModernBERT-base) on your labeled documents. Usually the most accurate, and the slowest to train. Also a zero-shot model, which answers before any training.",
  setfit: "The SetFit method: tunes a sentence transformer (mpnet-base) on pairs of examples, then fits a classifier on it. Strong when there are few labels. Classifiers only.",
  onnx: "Lets Export… in Use write encoder, SetFit and embedding classifiers as an ONNX model, which runs in any ONNX runtime without shrewd.",
};

export function extraRow(e: Extra) {
  const live = e.job ? S.jobs?.now.find(j => j.id === e.job!.id) : undefined;
  if (live && e.job) e = { ...e, job: { ...e.job, state: live.state, message: live.message } };
  const busy = e.job && (e.job.state === "running" || e.job.state === "queued");
  const failed = !e.installed && !busy && e.job?.state === "failed";
  const state = e.installed ? '<td class="ok">Installed</td>'
    : busy ? `<td><span class="dim">${esc(e.job!.message || "Installing…")}</span></td>`
    : failed ? `<td><span class="err">Didn't install.</span> <span class="dim">${esc(e.job!.error ?? "")}</span></td>`
    : `<td class="dim">Not installed, ${esc(e.download)}</td>`;
  const act = e.installed || busy ? ""
    : `${failed ? `<button class="btn plain" data-act="install-help" data-extra="${esc(e.id)}">Install it yourself…</button>` : ""}<button class="btn" data-act="install" data-extra="${esc(e.id)}" title="Installs into the Python Studio runs on. Downloads ${esc(e.download)}.">${failed ? "Try again" : "Install"}</button>`;
  return `<tr><td>${esc(e.name)}${ADDS[e.id] ? `<span class="sub">${esc(ADDS[e.id])}</span>` : ""}</td>${state}<td class="r">${act}</td></tr>`;
}

/** Show the folder, and Change… unless the folder comes from a flag or the shell. */
function folderButtons(which: Folder, fixed: string | null) {
  return `${fixed ? `<span class="dim" title="Change it there, or remove it to choose here">${fixed}</span>` : ""}<button class="btn plain" data-act="folder-reveal" data-which="${which}">${showIn()}</button>${fixed ? "" : `<button class="btn" data-act="folder-change" data-which="${which}">Change…</button>`}`;
}

function appearance() {
  return `<section><h2>Appearance</h2><div class="form">
      <label>Theme:</label><div class="scope" role="group" aria-label="Theme"><button aria-pressed="${!theme()}" data-theme="">System</button><button aria-pressed="${theme() === "light"}" data-theme="light">Light</button><button aria-pressed="${theme() === "dark"}" data-theme="dark">Dark</button></div>
      <label>Document rows:</label><div class="scope" role="group" aria-label="Document rows"><button aria-pressed="${!S.twoLine}" data-lines="1">One line</button><button aria-pressed="${S.twoLine}" data-lines="2">Two lines</button></div>
    </div></section>`;
}

export function settingsPage() {
  const s = S.settings;
  if (!s) return `<div class="settings" data-keep-scroll="settings"><h1>Settings</h1>${S.settingsErr ? `<p class="err" style="margin:0">${esc(S.settingsErr)}</p><div><button class="btn" data-act="reload-settings">Try again</button></div>` : '<p class="dim" style="margin:0">Loading…</p>'}${appearance()}</div>`;
  const ep: [string, "ollama" | "openai_compatible", string | null, string][] = [
    ["Ollama", "ollama", s.endpoints.ollama, "ollama/&lt;model&gt;"],
    ["OpenAI-compatible", "openai_compatible", s.endpoints.openai_compatible, "hosted_vllm/&lt;model&gt;"]];
  const setEp = ep.filter(e => e[2]), freeEp = ep.filter(e => !e[2]);
  const testPct = s.defaults.test_frac <= 1 ? Math.round(s.defaults.test_frac * 100) : s.defaults.test_frac;
  const models = S.models?.length ?? 0;
  const ws = s.storage.workspace_source === "flag" ? "Set by --workspace" : s.storage.workspace_source === "env" ? "Set by SHREWD_STUDIO_WORKSPACE" : null;
  const hf = s.storage.models_source === "shell" ? "Set by HF_HOME" : null;
  return `<div class="settings" data-keep-scroll="settings">
    <h1>Settings</h1>
    <section><h2>API keys</h2>
      <table class="mini"><thead><tr><th>Provider</th><th>Variable</th><th>Source</th><th></th></tr></thead><tbody>
      ${s.keys.map(k => `<tr><td>${esc(k.provider)}</td><td class="mono">${esc(k.variable)}</td><td>${k.source === "keychain" ? `<span class="ok">${keyPlace()}</span>` : k.source === "shell" ? `<span class="ok">${envPlace()}</span>` : '<span class="dim">Not set</span>'}</td>
        <td class="r">${k.source === "shell" ? "" : k.source ? `<button class="btn plain" data-key="${esc(k.variable)}" data-provider="${esc(k.provider)}">Replace…</button><button class="btn plain danger" data-unkey="${esc(k.variable)}">Remove…</button>` : `<button class="btn" data-key="${esc(k.variable)}" data-provider="${esc(k.provider)}">Add…</button>`}</td></tr>`).join("")}
      </tbody></table>
      <div class="inline"><input type="text" id="other-var" placeholder="Other variable, e.g. TOGETHERAI_API_KEY" style="flex:1" aria-label="Variable name"><input type="password" id="other-key" placeholder="Key" style="flex:1" aria-label="Key" autocomplete="off"><button class="btn" data-act="save-other-key">Save to ${keyPlace()}</button></div>
      <p class="dim" style="margin:0">Keys are stored in the ${system().keystore} and passed to Studio's Python process. A key set in ${system().os === "windows" ? "your environment" : "your shell"} wins.</p></section>

    <section><h2>Custom endpoints</h2>
      ${setEp.length ? `<table class="mini"><thead><tr><th>Name</th><th>Base URL</th><th>Model names</th><th></th></tr></thead><tbody>
        ${setEp.map(([name, which, url, names]) => `<tr><td>${name}</td><td class="mono">${esc(url)}</td><td class="mono">${names}</td><td class="r"><button class="btn plain danger" data-unendpoint="${which}">Remove…</button></td></tr>`).join("")}</tbody></table>` : ""}
      ${freeEp.length ? `<div class="inline"><select id="ep-which" aria-label="Endpoint kind">${freeEp.map(([name, which]) => `<option value="${which}">${name}</option>`).join("")}</select><input type="text" id="ep-url" placeholder="${freeEp[0][1] === "ollama" ? "http://localhost:11434" : "OpenAI-compatible base URL"}" style="flex:1" aria-label="Base URL"><button class="btn" data-act="add-endpoint">Add</button></div>` : ""}</section>

    <section><h2>Prices</h2>
      ${s.prices.length ? `<table class="mini"><thead><tr><th>Model</th><th class="r">Input, $ per 1M tokens</th><th class="r">Output, $ per 1M tokens</th><th></th></tr></thead><tbody>
        ${s.prices.map((p, i) => `<tr><td class="mono">${esc(p.model)}</td><td class="r"><input type="number" step="0.01" min="0" value="${p.input}" data-price="${i}" data-f="input" aria-label="Input price for ${esc(p.model)}"></td><td class="r"><input type="number" step="0.01" min="0" value="${p.output}" data-price="${i}" data-f="output" aria-label="Output price for ${esc(p.model)}"></td><td class="r"><button class="btn plain danger" data-act="remove-price" data-i="${i}">Remove</button></td></tr>`).join("")}</tbody></table>` : ""}
      <div class="inline"><input type="text" id="price-model" placeholder="A model litellm has no price for" style="flex:1" aria-label="Model"><button class="btn" data-act="add-price">Add</button></div></section>

    <section><h2>Defaults for new models</h2>
      <p class="dim" style="margin:0">What a new model starts with. A model's own settings, in its Task drawer, win.</p>
      <div class="form">
      <label class="top">Teachers:</label><div class="def-teachers">
        <table class="mini"><tbody>${s.defaults.teachers.map((t, i) => `<tr><td class="mono">${esc(t)}</td><td>${keyNote(t)}</td>
          <td class="r"><button class="btn plain" data-act="def-teacher-drop" data-i="${i}" ${s.defaults.teachers.length <= 1 ? "disabled" : ""}>Remove</button></td></tr>`).join("")}</tbody></table>
        <div class="inline"><input type="text" id="def-teacher" placeholder="any litellm model, e.g. openai/gpt-5.1" style="flex:1" aria-label="Add a default teacher"><button class="btn" data-act="def-teacher-add">Add</button></div></div>
      <label for="dp">Parallel requests:</label><span class="inline"><input id="dp" type="number" min="1" value="${s.defaults.concurrency}" data-setting="defaults.concurrency"> <span class="dim">teacher calls at once</span></span>
      <label for="ds">Test set:</label><span class="inline"><input id="ds" type="number" min="5" max="80" value="${testPct}" data-setting="defaults.test_frac"> % of your examples, locked away for the final score</span>
      <label for="dseed">Random seed:</label><span class="inline"><input id="dseed" type="number" value="${s.defaults.seed}" data-setting="defaults.seed"> <span class="dim">the same seed gives the same test split</span></span>
    </div></section>

    <section><h2>Compute</h2><div class="form">
      <label for="dev">Encoder device:</label><select id="dev" data-setting="compute.device">${devices(s.compute.detected).map(([v, l]) => `<option value="${v}" ${s.compute.device === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label for="cj">CPU jobs at once:</label><input id="cj" type="number" min="1" value="${s.compute.cpu_jobs}" data-setting="compute.cpu_jobs">
      <label for="gj">GPU jobs at once:</label><input id="gj" type="number" min="1" value="${s.compute.gpu_jobs}" data-setting="compute.gpu_jobs">
      <label>This computer:</label><span>${esc(s.compute.detected)}</span>
    </div></section>

    <section><h2>Optional extras</h2>
      <p class="dim" style="margin:0">The local methods beyond tf-idf, which needs nothing extra.</p>
      <table class="mini extras"><tbody>
        ${s.extras.map(extraRow).join("")}
      </tbody></table></section>

    <section><h2>Storage</h2>
      <table class="mini"><tbody>
        <tr><td>Your models</td><td class="mono">${esc(s.storage.workspace)}</td><td class="r">${folderButtons("workspace", ws)}</td></tr>
        <tr><td>Teacher answers</td><td>${size(s.storage.answers_mb)}${models ? ` across ${n(models)} model${models === 1 ? "" : "s"}` : ""}</td><td class="r dim">Kept with each model</td></tr>
        <tr><td>Downloaded models</td><td>${size(s.storage.models_mb)} in <span class="mono">${esc(s.storage.models_dir)}</span></td><td class="r">${folderButtons("models_dir", hf)}</td></tr></tbody></table>
      <p class="dim" style="margin:0">Each model is one folder: your examples, the labeled pool, the teachers' cached answers and the trained methods. Downloaded models are the base models that embedding, encoder and SetFit methods start from.</p></section>

    ${appearance()}

    <section><h2>About</h2><div class="form"><label>Shrewd Studio:</label><span>${esc(s.about.studio)}</span><label>shrewd:</label><span>${esc(s.about.shrewd)}</span><label>Python:</label><span class="mono">${esc(s.about.python)}</span></div></section>
  </div>`;
}
