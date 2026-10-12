from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Content:
    def __init__(self, path=None):
        folder = Path(path or ROOT / "packages" / "content")
        try:
            self.species = json.loads((folder / "species.json").read_text())
            self.regions = json.loads((folder / "regions.json").read_text())
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Missing or invalid game content at {folder}. Generate species.json and regions.json first.") from exc
        self.by_species = {int(s["id"]): s for s in self.species}
        self.by_region = {r["id"]: r for r in self.regions}
        if len(self.by_species) != 151 or set(self.by_species) != set(range(1, 152)):
            raise RuntimeError("Content must contain all 151 Generation I standard species exactly once.")
        if "pallet-town" not in self.by_region:
            raise RuntimeError("Content must include pallet-town.")

    def species_at(self, ident):
        return self.by_species[int(ident)]


def stat(species, key, default=50):
    values = species.get("stats", {})
    aliases = {"special": ("special", "specialAttack", "special-attack", "spAttack"),
               "hp": ("hp", "health"), "attack": ("attack",),
               "defense": ("defense",), "speed": ("speed",)}
    for name in aliases.get(key, (key,)):
        if name in values:
            return max(1, int(values[name]))
    return default


def max_hp(species, level):
    return int((2 * stat(species, "hp") + 31) * level / 100) + level + 10
