#!/usr/bin/env python3
"""Basic validation for roots.json."""

from __future__ import annotations

import json
from pathlib import Path

p = Path("public/data/roots.json")
obj = json.loads(p.read_text(encoding="utf-8"))
entries = obj.get("entries", [])

assert isinstance(entries, list), "entries must be list"
assert obj.get("meta", {}).get("entryCount", 0) > 0, "entryCount must be > 0"
assert obj.get("meta", {}).get("exampleCount", 0) > 0, "exampleCount must be > 0"

required = {"id", "type", "root", "meaningZh", "section", "aliases", "examples", "tags", "confidence"}
ok_fields = 0
all_fields = len(entries) * len(required)

for e in entries:
    ok_fields += sum(1 for k in required if k in e)

ratio = ok_fields / all_fields if all_fields else 0
print(f"entryCount={len(entries)}")
print(f"exampleCount={obj['meta']['exampleCount']}")
print(f"fieldCompleteness={ratio:.3f}")
assert ratio >= 0.9, "field completeness must be >= 0.9"
print("validation passed")
