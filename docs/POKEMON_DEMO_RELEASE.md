# Pokemon demo — demonstration and release plan

## Audience and presentation

The intended audience is the team seeking server/online/PvP help in the user's supplied Big Kid Nation recruitment screenshots. The battle reference videos and the Gamma Emerald environment assets have different provenance; do not imply that they are the same project or that this is an official product.

Send a concise introduction with a 60–90 second gameplay clip first. Suggested sequence: 0–10s introduction and exploration; 10–25s encounter-to-generated-room transition; 25–50s commands, movement and cover; 50–70s destruction and changed routes; 70–90s concise feature status and invitation to try the demo. Use English captions. Show experimental Qwen/training footage separately, only if it is recorded from its actual working main-project interface.

The longer and shorter English drafts are in `pokemon-demo-introduction.en.txt`. They describe architecture/design experience, AI-assisted prototyping, and an interest in contributing to PvP gameplay without inventing hosting credentials or claiming unfinished integrations are complete.

## Deliverables

1. Private `pokemon-demo` repository for source review, attribution and deployment files. Invite reviewers explicitly when they agree; a private repository link alone does not grant access.
2. A gameplay video accessible without installing dependencies.
3. An HTTPS playable service that serves the static Web build and the existing FastAPI combat API from one origin. Keep the server to one worker while battles are held in process memory. A restart clears live battles.

GitHub Pages is a static hosting service and cannot by itself execute this Python combat backend. A container host or FastAPI-capable host is required for the playable link. Hosting account access, a chosen plan and any cost approval are separate from creating the GitHub repository; this plan does not claim that a public service has already been deployed.

The isolated demo does not require an Ollama model. If Qwen is demonstrated later, the server needs a separately configured inference service; do not bundle local model weights into the repository or expose the raw Ollama endpoint publicly. A browser receiving a static build cannot call the developer's localhost.

## Honest feature status

| Feature | Standalone demo | Broader local project |
| --- | --- | --- |
| Real-time autonomous combat and fixed tactical/move commands | Implemented | Implemented |
| Generated encounter arenas and destructible cover | Implemented | Separate demo adaptation |
| Qwen companion dialogue and individual memory | Not integrated | Implemented experiment |
| Tabular Q-learning and training styles | Not integrated | Implemented experiment |
| Two-player invitation-room PvP | Not integrated | Prototype |
| Production matchmaking, scalable hosting, reconnect guarantees | Not established | Not established |

## Packaging

Use an explicit source allowlist. Exclude `.env`, databases, account data, runtime logs, dependencies, model weights, original game archives, and unrelated projects. Keep required content definitions, source credits and the deployment wrapper. Do not publish the full approximately 9 GB extraction archive.

The current visual build uses Gamma Emerald and PMD resources. Keep the original creator and per-species credits, and distinguish those resources from original code. The local source record does not establish an open redistribution license for the Gamma assets. The source export therefore keeps media separate; a visual build needs the required asset package restored locally and its intended distribution scope established.

Current build blocker (2026-10-13 Asia/Shanghai): some source assets are macOS `dataless` cloud placeholders. The title change passes TypeScript and static checks, but the full Vite build hit `ETIMEDOUT` while reading CSS resources. An old or incomplete `.runtime/gamma-web` output must not be labelled a verified release. Restore the required assets, rebuild, then verify title, encounter, command, cover and return flow before publishing a playable URL.

## Primary hosting documentation

- [GitHub Pages is static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [FastAPI deployment on Render](https://render.com/docs/deploy-fastapi)
- [GitHub large-file limits and release assets](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)
