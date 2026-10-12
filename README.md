# Pokemon demo

An experimental Pokémon battle prototype exploring real-time commands, generated arenas and destructible cover. This repository is a **source review package**: the visual assets are supplied separately, and an HTTPS playable demo has **not yet been published**.

## The idea

Exploration encounters lead into a new arena assembled from six layout templates and objects sampled from the surrounding environment. An indestructible perimeter defines the battlefield; internal cover changes how Pokémon move, dodge and attack, and some obstacles can be destroyed. Players issue tactical and move commands while Pokémon continue acting in real time.

The existing Python combat service runs an authoritative simulation at 20 Hz. The browser receives snapshots through HTTP polling. This standalone demo currently pits the player against a built-in opponent; it is not a completed online PvP product.

## About the creator

I used to work as an architectural designer. My love of games motivated me to start building my own, using AI-assisted development tools to explore ideas I wanted to play. My background influences how I think about space, movement, cover and arena layout. I am especially interested in contributing to PvP gameplay, battlefield design and trainer–Pokémon interaction.

In the broader local project, I have also experimented with Qwen-powered companion dialogue and memory, learning-based battle habits, and invitation-room PvP. These features are not integrated into this standalone demo. Qwen does not interpret its current battle commands.

See the [English introduction](docs/pokemon-demo-introduction.en.txt) and [demonstration plan](docs/POKEMON_DEMO_RELEASE.md).

## Review and deployment

- `demos/gamma-world/`: exploration, encounters, arena generation and presentation.
- `demos/gamma-battle/`: the standalone battle frontend and service.
- `server/` and `packages/`: the selected combat, content and presentation dependencies.
- `release/pokemon-demo/`: a separate deployment wrapper, Dockerfile, source exporter, asset import validator and checks.
- `SOURCE_EXPORT.json`: file sizes and SHA-256 hashes for this source snapshot.

Start with the [deployment instructions](release/pokemon-demo/README.md) and [required runtime inputs](RUNTIME_ASSETS_REQUIRED.md). Installing npm dependencies alone will not make this source-only package playable. Deployment requires a complete, separately supplied compiled `web/` bundle; the Docker image checks for it and fails clearly when it is missing.

The release wrapper serves the static game and combat API from the same origin and removes the extraction-library endpoints. Use one worker and one instance because live battles are held in memory. It is designed for controlled playtesting; HTTPS and traffic/admission controls are required at the hosting layer for an internet deployment. GitHub Pages alone cannot run the Python combat backend.

The latest full visual build was blocked by cloud-placeholder asset reads. The renamed title passed TypeScript and static checks; an incomplete build has not been represented as a verified downloadable release. Complete browser verification is still required before publishing a playable link.

## Attribution

The environment, trainer graphics and audio in the local prototype use material from [Gamma Emerald by undreamedpanic](https://undreamedpanic.itch.io/gamma-emerald-demo). Pokémon directional animation resources use PMDCollab / SpriteCollab material. See [asset credits](docs/ASSET_CREDITS.md); individual artist credits and source license records must accompany any permitted visual bundle.

The recruitment project that inspired the battle concept and the source of the Gamma environment assets are separate references. This prototype is unofficial and does not imply endorsement or affiliation. Original artwork and Pokémon belong to their respective rights holders. This source export contains no artwork bundle and makes no blanket open-source or redistribution claim for third-party resources.
