"""Export a small source-only review package using explicit path allowlists."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
BACKEND = (
    "server/__init__.py", "server/combat.py", "server/content.py", "server/personality.py",
    "demos/gamma-battle/server.py", "demos/gamma-battle/field.py",
)
CONTENT = tuple(f"packages/content/{name}.json" for name in (
    "species", "regions", "moves", "type-chart", "move-mechanics", "move-fx"))
SHARED = (
    "apps/web/api.ts", "apps/web/command-feedback.ts",
    "apps/web/arena/directional-sprite.ts", "apps/web/arena/fx.ts", "apps/web/arena/moves.ts",
    "apps/web/arena/timeline.ts", "apps/web/arena/types.ts", "apps/web/arena/util.ts",
    "demos/visual-stage-p1/move-catalog.js", "demos/visual-stage-p1/muzzle-anchors.js",
    "demos/visual-stage-p1/reference-effects.js", "demos/visual-stage-p1/skill-effects.js",
    "packages/presentation/action-stage.js", "packages/presentation/action-stage.d.ts",
    "packages/presentation/battle-juice.js", "packages/presentation/battle-juice.d.ts",
    "packages/presentation/battle-motion.d.ts", "packages/presentation/pmd-sprites.js",
    "packages/presentation/pmd-sprites.d.ts",
)
SCAFFOLD = (
    "app.py", "web_bundle.py", "import_web.py", "export_source.py", "requirements.txt",
    "Dockerfile", ".dockerignore", "README.md", "test_release.py",
)
OMITTED = (
    "demos/gamma-world/assets/ (including generated TypeScript asset manifests)",
    "demos/gamma-battle/assets/",
    "demos/gamma-world/data/ (source maps, collision geometry and sprite textures)",
    "demos/gamma-world/evidence/native-sprite-default-materials.json (runtime import)",
    "demos/gamma-battle/evidence/asset-status.json (runtime import)",
    "public/assets/pokemon/ (PMD sheets, metadata and attribution records)",
)


def source_paths(root=ROOT):
    root = Path(root).resolve()
    paths = set(BACKEND + CONTENT + SHARED + ("tsconfig.json", "docs/ASSET_CREDITS.md",
        "demos/gamma-world/tsconfig.json", "demos/gamma-battle/tsconfig.json",
        "docs/pokemon-demo-introduction.en.txt", "docs/POKEMON_DEMO_RELEASE.md"))
    for directory in ("demos/gamma-world", "demos/gamma-battle"):
        for path in (root / directory).iterdir():
            if path.is_file() and path.suffix in (".ts", ".css", ".html") and not path.name.startswith(("test-", "library.", "visual-review.")):
                paths.add(path.relative_to(root).as_posix())
    paths.add("demos/gamma-battle/run.mjs")
    paths.update(f"release/pokemon-demo/{name}" for name in SCAFFOLD)
    for name in paths:
        path = root / name
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
            raise RuntimeError(f"Missing or unsafe source file: {name}")
    return sorted(paths)


def export_source(destination, root=ROOT):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    if destination == root or root in destination.parents or destination in root.parents:
        raise RuntimeError("Use a separate export directory outside the original repository.")
    if destination.exists():
        raise RuntimeError(f"Export destination already exists: {destination}. Existing work is never overwritten.")
    paths = source_paths(root)
    destination.mkdir(parents=True)
    for name in paths:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, target)
    # Preserve only dependencies needed to inspect/build the demo sources. Do
    # not carry unrelated main-project scripts that would be broken here.
    original = json.loads((root / "package.json").read_text())
    package = {"name": "pokemon-demo-source", "version": original["version"], "private": True, "type": "module",
        "description": "Source-only review package. Runtime artwork is intentionally not included.",
        "scripts": {"validate:web": "python3 release/pokemon-demo/web_bundle.py web"},
        "dependencies": {"three": original["dependencies"]["three"]},
        "devDependencies": {name: original["devDependencies"][name] for name in ("vite", "typescript", "esbuild", "@types/three", "@types/node")}}
    (destination / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    # The exported configuration exposes gameplay entries only. Keep the
    # original repository's extraction library/review configuration untouched.
    (destination / "demos/gamma-battle/vite.config.ts").write_text(
        "import { defineConfig } from 'vite';\nimport { fileURLToPath } from 'node:url';\n"
        "const root = fileURLToPath(new URL('../../', import.meta.url));\n"
        "export default defineConfig({ root,\n"
        "  server: { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api/gamma': 'http://127.0.0.1:8791' } },\n"
        "  build: { outDir: '.runtime/gamma-web', emptyOutDir: true, rollupOptions: { input: {\n"
        "    battle: fileURLToPath(new URL('./index.html', import.meta.url)),\n"
        "    world: fileURLToPath(new URL('../gamma-world/index.html', import.meta.url))\n"
        "  } } }\n});\n")
    (destination / ".gitignore").write_text("/web/\nnode_modules/\n.runtime/\ndist/\n.venv/\n.pytest_cache/\n__pycache__/\n*.pyc\n*.sqlite*\n.env*\n.DS_Store\n")
    shutil.copyfile(root / "release/pokemon-demo/.dockerignore", destination / ".dockerignore")
    (destination / "RUNTIME_ASSETS_REQUIRED.md").write_text(
        "# Source-only package\n\nThis export is not playable out of the box and cannot compile standalone without the omitted runtime inputs. "
        "The Docker image expects a separately imported, already built `web/` directory. No game artwork, credentials, player database or raw extraction archive is included.\n\n"
        "See [deployment instructions](release/pokemon-demo/README.md). The following source imports are intentionally unresolved in this review package:\n\n"
        + "\n".join(f"- `{name}`" for name in OMITTED)
        + "\n\nThe six exported content JSON files describe game data/mechanics; they are not an artwork bundle. "
        "`move-fx.json` is a frontend dependency; the other five are backend runtime inputs. No repository-wide open-source license is asserted for third-party assets.\n")
    records = []
    for file in sorted(p for p in destination.rglob("*") if p.is_file()):
        payload = file.read_bytes()
        records.append({"path": file.relative_to(destination).as_posix(), "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
    manifest = {"kind": "source-only-review-export", "runtimeAssetsIncluded": False,
        "files": records, "fileCountExcludingManifest": len(records), "bytesExcludingManifest": sum(row["bytes"] for row in records),
        "generatedFiles": ["package.json", ".gitignore", ".dockerignore", "RUNTIME_ASSETS_REQUIRED.md", "demos/gamma-battle/vite.config.ts"],
        "omittedRuntimeInputs": list(OMITTED)}
    (destination / "SOURCE_EXPORT.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT.parent / "pokemon-demo-release")
    args = parser.parse_args()
    try:
        manifest = export_source(args.output)
        print(json.dumps({"output": str(args.output.resolve()), "filesIncludingManifest": manifest["fileCountExcludingManifest"] + 1,
            "bytesExcludingManifest": manifest["bytesExcludingManifest"], "runtimeAssetsIncluded": False}, indent=2))
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"Export failed: {error}\n")


if __name__ == "__main__":
    main()
