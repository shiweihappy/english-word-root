#!/usr/bin/env python3
"""Extract root/affix entries and examples from XDF.pdf into JSON."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT_HEADING_RE = re.compile(r"^\s*(\d+)[、.]\s*(.+)$")
EXAMPLE_HEAD_RE = re.compile(r"^([A-Za-z][A-Za-z\-']{1,30})(.*)$")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")

NOISE_PATTERNS = [
    re.compile(r"^\s*\d+\s*$"),
    re.compile(r"^\s*英语词根词缀记忆大全\s*$"),
    re.compile(r"^\s*第一部分\s*"),
    re.compile(r"^\s*第二部分\s*"),
    re.compile(r"^\s*第三部分\s*"),
]

REPLACE_MAP = {
    "（": "(",
    "）": ")",
    "，": ",",
    "；": ";",
    "：": ":",
    "“": '"',
    "”": '"',
    "。": ".",
    "　": " ",
    "—": "-",
    "―": "-",
    "－": "-",
    "\f": " ",
}


def run_pdftotext(pdf_path: Path) -> str:
    cmd = ["pdftotext", "-layout", str(pdf_path), "-"]
    out = subprocess.check_output(cmd, text=True, encoding="utf-8", errors="ignore")
    return out


def normalize_text(s: str) -> str:
    for k, v in REPLACE_MAP.items():
        s = s.replace(k, v)
    return s


def split_multicolumn_line(line: str) -> List[str]:
    parts = [p.strip() for p in re.split(r"\s{8,}", line) if p.strip()]
    if not parts:
        return []
    return parts


def is_noise(line: str) -> bool:
    if not line.strip():
        return True
    for pat in NOISE_PATTERNS:
        if pat.search(line):
            return True
    return False


def merge_broken_lines(lines: List[str]) -> List[str]:
    merged: List[str] = []
    buf = ""
    balance = 0

    def paren_balance(text: str) -> int:
        return text.count("(") - text.count(")")

    for line in lines:
        if not line:
            continue
        if not buf:
            buf = line
            balance = paren_balance(line)
        else:
            # If previous line has open parenthesis, merge current line.
            if balance > 0 or (len(buf) < 20 and not CJK_RE.search(buf)):
                buf = f"{buf} {line}"
                balance += paren_balance(line)
            else:
                merged.append(buf.strip())
                buf = line
                balance = paren_balance(line)

    if buf:
        merged.append(buf.strip())

    return merged


def clean_line(line: str) -> str:
    line = normalize_text(line)
    line = re.sub(r"\s+", " ", line).strip()
    line = line.replace(" .", ".")
    line = line.replace(" ,", ",")
    line = line.replace(" ;", ";")
    return line


def infer_type(root: str) -> str:
    if root.startswith("-"):
        return "suffix"
    if root.endswith("-"):
        return "prefix"
    return "root"


def parse_root_tokens(raw: str) -> List[str]:
    text = raw
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"=[A-Za-z ,/]+", " ", text)
    text = text.replace("、", " ")
    text = text.replace("/", " ")
    text = text.replace("，", " ")
    text = text.replace(",", " ")

    token_re = re.compile(
        r"(?<![A-Za-z])-[A-Za-z]{1,12}(?![A-Za-z])"
        r"|(?<![A-Za-z])[A-Za-z]{1,12}-(?![A-Za-z])"
        r"|(?<![A-Za-z])[A-Za-z]{1,12}\([A-Za-z]{1,3}\)(?![A-Za-z])"
        r"|(?<![A-Za-z])[A-Za-z]{2,12}(?![A-Za-z])"
    )

    raw_tokens = [m.group(0) for m in token_re.finditer(text)]

    candidates = []
    for tok in raw_tokens:
        tok = tok.strip()
        if not tok:
            continue
        m_variant = re.match(r"^([A-Za-z]+)\(([A-Za-z]+)\)$", tok)
        if m_variant:
            tok = f"{m_variant.group(1)}{m_variant.group(2)}"
        tok = tok.lower()
        if tok in {"ability", "able", "ably", "year"}:
            continue
        if tok.startswith("-") and re.search(r"[\u4e00-\u9fff]-[A-Za-z]", raw):
            tok = tok[1:]
        if tok.startswith("-") or tok.endswith("-"):
            pass
        elif len(tok) <= 4 and ("加在" in raw or "前缀" in raw):
            tok = f"{tok}-"
        candidates.append(tok)

    uniq: List[str] = []
    seen = set()
    for c in candidates:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def extract_meaning_from_heading(line: str) -> str:
    quoted = re.search(r'表示\s*"([^"]+)"', line)
    if quoted:
        return quoted.group(1).strip()

    if "表示" in line:
        after = line.split("表示", 1)[1]
        after = after.strip(" :")
        return after[:120].strip()

    return ""


def parse_example_line(line: str) -> Optional[Dict[str, str]]:
    if len(line) > 1200:
        return None

    m = EXAMPLE_HEAD_RE.match(line)
    if not m:
        return None

    word = m.group(1).lower()
    rest = m.group(2).strip()
    if not rest:
        return None

    # Should include Chinese info somewhere.
    if not CJK_RE.search(rest):
        return None

    decomposition = ""
    paren = re.search(r"\(([^)]{1,180})\)", rest)
    if paren:
        decomposition = paren.group(1).strip()

    explanation = re.sub(r"\([^)]*\)", "", rest).strip(" .;:")
    if len(explanation) > 3000:
        return None

    if not explanation and decomposition and "->" in decomposition:
        explanation = decomposition.split("->")[-1].strip()
    if not explanation and decomposition and "→" in decomposition:
        explanation = decomposition.split("→")[-1].strip()

    if len(word) < 2 or len(explanation) < 1:
        return None

    decomposition = decomposition.replace("+", " + ").replace("  ", " ").strip()
    if len(decomposition) > 220:
        decomposition = decomposition[:220].rstrip() + "..."
    if len(explanation) > 220:
        explanation = explanation[:220].rstrip() + "..."

    return {
        "word": word,
        "decomposition": decomposition,
        "explanationZh": explanation,
        "rawLine": line,
    }


def derive_root_from_example(example: Dict[str, str]) -> Optional[str]:
    decomp = example.get("decomposition", "")
    if not decomp:
        return None
    if "+" not in decomp:
        return None
    first = decomp.split("+", 1)[0].strip().lower()
    first = re.sub(r"[^a-z\-]", "", first)
    if not first:
        return None
    if not first.endswith("-") and not first.startswith("-"):
        first = f"{first}-"
    return first


def stable_id(entry_type: str, root: str) -> str:
    core = re.sub(r"[^a-z0-9]+", "-", root.lower()).strip("-")
    return f"{entry_type}-{core or 'x'}"


def pick_tags(meaning: str) -> List[str]:
    tags = []
    if "不" in meaning or "无" in meaning or "非" in meaning:
        tags.append("否定")
    if "前" in meaning or "后" in meaning or "旁" in meaning:
        tags.append("位置")
    if "共同" in meaning or "一起" in meaning:
        tags.append("共同")
    return tags


def build_entries(raw_text: str) -> Tuple[List[dict], dict]:
    raw_lines = raw_text.splitlines()

    lines: List[str] = []
    for raw in raw_lines:
        for part in split_multicolumn_line(raw):
            line = clean_line(part)
            if is_noise(line):
                continue
            lines.append(line)

    lines = merge_broken_lines(lines)

    entries_by_root: Dict[str, dict] = {}
    current_section = ""
    current_roots: List[str] = []
    derived_examples: Dict[str, List[Dict[str, str]]] = defaultdict(list)

    for line in lines:
        if "(" in line and ")" not in line and len(line) < 80:
            # likely broken heading, skip and let merged lines handle later
            continue

        if re.search(r"常用前缀|常用后缀|词根", line) and len(line) <= 120:
            current_section = line

        hm = ROOT_HEADING_RE.match(line)
        if hm:
            body = hm.group(2)
            if parse_example_line(body):
                hm = None
        if hm:
            body = hm.group(2)
            roots = parse_root_tokens(body)
            meaning = extract_meaning_from_heading(body)
            if roots:
                current_roots = roots
                for idx, root in enumerate(roots):
                    entry_type = infer_type(root)
                    eid = stable_id(entry_type, root)
                    if eid not in entries_by_root:
                        entries_by_root[eid] = {
                            "id": eid,
                            "type": entry_type,
                            "root": root,
                            "meaningZh": meaning,
                            "section": current_section[:120],
                            "aliases": [r for r in roots if r != root],
                            "examples": [],
                            "tags": pick_tags(meaning),
                            "confidence": 0.9 if meaning else 0.75,
                        }
                    else:
                        if meaning and not entries_by_root[eid]["meaningZh"]:
                            entries_by_root[eid]["meaningZh"] = meaning
                continue

        example = parse_example_line(line)
        if not example:
            continue

        derived_root = derive_root_from_example(example)
        if derived_root:
            derived_examples[derived_root].append(example)

        target_roots = current_roots[:]
        if not target_roots:
            if derived_root:
                target_roots = [derived_root]

        if not target_roots:
            continue

        for root in target_roots:
            entry_type = infer_type(root)
            eid = stable_id(entry_type, root)
            if eid not in entries_by_root:
                entries_by_root[eid] = {
                    "id": eid,
                    "type": entry_type,
                    "root": root,
                    "meaningZh": "",
                    "section": current_section[:120],
                    "aliases": [],
                    "examples": [],
                    "tags": [],
                    "confidence": 0.65,
                }

            existing = {ex["word"]: ex for ex in entries_by_root[eid]["examples"]}
            prev = existing.get(example["word"])
            if prev:
                prev_score = len(prev.get("decomposition", "")) + len(prev.get("explanationZh", ""))
                new_score = len(example.get("decomposition", "")) + len(example.get("explanationZh", ""))
                if new_score > prev_score:
                    for i, ex in enumerate(entries_by_root[eid]["examples"]):
                        if ex["word"] == example["word"]:
                            entries_by_root[eid]["examples"][i] = example
                            break
            else:
                entries_by_root[eid]["examples"].append(example)

    # Recovery pass: build entries from frequently observed decomposition roots.
    for root, ex_list in derived_examples.items():
        if len(ex_list) < 4:
            continue
        if not re.match(r"^[a-z]{1,10}-$", root):
            continue
        eid = stable_id(infer_type(root), root)
        if eid in entries_by_root:
            continue

        by_word: Dict[str, Dict[str, str]] = {}
        for ex in ex_list:
            prev = by_word.get(ex["word"])
            if not prev:
                by_word[ex["word"]] = ex
            else:
                prev_score = len(prev.get("decomposition", "")) + len(prev.get("explanationZh", ""))
                new_score = len(ex.get("decomposition", "")) + len(ex.get("explanationZh", ""))
                if new_score > prev_score:
                    by_word[ex["word"]] = ex

        uniq_ex = list(by_word.values())
        uniq_ex.sort(key=lambda x: x["word"])
        meanings = []
        seen_m = set()
        for ex in uniq_ex:
            m = ex.get("explanationZh", "").strip()
            if m and m not in seen_m:
                seen_m.add(m)
                meanings.append(m)
            if len(meanings) >= 2:
                break

        entries_by_root[eid] = {
            "id": eid,
            "type": infer_type(root),
            "root": root,
            "meaningZh": ("自动聚合义项: " + "；".join(meanings)) if meanings else "",
            "section": current_section[:120],
            "aliases": [],
            "examples": uniq_ex,
            "tags": [],
            "confidence": 0.72,
        }

    entries = list(entries_by_root.values())
    entries.sort(key=lambda x: (x["type"], x["root"]))

    # Update confidence with example coverage.
    for e in entries:
        if not e["meaningZh"] and e["examples"]:
            uniq_meanings = []
            seen_m = set()
            for ex in e["examples"]:
                m = ex.get("explanationZh", "").strip()
                if m and m not in seen_m:
                    seen_m.add(m)
                    uniq_meanings.append(m)
                if len(uniq_meanings) >= 2:
                    break
            if uniq_meanings:
                e["meaningZh"] = "例词义项: " + "；".join(uniq_meanings)
        if e["examples"] and e["meaningZh"]:
            e["confidence"] = max(e["confidence"], 0.92)
        elif e["examples"]:
            e["confidence"] = max(e["confidence"], 0.7)
        e["confidence"] = round(min(e["confidence"], 0.99), 2)

    meta = {
        "entryCount": len(entries),
        "exampleCount": sum(len(e["examples"]) for e in entries),
    }
    return entries, meta


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", default="XDF.pdf", help="Path to source PDF")
    parser.add_argument("--out", default="public/data/roots.json", help="Output JSON path")
    parser.add_argument("--include-raw-line", action="store_true", help="Keep examples[].rawLine in output")
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    out_path = Path(args.out)

    text = run_pdftotext(pdf_path)
    entries, meta = build_entries(text)

    payload = {
        "meta": {
            "sourceFile": str(pdf_path.name),
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "entryCount": meta["entryCount"],
            "exampleCount": meta["exampleCount"],
            "compact": True,
            "includesRawLine": bool(args.include_raw_line),
        },
        "entries": entries,
    }

    if not args.include_raw_line:
        for entry in payload["entries"]:
            for ex in entry["examples"]:
                ex.pop("rawLine", None)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"Wrote {out_path} with {meta['entryCount']} entries and {meta['exampleCount']} examples")


if __name__ == "__main__":
    main()
