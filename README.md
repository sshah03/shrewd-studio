<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="112" alt="Shrewd Studio">
</p>

<h1 align="center">Shrewd Studio</h1>

<p align="center">
  GUI for the shrewd package for building fast, locally runnable text classifiers from your own labels and LLM-generated labels. Supports both standard classifiers and Jev style decision panels.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-beta-orange" alt="Beta">
  <a href="https://pypi.org/project/shrewd/"><img src="https://img.shields.io/pypi/v/shrewd?label=built%20on%20shrewd" alt="Built on shrewd"></a>
  <img src="https://img.shields.io/badge/python-3.11%2B-blue" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="macOS, Windows, Linux">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#trying-it-without-spending-anything">Try it for free</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="https://github.com/sshah03/shrewd">The shrewd library</a>
</p>

https://github.com/user-attachments/assets/bb11d9ec-bc90-42e1-a143-c12c7435e501

Shrewd Studio is a GUI desktop app for [shrewd](https://github.com/sshah03/shrewd). You can describe a classification task, add the examples you've labeled, and let one or more LLMs label an unlabeled pool of data for you, using the examples you've labeled as a test (can also use GEPA against your labels to optimize the labeling prompt for you). You can manually review disagreements, then train a small local model and use it.

> [!NOTE]
> Studio is in beta. Expect rough edges, though we will try to maintain backward compatibility in this case as much as possible. Bugs and suggestions go in [Issues](https://github.com/sshah03/shrewd-studio/issues).

## What it does

- **Supports multiple LLM teachers/labelers.** Pick two or three models. Each one also answers your tuning examples, and their answers are combined per question by how often each matched you. You see each LLM's score, how much it moves the combined answer, and how often they agree.
- **Better prompts, scored on your labels.** The Prompt panel can rewrite the LLM prompt with GEPA. It tries new versions, scores each on your tuning set, and keeps the prompt from the best iteration. In one run it took Claude Haiku from 91% to 100% of tuning examples for under a cent. Gains on tuning examples don't always hold on new documents, so the locked test set is where you find out.
- **Review that's fast with a keyboard.** The queue shows the documents the teachers split on or weren't sure about, least sure first, with a few agreed answers mixed in as spot checks. `1`-`9` picks an answer and moves on to the next question that needs you, `[` and `]` switch questions, and `Enter` saves and goes to the next document.
- **Local methods compared side by side.** tf-idf, embeddings, SetFit and fine-tuned encoders are scored on your tuning set and you're shown their speed and size.
- **Models that run anywhere.** Export writes the shipped model to a folder that runs without shrewd: Python with only numpy, or JavaScript with nothing, for tf-idf and embeddings, and ONNX or Hugging Face for encoders and SetFit.

## Install

Studio is a Python package, and you can use it as a desktop app or in your browser. Either way, install the package first. With [uv](https://docs.astral.sh/uv/):

```
uv tool install git+https://github.com/sshah03/shrewd-studio
```

[pipx](https://pipx.pypa.io/) works the same way: `pipx install git+https://github.com/sshah03/shrewd-studio`. Both put a `shrewd-studio` command in `~/.local/bin`, which is where the desktop app looks for it.

**In your browser:** run `shrewd-studio`. It opens on `http://127.0.0.1:8765`, or the next free port if something else is using that one.

**As a desktop app:** download it for your system from this repo's [Releases](https://github.com/sshah03/shrewd-studio/releases) page and open it. **It has only been thoroughly tested on Apple silicon Macs so far, so please be patient if there are issues on other platforms, and we will address them asap.** The builds aren't signed, so the first time you open it:

- **macOS** says it can't check the app. Open System Settings → Privacy & Security, scroll down, and click Open Anyway.
- **Windows** shows a SmartScreen warning. Click More info, then Run anyway.
- **Linux:** make the AppImage executable (`chmod +x`), or install the `.deb`.

If the app can't find `shrewd-studio`, it shows the install command and a Try again button. To run it on a particular Python environment instead, set `SHREWD_STUDIO_CMD` (for example `/path/to/.venv/bin/shrewd-studio`; quote a path with spaces in it).

Models are kept in `shrewd-models` in your home folder (change it in Settings, or with `--workspace`). Studio works the same on macOS, Windows and Linux.

### Local methods

tf-idf works out of the box. Embeddings, SetFit and the encoders each need extra packages (SetFit and the encoders bring PyTorch, about 1 GB). Install them from Settings or the Compare drawer when you first want them, or all at once with Studio itself:

```
uv tool install "shrewd-studio[all] @ git+https://github.com/sshah03/shrewd-studio"
```

`uv tool upgrade shrewd-studio` puts the tool back to exactly what you installed, so methods you added from Settings have to be installed again afterwards. Ones installed with `[all]` stay.

## Trying it without spending anything

```
shrewd-studio --sandbox --samples --workspace ~/shrewd-samples
```

That builds ten sample models with simulated teachers: one teacher, two and three teachers, majority vote vs weighted, self-consistency votes, labeling under a budget, cheapest-first escalation, teacher backup, and models stopped at each stage. Sandbox mode says so on every screen.

## Keys and privacy

Studio only listens on this computer. Teachers see the documents you send them; nothing else leaves the machine. API keys come from your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...), the same way shrewd reads them, or from Settings, which keeps them in the system's key store (the macOS Keychain, Windows Credential Manager, or the Secret Service keyring on Linux) and never in a file. A key set in your environment wins.

## Developing

```
uv venv && uv pip install -e "../shrewd[teacher]" -e ".[dev]"   # shrewd checked out next to this repo
cd web && npm install && npm run build && cd ..                # builds into shrewd_studio/static/
python -m shrewd_studio --workspace runs                        # or: cd web && npm run dev (proxies /api)
pytest
```

The desktop app (`src-tauri/`) is a thin Tauri shell: it starts `shrewd-studio` on a free port and opens a window on it. Build it with `cargo tauri build` from `src-tauri/`, on the system you're building for: a `.app` and `.dmg` on macOS, an installer on Windows, `.deb` and AppImage on Linux. `cargo tauri build --bundles app` skips the `.dmg`, whose window styling needs Finder.

## License

[MIT](LICENSE)
