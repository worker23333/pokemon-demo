# pokemon-demo

Experimental real-time Pokemon battle prototype with generated arenas and destructible cover.

## Status

- **Stage:** source review. This repository is being prepared for code review; source code will be added in follow-up commits.
- **Playable demo:** not yet released. No HTTPS playable build is online.
- **Visual assets:** not included in this repository. Art, audio and models are provided separately and are not covered by this repository's code license.

## What the prototype is

A web prototype (Three.js front end + a single FastAPI service) in which battles run as a real-time simulation on an authoritative Python server at 20 Hz. Encounters take place in arenas generated from hand-made layout templates, with destructible cover inside an indestructible perimeter, and are controlled with fixed commands.

Pokémon is a trademark of Nintendo, Creatures Inc. and GAME FREAK inc. This is a non-commercial fan project and is not affiliated with or endorsed by them.
