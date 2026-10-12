"""Release wrapper checks with synthetic assets and the existing Gamma API."""
import importlib.util
import json
from pathlib import Path
import sys

from fastapi.testclient import TestClient
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from web_bundle import BundleError, SPECIES, validate_web
from import_web import asset_plan, copy_bundle
from export_source import source_paths, export_source

spec = importlib.util.spec_from_file_location("pokemon_demo_release_test_wrapper", HERE / "app.py")
wrapper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = wrapper
spec.loader.exec_module(wrapper)


def write(root, relative, content):
    file = root / relative
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)
    return file


@pytest.fixture
def web(tmp_path):
    root = tmp_path / "bundle"
    write(root, "demos/gamma-world/index.html", '<html><link rel="stylesheet" href="/assets/test.css"><script type="module" src="/assets/test.js"></script><p>synthetic game entry</p></html>')
    write(root, "demos/gamma-battle/index.html", '<html>synthetic battle entry</html>')
    write(root, "assets/test.css", "body { color: white; }")
    write(root, "assets/test.js", "/* synthetic module */")
    for species in SPECIES:
        write(root, f"assets/pokemon/pmd/{species}/metadata.json", json.dumps({"id": species,
            "animations": {"Idle": {"sheet": "/assets/pokemon/pmd/25/Idle.png"}}}))
        write(root, f"assets/pokemon/pmd/{species}/credits.txt", "Synthetic fixture, no third-party artwork")
    write(root, "assets/pokemon/pmd/25/Idle.png", "synthetic bytes; not rendered in this test")
    write(root, "assets/pokemon/pmd/source/LICENSE.md", "Synthetic fixture license record")
    write(root, "docs/ASSET_CREDITS.html", "<p>Synthetic attribution fixture</p>")
    return root


def test_missing_or_source_only_web_fails_with_actionable_message(tmp_path, web):
    with pytest.raises(BundleError, match="Import a local Vite build"):
        wrapper.create_app(tmp_path / "missing")
    write(web, "demos/gamma-world/index.html", '<script type="module" src="./bootstrap.ts"></script>')
    with pytest.raises(BundleError, match="Source TypeScript"):
        validate_web(web)


def test_attribution_and_animation_sheet_are_required(web):
    credits = web / "assets/pokemon/pmd/25/credits.txt"
    saved = credits.read_text()
    credits.unlink()
    with pytest.raises(BundleError, match="credits.txt"):
        validate_web(web)
    credits.write_text(saved)
    (web / "assets/pokemon/pmd/25/Idle.png").unlink()
    with pytest.raises(BundleError, match="animation sheet"):
        validate_web(web)


def test_wrapper_serves_static_game_and_real_api_before_static_mount(web):
    write(web, "api/gamma/health", "wrong static API")
    app = wrapper.create_app(web)
    with TestClient(app) as client:
        redirect = client.get("/", follow_redirects=False)
        assert redirect.status_code == 307 and redirect.headers["location"] == "/demos/gamma-world/"
        assert "synthetic game entry" in client.get("/").text
        assert client.get("/assets/test.js").status_code == 200
        credits = client.get("/demo-credits")
        assert credits.status_code == 200 and "undreamedpanic" in credits.text and "PMDCollab" in credits.text
        health = client.get("/api/gamma/health")
        assert health.status_code == 200 and health.json()["engineVersion"] == 9
        assert health.json()["persisted"] is False
        response = client.post("/api/gamma/battles", json={"playerSpeciesId": 25, "opponentSpeciesId": 37, "level": 5, "seed": 32})
        assert response.status_code == 200, response.text
        battle = response.json()
        assert battle["source"] == "authoritative-live-memory"
        assert client.get(f'/api/gamma/battles/{battle["id"]}').status_code == 200
        assert client.get("/server/combat.py").status_code == 404
        assert client.get("/api/rooms").status_code == 404
        assert client.get("/api/gamma/assets").status_code == 404
        assert client.get("/api/gamma/assets/file/not-published").status_code == 404
        paths = {getattr(route, "path", None) for route in app.routes}
        assert "/api/gamma/assets" not in paths
        assert "/api/gamma/assets/file/{asset_id}" not in paths


def test_import_allowlist_excludes_reports_reference_and_library(web, tmp_path):
    write(web, "docs/evidence/private-review.json", "not a runtime asset")
    write(web, "reference/original-video.mp4", "not a runtime asset")
    write(web, "demos/gamma-battle/library.html", "do not publish extraction browser")
    write(web, "assets/library-test.js", "do not publish extraction browser entry code")
    write(web, "assets/visualReview-test.css", "do not publish visual review entry style")
    write(web, ".env", "fixture-secret-never-copied")
    files = asset_plan(web)
    names = {file.as_posix() for file in files}
    assert "docs/ASSET_CREDITS.html" in names
    assert not any(name.startswith(("docs/evidence/", "reference/")) for name in names)
    assert "demos/gamma-battle/library.html" not in names
    assert "assets/library-test.js" not in names
    assert "assets/visualReview-test.css" not in names
    assert ".env" not in names
    output = tmp_path / "imported"
    assert not output.exists(), "planning must not create an output"
    copy_bundle(web, output, files)
    assert validate_web(output)["partners"] == 8
    assert not (output / "docs/evidence").exists()
    assert json.loads((output / "BUNDLE.json").read_text())["kind"] == "local-prebuilt-import"
    with pytest.raises(BundleError, match="already exists"):
        copy_bundle(web, output, files)


def test_import_rejects_asset_symlinks_and_entry_path_escape(web, tmp_path):
    outside = write(tmp_path, "not-an-asset.txt", "unrelated file")
    (web / "assets/link.txt").symlink_to(outside)
    with pytest.raises(BundleError, match="symlink"):
        asset_plan(web)
    (web / "assets/link.txt").unlink()
    write(web, "demos/gamma-world/index.html", '<script type="module" src="../../../not-an-asset.txt"></script>')
    with pytest.raises(BundleError, match="escapes"):
        validate_web(web)


def test_source_allowlist_and_export_do_not_copy_artwork_state_or_credentials(tmp_path):
    paths = source_paths()
    forbidden = (".runtime", "assets", "evidence", "data", ".aws", ".env", "node_modules", ".venv")
    assert all(not any(segment in forbidden for segment in Path(path).parts) for path in paths)
    assert "server/app.py" not in paths and "server/db.py" not in paths
    assert not any(Path(path).name.startswith(("library.", "visual-review.")) for path in paths)
    assert "server/combat.py" in paths and "packages/content/move-fx.json" in paths
    # Exporting text source is small; real media are never touched by this test.
    target = tmp_path / "source-export"
    manifest = export_source(target)
    assert manifest["runtimeAssetsIncluded"] is False
    assert manifest["bytesExcludingManifest"] < 2_000_000
    assert not (target / "web").exists()
    assert not (target / "README.md").exists(), "root introduction belongs to the caller"
    assert "not playable out of the box" in (target / "RUNTIME_ASSETS_REQUIRED.md").read_text()
    assert "web/" in (target / ".gitignore").read_text()
    assert "!web/**" in (target / ".dockerignore").read_text()
    config = (target / "demos/gamma-battle/vite.config.ts").read_text()
    assert "library" not in config and "visualReview" not in config
    assert "world:" in config and "battle:" in config
    with pytest.raises(RuntimeError, match="already exists"):
        export_source(target)
