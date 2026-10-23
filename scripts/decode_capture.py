"""TEMPORARY (feedback capture, 0.4.2): unpack Ctrl+Shift+F capture codes. Remove with the tool, by 1.9.0.

Usage: python scripts/decode_capture.py CODE_OR_FILE [...] [--out DIR]
Reads "MPRO-FB2:" (0.4.3+: base85 of deflate-raw [u32 JSON length][JSON][image]) and "MPRO-FB1:" (0.4.2: base64 of
gzip JSON) codes, prints a summary, and writes each capture's JSON and screenshot to DIR (default: ./captures).
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import sys
import zlib
from pathlib import Path
from typing import Any

B85 = "".join(ch for ch in map(chr, range(33, 127)) if ch not in "\"&'*<>\\_`")
assert len(B85) == 85
B85_INDEX = {c: i for i, c in enumerate(B85)}


def b85decode(text: str) -> bytes:
    out = bytearray()
    for i in range(0, len(text), 5):
        group = text[i : i + 5]
        n = len(group)
        if n == 1:
            raise ValueError("damaged code (stray character at the end)")
        v = 0
        for ch in group.ljust(5, B85[84]):
            v = v * 85 + B85_INDEX[ch]
        out += (v & 0xFFFFFFFF).to_bytes(4, "big")[: n - 1]
    return bytes(out)


def decode(code: str) -> tuple[dict[str, Any], bytes | None]:
    code = "".join(code.split())
    if code.startswith("MPRO-FB2:"):
        raw = zlib.decompress(b85decode(code[9:]), wbits=-15)
        n = int.from_bytes(raw[:4], "big")
        cap = json.loads(raw[4 : 4 + n])
        img = raw[4 + n :] or None
        return cap, img
    if code.startswith("MPRO-FB1:"):
        cap = json.loads(gzip.decompress(base64.b64decode(code[9:])))
        shot = cap.get("shot")
        img = None
        if shot and shot.get("data"):
            head, b64 = shot.pop("data").split(",", 1)
            shot["type"] = head[5:].split(";")[0]
            img = base64.b64decode(b64)
        return cap, img
    raise ValueError("not a capture code (expected MPRO-FB2: or MPRO-FB1:)")


def summary(cap: dict[str, Any]) -> str:
    p = cap.get("page", {})
    lines = [
        f"{cap.get('kind')} · {cap.get('priority')} · {cap.get('target')} capture · {cap.get('created')}",
        f"note: {cap.get('text')!r}",
        f"page: {p.get('path')} · {p.get('heading')}"
        + (f" · dialog: {p['dialog']}" if p.get("dialog") else "")
        + (f" · tabs: {', '.join(p['tabs'])}" if p.get("tabs") else ""),
    ]
    for c in cap.get("containers") or []:
        lines.append(f"  in {c.get('tag')} {c.get('name', '')!r}")
    e = cap.get("element")
    if e:
        lines.append(f"element: {e.get('selector')}  name={e.get('name')!r}")
        for k in ("row", "column", "sections", "within"):
            if e.get(k):
                lines.append(f"  {k}: {e[k]}")
    for e in cap.get("elements") or []:
        parts = (e.get("row") and f"row={e['row']!r}", e.get("column") and f"col={e['column']!r}")
        where = " ".join(x for x in parts if x)
        lines.append(f"  #{e.get('n')} {e.get('tag')} {e.get('name', e.get('text', ''))[:60]!r} {where} {e.get('box')}")
    for n in cap.get("notes") or []:
        lines.append(f"  note: {n}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("codes", nargs="+", help="a code, or a file holding one")
    ap.add_argument("--out", default="captures")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for i, src in enumerate(a.codes, 1):
        path = Path(src)
        code = path.read_text(encoding="utf-8") if not src.startswith("MPRO-") and path.exists() else src
        try:
            cap, img = decode(code)
        except Exception as e:  # noqa: BLE001
            print(f"[{i}] {src[:40]}: {e}", file=sys.stderr)
            continue
        stem = out / f"capture-{i}"
        stem.with_suffix(".json").write_text(json.dumps(cap, indent=1, ensure_ascii=False), encoding="utf-8")
        if img:
            ext = (cap.get("shot") or {}).get("type", "image/webp").split("/")[1]
            stem.with_suffix("." + ext).write_bytes(img)
        print(f"[{i}] {len(''.join(code.split()))} chars → {stem}.json" + (f" + image ({len(img)} B)" if img else ""))
        print(summary(cap))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
