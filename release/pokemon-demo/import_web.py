"""Plan or explicitly copy an existing local Vite build into the release."""
import argparse
import json
from pathlib import Path
import shutil
import tempfile

from web_bundle import BundleError, validate_web

ROOT = Path(__file__).resolve().parents[2]
EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".glb", ".json", ".js", ".css",
              ".mp3", ".wav", ".ogg", ".ttf", ".otf", ".woff", ".woff2", ".xml", ".txt", ".md"}
ENTRIES = {"demos/gamma-world/index.html", "demos/gamma-battle/index.html", "docs/ASSET_CREDITS.html"}


def asset_plan(source):
    source = Path(source).resolve()
    validate_web(source)
    files = []
    for path in sorted((source / "assets").rglob("*")):
        if path.is_symlink():
            raise BundleError(f"Refusing an asset symlink: {path}")
        if path.parent == source / "assets" and path.suffix in (".js", ".css") and path.name.startswith(("library-", "visualReview-")):
            continue
        if path.is_file() and path.suffix.lower() in EXTENSIONS and not any(part.startswith(".") for part in path.relative_to(source).parts):
            files.append(path.relative_to(source))
    for name in sorted(ENTRIES):
        path = source / name
        if path.is_symlink():
            raise BundleError(f"Refusing an entry symlink: {path}")
        if path.is_file():
            files.append(Path(name))
    return files


def copy_bundle(source, destination, files):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise BundleError("Source and destination must be separate directories, not nested.")
    if destination.exists():
        raise BundleError(f"Destination already exists: {destination}. Choose a fresh output directory; existing files are never overwritten.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".pokemon-web-", dir=destination.parent))
    try:
        for relative in files:
            src = source / relative
            if src.is_symlink() or not src.resolve().is_relative_to(source):
                raise BundleError(f"Asset escaped the source directory: {relative}")
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, target)
        checks = validate_web(staging)
        (staging / "BUNDLE.json").write_text(json.dumps({"kind": "local-prebuilt-import", "checks": checks,
            "files": [p.as_posix() for p in files], "bytes": sum((staging / p).stat().st_size for p in files)}, indent=2) + "\n")
        staging.rename(destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Existing .runtime/gamma-web output, not the repository root")
    parser.add_argument("--output", type=Path, default=ROOT / "web")
    parser.add_argument("--copy", action="store_true", help="Actually copy the planned files; default is read-only")
    args = parser.parse_args()
    try:
        source = args.source.resolve()
        files = asset_plan(source)
        summary = {"mode": "copy" if args.copy else "plan-only", "files": len(files),
            "bytes": sum((source / p).stat().st_size for p in files), "output": str(args.output.resolve()),
            "excluded": ["docs/evidence", "reference videos", "library/review entry pages", "raw extraction archive"]}
        print(json.dumps(summary, indent=2))
        if args.copy:
            copy_bundle(source, args.output, files)
            print("Imported and validated the web bundle. This does not grant rights to redistribute its artwork.")
        else:
            print("No files copied. Add --copy only when ready to materialize the listed runtime assets.")
    except (BundleError, OSError, ValueError) as error:
        parser.exit(1, f"Import failed: {error}\n")


if __name__ == "__main__":
    main()
