# Liquid on-chain group chat

A static page that reconstructs the public Bitcoin conversation after the September 2026 Liquid Network drain. It only shows messages that can be attributed on-chain:

- spent from the address that still holds the remaining coins, or
- spent from Blockstream’s first contact address, or
- PGP-signed with [Blockstream’s published security key](https://blockstream.com/pgp.txt)

Unrelated dust, memecoins, and impersonation OP_RETURNs sent *to* the holder are ignored.

Live site: https://realjuangalt.github.io/liquid-group-chat/

By [Juan Galt](https://juangalt.com). Source: [github.com/realjuangalt/liquid-group-chat](https://github.com/realjuangalt/liquid-group-chat).

## Snapshot-first (no history crawl)

`snapshot.json` is a baked copy of the known conversation. First paint loads that file plus local `pgp.txt`. Explorers are only asked for **newer** transactions:

- paginate address history until a known snapshot txid
- mempool REST + `wss://mempool.space/api/v1/ws`

If mempool.space / blockstream.info 429 or time out, the baked chat still shows.

To refresh the baked set later:

```bash
python3 scripts/update-snapshot.py
```

Then commit the updated `snapshot.json`.

## Host on GitHub Pages (free)

Static files only. No build, no server, no API keys.

Ship at repo root: `index.html`, `styles.css`, `app.js`, `snapshot.json`, `pgp.txt`, `.nojekyll`.

Repo **Settings → Pages → Build and deployment**:

- Source: **Deploy from a branch**
- Branch: `main`, folder `/ (root)`

## Local preview

```bash
python3 -m http.server 8080
```

Open http://127.0.0.1:8080

## Sources

- [Sjors’ verified gist](https://gist.github.com/Sjors/9d24363e67529079cc2ae4305ff90fcd)
- [Alex Thorn’s thread](https://x.com/intangiblecoins/status/2096996503298486649) (Galaxy Research)
- Holder: [bc1ql4mfu…qjlte](https://mempool.space/address/bc1ql4mfu6aundtkksxklfajs2h3t9nzcd6gyqjlte)
- Federation peg: [bc1qdlld6…uhwxxr](https://mempool.space/address/bc1qdlld6antmv4xug242ed83q7k4rqw50cwfns38szx4qu2f4jwaxxsuhwxxr)
