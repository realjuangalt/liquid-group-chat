#!/usr/bin/env python3
"""Refresh snapshot.json with txs newer than the baked set.

Paginates mempool.space address history until a known snapshot txid, keeps
conversation-looking txs (OP_RETURN, large federation payouts, existing
snapshot ids), and writes snapshot.json. No API keys.
"""

from __future__ import annotations

import json
import ssl
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "snapshot.json"

HOLDER = "bc1ql4mfu6aundtkksxklfajs2h3t9nzcd6gyqjlte"
CONTACT = "bc1qn8mgsmxx42j3fflqfkh0cqhdd6mj4h9q2mfqym"
FEDERATION = "bc1qdlld6antmv4xug242ed83q7k4rqw50cwfns38szx4qu2f4jwaxxsuhwxxr"
MIN_HEIGHT = 965783
LARGE_SATS = 100_000_000
API = "https://mempool.space/api"


def get_json(path: str):
    url = API + path
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "liquid-group-chat-snapshot"})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as res:
        return json.load(res)


def fetch_until_known(address: str, known: set[str]) -> list[dict]:
    out = []
    seen = set()
    path = f"/address/{address}/txs"
    for _ in range(24):
        page = get_json(path)
        if not page:
            break
        hit_known = False
        added = 0
        last_confirmed = None
        for tx in page:
            txid = tx.get("txid")
            if not txid or txid in seen:
                continue
            seen.add(txid)
            status = tx.get("status") or {}
            if status.get("confirmed"):
                last_confirmed = tx
            if txid in known:
                hit_known = True
                continue
            out.append(tx)
            added += 1
        if hit_known:
            break
        if not last_confirmed:
            break
        height = (last_confirmed.get("status") or {}).get("block_height") or 0
        if height < MIN_HEIGHT or not added:
            break
        path = f"/address/{address}/txs/chain/{last_confirmed['txid']}"
    return out


def has_op_return(tx: dict) -> bool:
    for vout in tx.get("vout") or []:
        if vout.get("scriptpubkey_type") == "op_return":
            return True
    return False


def paid_to(tx: dict, address: str) -> int:
    return sum(
        int(v.get("value") or 0)
        for v in (tx.get("vout") or [])
        if v.get("scriptpubkey_address") == address
    )


def senders(tx: dict) -> set[str]:
    out = set()
    for vin in tx.get("vin") or []:
        prev = vin.get("prevout") or {}
        addr = prev.get("scriptpubkey_address")
        if addr:
            out.add(addr)
    return out


def harvest_addrs(txs: list[dict]) -> list[str]:
    addrs = set()
    for tx in txs:
        addrs |= senders(tx)
        for vout in tx.get("vout") or []:
            addr = vout.get("scriptpubkey_address")
            if addr:
                addrs.add(addr)
    addrs.discard(HOLDER)
    addrs.discard(FEDERATION)
    addrs.add(CONTACT)
    return [CONTACT] + [a for a in sorted(addrs) if a != CONTACT]


def keep(tx: dict, watched: set[str]) -> bool:
    froms = senders(tx)
    if has_op_return(tx) and (HOLDER in froms or froms & watched):
        return True
    if HOLDER in froms and paid_to(tx, FEDERATION) >= LARGE_SATS:
        return True
    if tx.get("txid") == "8db751a650ae2f12006b7e8c69a75e4df360e8afd6b9e05ae0b9fa6458a7b140":
        return True
    return False


def sort_key(tx: dict):
    status = tx.get("status") or {}
    return (status.get("block_height") or 0, status.get("block_time") or 0)


def main() -> None:
    data = json.loads(SNAPSHOT.read_text())
    txs = {tx["txid"]: tx for tx in data.get("txs") or [] if tx.get("txid")}
    known = set(txs)
    watched = set(harvest_addrs(list(txs.values())))
    for addr in [HOLDER, *list(watched)[:16]]:
        try:
            newer = fetch_until_known(addr, known)
        except Exception as err:
            print(f"skip {addr}: {err}")
            continue
        for tx in newer:
            if keep(tx, watched):
                txs[tx["txid"]] = tx
                watched |= set(harvest_addrs([tx]))
    ordered = sorted(txs.values(), key=sort_key)
    out = {
        "asOf": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "Baked conversation. The page only asks explorers for txs newer than these.",
        "txs": ordered,
    }
    SNAPSHOT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {SNAPSHOT} ({len(ordered)} txs, asOf {out['asOf']})")


if __name__ == "__main__":
    main()
