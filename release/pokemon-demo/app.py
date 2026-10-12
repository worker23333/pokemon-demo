"""One process serves the unmodified Gamma API and a prebuilt static game."""
import importlib.util
import os
from pathlib import Path
import sys

from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# The existing demo imports the server package and derives content paths from
# this preserved repository layout. No production app/database is imported.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from web_bundle import validate_web


def create_app(web_root=None):
    web = Path(web_root or os.environ.get("POKEMON_DEMO_WEB_ROOT", ROOT / "web")).resolve()
    validate_web(web)
    source = ROOT / "demos/gamma-battle/server.py"
    if not source.is_file():
        raise RuntimeError(f"Missing demo backend: {source}")
    spec = importlib.util.spec_from_file_location("pokemon_release_gamma_service", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    app = module.create_app()
    # A playable release does not expose the original extraction browser.
    # Filter only this wrapper's app; the local demo source remains unchanged.
    catalog_paths = {"/api/gamma/assets", "/api/gamma/assets/file/{asset_id}"}
    app.router.routes = [route for route in app.router.routes if getattr(route, "path", None) not in catalog_paths]

    @app.get("/", include_in_schema=False)
    async def game_entry():
        return RedirectResponse("/demos/gamma-world/", status_code=307)

    @app.get("/demo-credits", response_class=HTMLResponse, include_in_schema=False)
    async def credits():
        return """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Demo credits and source notes</title><main style="max-width:48rem;margin:3rem auto;padding:1rem;font:1rem/1.7 system-ui">
        <h1>Demo credits and source notes</h1>
        <p>This is an unofficial gameplay and technology prototype. Environment models, textures, trainer sprites and audio are adapted from
        <a href="https://undreamedpanic.itch.io/gamma-emerald-demo">Gamma Emerald by undreamedpanic</a>.</p>
        <p>Directional Pokémon animations are sourced from <a href="https://github.com/PMDCollab/SpriteCollab">PMDCollab / SpriteCollab</a>.
        Original artists, including CHUNSOFT and individual contributors, are listed in the <a href="/docs/ASSET_CREDITS.html">complete asset credits</a>.
        The <a href="/assets/pokemon/pmd/source/LICENSE.md">source license</a>, historical licenses and per-species credits are retained.</p>
        <p>Pokémon and original artwork belong to their respective rights holders, including The Pokémon Company, Nintendo, Game Freak and Creatures.
        This demo is not an official or endorsed release. Source attribution does not grant additional redistribution rights.</p>
        <p><a href="/demos/gamma-world/">Return to the demo</a></p></main></html>"""

    # Register last: /api/gamma routes must reach the authoritative simulator.
    app.mount("/", StaticFiles(directory=web, html=True), name="game")
    return app
