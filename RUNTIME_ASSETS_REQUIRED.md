# Source-only package

This export is not playable out of the box and cannot compile standalone without the omitted runtime inputs. The Docker image expects a separately imported, already built `web/` directory. No game artwork, credentials, player database or raw extraction archive is included.

See [deployment instructions](release/pokemon-demo/README.md). The following source imports are intentionally unresolved in this review package:

- `demos/gamma-world/assets/ (including generated TypeScript asset manifests)`
- `demos/gamma-battle/assets/`
- `demos/gamma-world/data/ (source maps, collision geometry and sprite textures)`
- `demos/gamma-world/evidence/native-sprite-default-materials.json (runtime import)`
- `demos/gamma-battle/evidence/asset-status.json (runtime import)`
- `public/assets/pokemon/ (PMD sheets, metadata and attribution records)`

The six exported content JSON files describe game data/mechanics; they are not an artwork bundle. `move-fx.json` is a frontend dependency; the other five are backend runtime inputs. No repository-wide open-source license is asserted for third-party assets.
