#!/usr/bin/env python3
"""Refresh snapshot.json with txs newer than the baked set.

Paginates address history until a known snapshot txid, keeps conversation-looking
txs (OP_RETURN, large federation payouts, existing snapshot ids), force-includes
optional FORCE_TXIDS, and writes snapshot.json. Prefers blockstream.info; falls
back to mempool.space. Retries on 429. No API keys.
"""

from __future__ import annotations

import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "snapshot.json"
PGP_PUBKEY = ROOT / "pgp.txt"

HOLDER = "bc1ql4mfu6aundtkksxklfajs2h3t9nzcd6gyqjlte"
CONTACT = "bc1qn8mgsmxx42j3fflqfkh0cqhdd6mj4h9q2mfqym"
FEDERATION = "bc1qdlld6antmv4xug242ed83q7k4rqw50cwfns38szx4qu2f4jwaxxsuhwxxr"
MIN_HEIGHT = 965783
LARGE_SATS = 100_000_000
# Blockstream Security Reporting <security@blockstream.com>
BLOCKSTREAM_KEY_ID = "4AC8CC886844A2D6"
APIS = [
    "https://blockstream.info/api",
    "https://mempool.space/api",
]

# Always bake these conversation txids even if address scan misses them.
FORCE_TXIDS = [
    "8db751a650ae2f12006b7e8c69a75e4df360e8afd6b9e05ae0b9fa6458a7b140",
    "c103de95817b43f2df635ec6f35ff126ca26a7c6d20570c4b01866b2b3e69a19",
    "91271efcbb5ab29abfc38ae635f0644e3ba042aad56f92d40136e1dde4742fe8",
    "bd81219691eb1e22475c5985d847fa888c38f1b6d2cb2b7193f54d0cfa72394c",
    "3a3eac4a26395b8c2563aaf1eb8b1b77798c81c7d6337f51321827a244a480aa",
    "83825b2135dd0abac12c9dfe17f29ab81b3427e1ae864947b0bebce5e47c3c4b",
    "8a444eed65c4584f138e08ee138f61490ef73e84f71e14dac3ca66c230cf7e97",
    "87dc0a20099a94c2caaa3fa93d1724cfe41b05ae5e0778cc0e8994b22e81120c",
    "0256e33797ab173a5df1f2cd9689a81241f385dabb7e998e06ce78855ff19016",
    "4656114340749ba4aade1affcb2625a1dac37214b32b7d7c242af2ca9fe6d690",
    "3c101c8e053a6cbc7c4455e4fec017c8f2962ed86dee70e72fb8bafbb1d7bde9",
    "a6d697a25266ce3c78774fd1d75f896b7af522ada209b0f6228ea497bc49a46d",
    "51232243b408cc7676fc308447de6c26d0fecc7d2602b8b6588e46dd509bfcf1",
    "892bf79da2d23e28db3c82b1695185d36fdcb64ae96bad885edef6686072e975",
    "9393df5b6166a1a6bf97bc1b40b3da3ac87b65db67dc31ef2115e31fa5a5cc93",
    "136612fc5618e33c4ae45753a759ac61014fae3133180bd2dc6f10f5856cbd78",
    "e56af6b9f889b0e7ed342508eaab2f997fafbb61d64c892bbf306a0014722596",
    "fcd06c1bcb38e4c3eaf71c1137d7bdf935363ae3c14b590d5d1a501e326d2b99",
    "36a07a98f576edde8101f7bc0b1241e03501a1c2533c7d5f40291f1ddd7cf84b",
    "b3830692852d85cfc0e664cd57f1cd0230686be6f9aef41c49c613e91fe9da6a",
    "d7e8837c51cc625c2c6365d371d376b035209fa01434d4933971d6428d6d6d52",
    # Blockstream clearsigns from fresh addresses (live page keeps via PGP; address
    # watch alone misses them once a newer known holder tx stops pagination).
    "9a041c868fc4029601e4b248f21cc786e43405e4ca7d6bdb2c339aeb0f576a9b",
    "57bd5c9be33276f6a80dc723a9ef064b09b29972b82c9684da051d110f6ef0f6",
    "a388ab824afd20d4fa91d016acaaa2db1d20bf40f0e6c9f87a97a0adc0554d12",
    "f4473e85f0b63751c569622d1673d9e9219443992617053fe79a99dbc79391ea",
]

CTX = ssl.create_default_context()
_active_api = APIS[0]


def get_json(path: str, retries: int = 8):
    global _active_api
    last_err: Exception | None = None
    apis = [_active_api] + [a for a in APIS if a != _active_api]
    for api in apis:
        url = api + path
        for i in range(retries):
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": "liquid-group-chat-snapshot"}
                )
                with urllib.request.urlopen(req, timeout=45, context=CTX) as res:
                    _active_api = api
                    return json.load(res)
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code == 404:
                    return None
                if e.code == 429:
                    wait = min(60, 2**i)
                    print(f"429 on {api}{path}, sleep {wait}s", file=sys.stderr)
                    time.sleep(wait)
                    continue
                break
            except Exception as e:
                last_err = e
                wait = min(30, 1.5**i)
                print(f"err {api}{path}: {e}, sleep {wait}s", file=sys.stderr)
                time.sleep(wait)
    raise RuntimeError(f"failed {path}: {last_err}")


def slim_tx(tx: dict) -> dict:
    status = tx.get("status") or {}
    slim_status = {"confirmed": bool(status.get("confirmed"))}
    if status.get("confirmed"):
        for k in ("block_height", "block_time", "block_hash"):
            if k in status:
                slim_status[k] = status[k]
    vin = []
    for v in tx.get("vin") or []:
        prev = v.get("prevout") or {}
        entry: dict = {"prevout": {}}
        if prev.get("scriptpubkey_address") is not None:
            entry["prevout"]["scriptpubkey_address"] = prev["scriptpubkey_address"]
        if "value" in prev:
            entry["prevout"]["value"] = prev["value"]
        vin.append(entry)
    vout = []
    for o in tx.get("vout") or []:
        vout.append(
            {
                "scriptpubkey": o.get("scriptpubkey"),
                "scriptpubkey_type": o.get("scriptpubkey_type"),
                "scriptpubkey_address": o.get("scriptpubkey_address"),
                "value": o.get("value"),
            }
        )
    return {"txid": tx["txid"], "status": slim_status, "vin": vin, "vout": vout}


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


def op_return_texts(tx: dict) -> list[str]:
    out: list[str] = []
    for vout in tx.get("vout") or []:
        if vout.get("scriptpubkey_type") != "op_return":
            continue
        hx = vout.get("scriptpubkey") or ""
        try:
            raw = bytes.fromhex(hx)
        except ValueError:
            continue
        if not raw or raw[0] != 0x6A:
            continue
        i = 1
        if i >= len(raw):
            continue
        if raw[i] == 0x4C and i + 1 < len(raw):
            n = raw[i + 1]
            data = raw[i + 2 : i + 2 + n]
        elif raw[i] == 0x4D and i + 2 < len(raw):
            n = int.from_bytes(raw[i + 1 : i + 3], "little")
            data = raw[i + 3 : i + 3 + n]
        else:
            n = raw[i]
            data = raw[i + 1 : i + 1 + n]
        out.append(data.decode("utf-8", errors="replace"))
    return out


_gpg_home: str | None = None
_gpg_ready = False


def _ensure_gpg() -> bool:
    global _gpg_home, _gpg_ready
    if _gpg_ready:
        return True
    if not PGP_PUBKEY.is_file() or shutil.which("gpg") is None:
        return False
    _gpg_home = tempfile.mkdtemp(prefix="liquid-chat-gpg-")
    env = os.environ.copy()
    env["GNUPGHOME"] = _gpg_home
    try:
        subprocess.run(
            ["gpg", "--batch", "--import", str(PGP_PUBKEY)],
            env=env,
            capture_output=True,
            check=False,
        )
        _gpg_ready = True
        return True
    except Exception as err:
        print(f"gpg import failed: {err}", file=sys.stderr)
        return False


def is_blockstream_clearsign(tx: dict) -> bool:
    """True when an OP_RETURN clearsign verifies with Blockstream's published key."""
    texts = op_return_texts(tx)
    if not any("BEGIN PGP SIGNED MESSAGE" in t for t in texts):
        return False
    if not _ensure_gpg() or not _gpg_home:
        return False
    env = os.environ.copy()
    env["GNUPGHOME"] = _gpg_home
    blob = "\n".join(texts)
    msg_path = Path(_gpg_home) / "candidate.asc"
    try:
        msg_path.write_text(blob, encoding="utf-8")
        proc = subprocess.run(
            ["gpg", "--batch", "--status-fd", "1", "--verify", str(msg_path)],
            env=env,
            capture_output=True,
            check=False,
        )
        status = (proc.stdout or b"").decode("utf-8", errors="replace")
        return "GOODSIG" in status and BLOCKSTREAM_KEY_ID in status
    except Exception:
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
    # Live page attributes valid Blockstream clearsigns even from fresh addresses.
    if has_op_return(tx) and is_blockstream_clearsign(tx):
        return True
    if HOLDER in froms and paid_to(tx, FEDERATION) >= LARGE_SATS:
        return True
    if tx.get("txid") == "8db751a650ae2f12006b7e8c69a75e4df360e8afd6b9e05ae0b9fa6458a7b140":
        return True
    return False


def sort_key(tx: dict):
    status = tx.get("status") or {}
    # Unconfirmed last (height treated as far future for ordering).
    if not status.get("confirmed"):
        return (10**12, status.get("block_time") or 0, tx.get("txid") or "")
    return (
        status.get("block_height") or 0,
        status.get("block_time") or 0,
        tx.get("txid") or "",
    )


def main() -> None:
    data = json.loads(SNAPSHOT.read_text())
    txs = {tx["txid"]: tx for tx in data.get("txs") or [] if tx.get("txid")}
    known = set(txs)
    watched = set(harvest_addrs(list(txs.values())))

    for txid in FORCE_TXIDS:
        if txid in txs and (txs[txid].get("status") or {}).get("confirmed"):
            continue
        try:
            raw = get_json(f"/tx/{txid}")
        except Exception as err:
            print(f"force skip {txid[:12]}: {err}", file=sys.stderr)
            continue
        if not raw:
            print(f"force missing {txid[:12]}", file=sys.stderr)
            continue
        txs[txid] = slim_tx(raw)
        known.add(txid)
        watched |= set(harvest_addrs([txs[txid]]))
        time.sleep(0.15)

    for addr in [HOLDER, *list(watched)[:16]]:
        try:
            newer = fetch_until_known(addr, known)
        except Exception as err:
            print(f"skip {addr}: {err}")
            continue
        for tx in newer:
            if keep(tx, watched):
                txs[tx["txid"]] = slim_tx(tx)
                watched |= set(harvest_addrs([tx]))

    try:
        mem = get_json(f"/address/{HOLDER}/txs/mempool") or []
        for tx in mem:
            if keep(tx, watched):
                txs[tx["txid"]] = slim_tx(tx)
    except Exception as err:
        print(f"skip holder mempool: {err}", file=sys.stderr)

    ordered = sorted(txs.values(), key=sort_key)
    out = {
        "asOf": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": 'Baked conversation through whitehats ":(". The page only asks explorers for txs newer than these.',
        "txs": ordered,
    }
    SNAPSHOT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {SNAPSHOT} ({len(ordered)} txs, asOf {out['asOf']}, api {_active_api})")


if __name__ == "__main__":
    main()
