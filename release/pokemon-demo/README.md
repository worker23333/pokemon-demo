# Pokémon demo deployment skeleton

This is a **source-only review package**, not a ready-to-play download. The Gamma environment artwork, PMD animation sheets, map exports and generated asset manifests are intentionally omitted. A prebuilt local `web/` bundle is required for deployment; installing npm packages alone does not supply those files. No artwork is downloaded by these scripts.

The standalone demo provides exploration and the existing authoritative real-time battle engine. Qwen companion dialogue, training and invitation-room PvP belong to the broader project and are not exposed by this demo.

## Prepare a release

From the original repository, export only the allowlisted source:

```sh
python3 release/pokemon-demo/export_source.py --output ../pokemon-demo-release
```

The export contains `SOURCE_EXPORT.json` with every exported file, byte count and SHA-256, including a list of generated configuration files. It excludes player saves, credentials, environments, media, evidence and raw extraction archives. Extraction-library and visual-review source entries are omitted, and the exported Vite configuration contains only the two gameplay entries. Two JSON files under the original `evidence/` paths are real runtime imports and are deliberately documented as missing, not classified as unused reports. The exported root README can be written separately for the project introduction.

Use an existing build made in the complete local repository, or build it there with:

```sh
node_modules/.bin/vite build --config demos/gamma-battle/vite.config.ts
```

From the exported repository, first inspect the import plan. Replace the source path with the complete repository's build directory:

```sh
python3 release/pokemon-demo/import_web.py /absolute/path/to/kanto-trainer/.runtime/gamma-web
```

This command copies nothing. It reports the logical bytes and file count before materializing assets. Only when the runtime assets are available for your intended use, explicitly import them:

```sh
python3 release/pokemon-demo/import_web.py /absolute/path/to/kanto-trainer/.runtime/gamma-web --copy
python3 release/pokemon-demo/web_bundle.py web
```

Only compiled `assets/`, the two game entry pages and `docs/ASSET_CREDITS.html` are copied. Evidence, reference videos and the full extraction library are excluded. The release wrapper removes both extraction-library API routes. Existing destinations are never overwritten. `web/` stays out of Git. The import checks entry modules, partner metadata, representative animation sheets and attribution; browser verification is still needed after deployment.

## Run one service

From the **exported repository root**, after importing `web/`:

```sh
docker build -f release/pokemon-demo/Dockerfile -t pokemon-demo .
docker run --rm -p 8080:8080 pokemon-demo
```

Open `http://localhost:8080/`. The same process serves the game and `/api/gamma`; no separate Vite server or frontend proxy is required. Missing assets fail the image build and application startup with an explicit error.

For local Python execution:

```sh
python3 -m venv .venv
.venv/bin/pip install -r release/pokemon-demo/requirements.txt
.venv/bin/python -m uvicorn app:create_app --factory --app-dir release/pokemon-demo --host 127.0.0.1 --port 8080 --workers 1
```

Keep **one worker/one instance**: active battles live in process memory and clients receive state by HTTP polling, with a shared maximum of 16 battles. Restarting clears them; exploration progress is browser-local. This service is intended for controlled playtesting, not production multiplayer hosting. For an internet deployment, provide HTTPS, request rate limits and admission/concurrency protection at the hosting layer. Do not deploy the Vite development server or the whole original repository. No GPU, Qwen/Ollama, Whisper, player database or extracted archive is needed.

## Attribution and checks

Retain the PMD per-species `credits.txt`, source license and license history, and the asset credits page. Environment assets come from Gamma Emerald by undreamedpanic; the original extraction record does not establish an open redistribution license. Credits document origin and do not grant additional rights. Pokémon and original artwork remain with their respective rights holders. See `docs/ASSET_CREDITS.md`; this package does not claim original authorship of those assets.

Tests use a tiny synthetic static fixture and the real existing combat service; they do not copy the actual artwork:

```sh
# In the original repository's development environment:
server/.venv/bin/python -m pytest release/pokemon-demo/test_release.py -q
```

In a fresh review environment, install `pytest` and `httpx` in the test venv in addition to runtime requirements. The Docker runtime does not need them.
