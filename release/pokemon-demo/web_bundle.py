"""Small, explicit checks for an imported Vite build; no asset downloads."""
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit

ENTRY = "demos/gamma-world/index.html"
SPECIES = (25, 37, 54, 111, 112, 116, 117, 149)


class BundleError(RuntimeError):
    pass


class EntryAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("type") == "module" and attrs.get("src"):
            self.urls.append(attrs["src"])
        if tag == "link" and attrs.get("rel") in ("stylesheet", "modulepreload") and attrs.get("href"):
            self.urls.append(attrs["href"])


def local_asset(root, entry, url):
    parsed = urlsplit(url)
    if parsed.scheme or parsed.netloc:
        raise BundleError(f"Expected a self-contained local build, found remote asset: {url}")
    relative = unquote(parsed.path)
    candidate = (root / relative.lstrip("/")) if relative.startswith("/") else (entry.parent / relative)
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise BundleError(f"Asset path escapes web directory: {url}")
    return resolved


def validate_web(root):
    """Validate the entry, compiled assets, available partners and attribution.

    This is a fail-fast deployment check, not a substitute for browser tests or
    proof that every optional map/species/animation is visually correct.
    """
    root = Path(root).resolve()
    entry = root / ENTRY
    if not entry.is_file():
        raise BundleError(f"Missing prebuilt game entry: {entry}. Import a local Vite build first; this source package has no runtime artwork.")
    parser = EntryAssets()
    parser.feed(entry.read_text(encoding="utf-8"))
    if not parser.urls:
        raise BundleError("The game entry has no compiled module. Import the Vite build, not the source index.html.")
    checked = set()
    for url in parser.urls:
        asset = local_asset(root, entry, url)
        if asset.suffix in (".ts", ".tsx"):
            raise BundleError(f"Source TypeScript cannot be served as a production bundle: {url}")
        checked.add(asset)
    for species in SPECIES:
        checked.add(root / f"assets/pokemon/pmd/{species}/metadata.json")
        checked.add(root / f"assets/pokemon/pmd/{species}/credits.txt")
    checked.add(root / "assets/pokemon/pmd/source/LICENSE.md")
    checked.add(root / "docs/ASSET_CREDITS.html")
    missing = [str(p.relative_to(root)) for p in sorted(checked) if not p.is_file() or p.stat().st_size == 0]
    if missing:
        raise BundleError("Incomplete web bundle; missing or empty files: " + ", ".join(missing[:12]))
    # Verify representative animation references, without opening all 151
    # metadata files or scanning the asset tree each time the server starts.
    metadata = json.loads((root / "assets/pokemon/pmd/25/metadata.json").read_text(encoding="utf-8"))
    if not isinstance(metadata, dict) or metadata.get("id") != 25 or not isinstance(metadata.get("animations"), dict):
        raise BundleError("Invalid Pikachu animation metadata.")
    sheets = {animation["sheet"] for animation in metadata["animations"].values()
              if isinstance(animation, dict) and isinstance(animation.get("sheet"), str) and animation["sheet"]}
    if not sheets:
        raise BundleError("Pikachu metadata contains no animation sheets.")
    for sheet in sheets:
        asset = local_asset(root, root / "assets/pokemon/pmd/25/metadata.json", sheet)
        if not asset.is_file() or asset.stat().st_size == 0:
            raise BundleError(f"Missing PMD animation sheet: {sheet}")
    return {"entry": ENTRY, "entryAssets": len(parser.urls), "partners": len(SPECIES), "representativeSheets": len(sheets)}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("web", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(validate_web(args.web), indent=2))
    except (BundleError, ValueError) as error:
        parser.exit(1, f"Web bundle is not ready: {error}\n")
