(() => {
  const HOLDER = "bc1ql4mfu6aundtkksxklfajs2h3t9nzcd6gyqjlte";
  const CONTACT = "bc1qn8mgsmxx42j3fflqfkh0cqhdd6mj4h9q2mfqym";
  const FEDERATION = "bc1qdlld6antmv4xug242ed83q7k4rqw50cwfns38szx4qu2f4jwaxxsuhwxxr";
  const EXPECTED_FPR = "1176542DA98E71E133722EF74AC8CC886844A2D6";
  const MIN_HEIGHT = 965783;
  const DUST_CARRIER = 10000;
  const LARGE_SATS = 100000000; // 1 BTC
  const APIS = [
    "https://mempool.space/api",
    "https://blockstream.info/api",
  ];
  const WS_URL = "wss://mempool.space/api/v1/ws";
  const EXPLORER = "https://mempool.space";

  const BOOTSTRAP_TXIDS = [
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
  ];

  const state = {
    api: APIS[0],
    key: null,
    txs: new Map(),
    holderInfo: null,
    prices: null,
    tip: null,
    lastRefresh: 0,
    watched: new Set([HOLDER, CONTACT]),
    ws: null,
    wsOpen: false,
    threadFp: "",
    itemCount: 0,
    snapshotTxids: new Set(),
    snapshotAsOf: "",
  };

  let work = Promise.resolve();
  function enqueue(fn) {
    work = work.then(fn).catch((err) => {
      console.warn(err);
      setLive("error", funnyLive("error") + " " + (err.message || err));
    });
    return work;
  }

  function setLive(mode, text) {
    const dot = document.getElementById("live-dot");
    const label = document.getElementById("live-label");
    dot.dataset.state = mode;
    label.textContent = text;
  }

  function funnyLive(mode, n) {
    const watches = state.watched.size;
    if (mode === "poll") return "checking the mempool…";
    if (mode === "error") return "mempool hung up. retrying.";
    const nTexts = n == null ? state.itemCount : n;
    const wire = state.wsOpen ? "websocket" : "rest";
    return `${wire} · ${nTexts} texts · ${watches} addrs`;
  }

  function satToBtc(sats) {
    return (Number(sats) / 1e8).toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8,
    });
  }

  function usd(sats) {
    const px = state.prices && state.prices.USD;
    if (!px) return "";
    const n = (Number(sats) / 1e8) * px;
    return " · " + n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  }

  function shortTx(id) {
    return id.slice(0, 8) + "…" + id.slice(-6);
  }

  function shortAddr(a) {
    if (!a) return "";
    return a.slice(0, 10) + "…" + a.slice(-6);
  }

  function fmtTime(unix) {
    if (!unix) return "unconfirmed";
    return new Date(unix * 1000).toLocaleString("en-GB", {
      timeZone: "UTC",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }) + " UTC";
  }

  function fmtClock(unix) {
    if (!unix) return "mempool";
    return new Date(unix * 1000).toLocaleString("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function fmtDay(unix) {
    if (!unix) return "not mined yet";
    return new Date(unix * 1000).toLocaleString("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function parseOpReturn(scriptHex) {
    if (!scriptHex) return null;
    const script = Uint8Array.from(scriptHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    if (!script.length || script[0] !== 0x6a) return null;
    if (script.length === 1) return "";
    const op = script[1];
    let size = 0;
    let offset = 2;
    if (op <= 75) {
      size = op;
    } else if (op === 0x4c) {
      size = script[2];
      offset = 3;
    } else if (op === 0x4d) {
      size = script[2] | (script[3] << 8);
      offset = 4;
    } else if (op === 0x4e) {
      size = script[2] | (script[3] << 8) | (script[4] << 16) | (script[5] << 24);
      offset = 6;
    } else {
      return null;
    }
    const data = script.slice(offset, offset + size);
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }

  function payloadOf(tx) {
    const outs = (tx.vout || []).filter((v) => v.scriptpubkey_type === "op_return");
    if (outs.length !== 1) return null;
    try {
      return parseOpReturn(outs[0].scriptpubkey);
    } catch {
      return null;
    }
  }

  function inputAddrs(tx) {
    const set = new Set();
    for (const vin of tx.vin || []) {
      const a = vin.prevout && vin.prevout.scriptpubkey_address;
      if (a) set.add(a);
    }
    return set;
  }

  function paidTo(tx, address) {
    return (tx.vout || [])
      .filter((v) => v.scriptpubkey_address === address)
      .reduce((s, v) => s + Number(v.value || 0), 0);
  }

  function splitMessage(payload) {
    if (!payload) return { text: "", encrypted: null, kind: "none" };
    if (payload.includes("-----BEGIN PGP SIGNED MESSAGE-----")) {
      const m = payload.match(/\r?\n\r?\n([\s\S]+?)\r?\n-----BEGIN PGP SIGNATURE/);
      const text = (m ? m[1] : payload).trim();
      if (text.includes("QklFMQ")) {
        const prefix = text.split("QklFMQ")[0].trim();
        return {
          text:
            prefix ||
            "Electrum BIE1 ciphertext encrypted to the holder, clearsigned by Blockstream.",
          encrypted: payload,
          kind: prefix ? "clearsign" : "clearsign-ecies",
        };
      }
      return { text, encrypted: payload, kind: "clearsign" };
    }
    if (payload.includes("(Electrum BIE1 ECIES)")) {
      const head = payload.split("(Electrum BIE1 ECIES)")[0].trim();
      return {
        text: head || "Electrum BIE1 message encrypted to the holder key.",
        encrypted: payload,
        kind: "ecies",
      };
    }
    if (payload.includes("-----BEGIN PGP MESSAGE-----")) {
      const head = payload.split("-----BEGIN PGP MESSAGE-----")[0].trim();
      return {
        text: head || "PGP message encrypted to Blockstream’s security key.",
        encrypted: payload,
        kind: "pgp-message",
      };
    }
    return { text: payload.trim(), encrypted: null, kind: "plain" };
  }

  const SKIP_MS = {
    timeout: 45000,
    429: 20000,
  };
  const apiSkipUntil = Object.fromEntries(APIS.map((base) => [base, 0]));

  async function pickApi() {
    const probes = await Promise.all(
      APIS.map(async (base) => {
        const t0 = Date.now();
        try {
          const res = await fetch(base + "/blocks/tip/height", {
            cache: "no-store",
            signal: AbortSignal.timeout(2500),
          });
          if (!res.ok) throw new Error(String(res.status));
          const height = await res.json();
          return { base, ms: Date.now() - t0, height };
        } catch (err) {
          apiSkipUntil[base] = Date.now() + SKIP_MS.timeout;
          return { base, err: String(err.message || err) };
        }
      })
    );
    const ok = probes.filter((p) => p.height).sort((a, b) => a.ms - b.ms);
    if (ok[0]) {
      state.api = ok[0].base;
      if (ok[0].height) state.tip = ok[0].height;
    }
    return probes;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function getJson(path) {
    const now = Date.now();
    const bases = [];
    for (const base of [state.api, ...APIS.filter((item) => item !== state.api)]) {
      if (now >= (apiSkipUntil[base] || 0)) bases.push(base);
    }
    if (!bases.length) bases.push(...APIS);
    let lastErr;
    for (const base of bases) {
      const timeout = base.includes("mempool.space") ? 4000 : 8000;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(base + path, {
            cache: "no-store",
            signal: AbortSignal.timeout(timeout),
          });
          if (res.status === 429) {
            lastErr = new Error(base + " 429");
            await sleep(700 * (attempt + 1));
            continue;
          }
          if (!res.ok) throw new Error(base + " " + res.status);
          state.api = base;
          return await res.json();
        } catch (err) {
          lastErr = err;
          const msg = String((err && err.message) || err);
          if (/timeout|AbortError|Failed to fetch/i.test(msg)) {
            apiSkipUntil[base] = Date.now() + SKIP_MS.timeout;
            break;
          }
          break;
        }
      }
    }
    throw lastErr;
  }

  async function mapPool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(
      Array.from({ length: n }, async () => {
        while (i < items.length) {
          const idx = i++;
          out[idx] = await fn(items[idx], idx);
        }
      })
    );
    return out;
  }

  async function fetchAddressTxs(address, { untilKnown = true } = {}) {
    const all = [];
    const seen = new Set();
    let path = `/address/${address}/txs`;
    for (let i = 0; i < 24; i++) {
      const page = await getJson(path);
      if (!page || !page.length) break;
      let added = 0;
      let hitKnown = false;
      for (const tx of page) {
        if (!tx || !tx.txid || seen.has(tx.txid)) continue;
        seen.add(tx.txid);
        if (untilKnown && state.snapshotTxids.has(tx.txid)) {
          hitKnown = true;
          continue;
        }
        all.push(tx);
        added++;
      }
      if (hitKnown) break;
      const confirmed = page.filter((t) => t.status && t.status.confirmed);
      if (!confirmed.length) break;
      const last = confirmed[confirmed.length - 1];
      const height = last.status.block_height || 0;
      if (height < MIN_HEIGHT) break;
      if (!added) break;
      path = `/address/${address}/txs/chain/${last.txid}`;
    }
    return all;
  }

  async function fetchMempoolTxs(address) {
    try {
      const page = await getJson(`/address/${address}/txs/mempool`);
      return Array.isArray(page) ? page : [];
    } catch {
      return [];
    }
  }

  async function fetchRecentTxs(address) {
    try {
      const page = await getJson(`/address/${address}/txs`);
      return Array.isArray(page) ? page : [];
    } catch {
      return [];
    }
  }

  function considerWatch(address) {
    if (!address || address === HOLDER || address === FEDERATION) return false;
    if (state.watched.has(address)) return false;
    if (state.watched.size >= 40) return false;
    state.watched.add(address);
    return true;
  }

  function harvestWatchlist(tx, party) {
    if (party !== "blockstream") return false;
    let added = false;
    for (const vin of tx.vin || []) {
      if (considerWatch(vin.prevout && vin.prevout.scriptpubkey_address)) added = true;
    }
    for (const v of tx.vout || []) {
      if (considerWatch(v.scriptpubkey_address)) added = true;
    }
    return added;
  }

  function watchedForPoll() {
    const extras = [...state.watched].filter((a) => a !== HOLDER && a !== CONTACT);
    return [HOLDER, CONTACT, ...extras.slice(-12)];
  }

  function txsFromWs(msg) {
    const out = [];
    if (Array.isArray(msg["address-transactions"])) out.push(...msg["address-transactions"]);
    if (Array.isArray(msg["block-transactions"])) out.push(...msg["block-transactions"]);
    let multi = msg["multi-address-transactions"];
    if (typeof multi === "string") {
      try {
        multi = JSON.parse(multi);
      } catch {
        multi = null;
      }
    }
    if (multi && typeof multi === "object") {
      for (const rec of Object.values(multi)) {
        if (!rec) continue;
        if (Array.isArray(rec.mempool)) out.push(...rec.mempool);
        if (Array.isArray(rec.confirmed)) out.push(...rec.confirmed);
      }
    }
    return out.filter((t) => t && t.txid);
  }

  function sendWatches(ws) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ action: "want", data: ["blocks"] }));
    ws.send(JSON.stringify({ "track-address": HOLDER }));
    const addrs = watchedForPoll();
    ws.send(JSON.stringify({ "track-addresses": addrs }));
  }

  async function loadKey() {
    const sources = ["./pgp.txt", "https://blockstream.com/pgp.txt"];
    let armored = null;
    for (const url of sources) {
      try {
        const res = await fetch(url, { cache: "force-cache", signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          armored = await res.text();
          if (armored.includes("BEGIN PGP PUBLIC KEY")) break;
        }
      } catch {
        /* try next */
      }
    }
    if (!armored || !window.openpgp) return null;
    const key = await openpgp.readKey({ armoredKey: armored });
    const fpr = key.getFingerprint().toUpperCase();
    if (fpr !== EXPECTED_FPR) {
      console.warn("unexpected PGP fingerprint", fpr);
      return null;
    }
    return key;
  }

  async function loadSnapshot() {
    try {
      const res = await fetch("./snapshot.json", {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error("snapshot " + res.status);
      const data = await res.json();
      const txs = Array.isArray(data.txs) ? data.txs : [];
      state.snapshotTxids = new Set(txs.map((t) => t && t.txid).filter(Boolean));
      state.snapshotAsOf = data.asOf || "";
      await ingestAndRender(txs, { skipBlockPositions: true });
      return txs.length > 0;
    } catch (err) {
      console.warn("snapshot failed", err);
      state.snapshotTxids = new Set();
      return false;
    }
  }

  function normalizeArmor(block) {
    return block.replace(/\r\n/g, "\n").trim() + "\n";
  }

  async function verifyPayload(payload) {
    if (!payload || !state.key || !window.openpgp) return null;
    try {
      if (payload.includes("-----BEGIN PGP SIGNED MESSAGE-----")) {
        const message = await openpgp.readCleartextMessage({
          cleartextMessage: normalizeArmor(payload),
        });
        const result = await openpgp.verify({
          message,
          verificationKeys: state.key,
        });
        const sig = result.signatures[0];
        const valid = sig ? await sig.verified : false;
        return { valid, kind: "clearsign" };
      }
      if (payload.includes("Detached signature") && payload.includes("BEGIN PGP SIGNATURE")) {
        const body = payload.match(/\(Electrum BIE1 ECIES\):\s*\n+([A-Za-z0-9+/=\s]+)\n+Detached signature/);
        const sig = payload.match(/-----BEGIN PGP SIGNATURE-----[\s\S]+?-----END PGP SIGNATURE-----/);
        if (!body || !sig) return { valid: false, kind: "detached" };
        const ciphertext = body[1].replace(/\s+/g, "");
        const candidates = [ciphertext, ciphertext + "\n", body[1].trim(), body[1].trim() + "\n"];
        const signature = await openpgp.readSignature({ armoredSignature: normalizeArmor(sig[0]) });
        for (const candidate of candidates) {
          try {
            const message = await openpgp.createMessage({ text: candidate });
            const result = await openpgp.verify({
              message,
              signature,
              verificationKeys: state.key,
            });
            if (result.signatures[0] && (await result.signatures[0].verified)) {
              return { valid: true, kind: "detached" };
            }
          } catch {
            /* try next encoding */
          }
        }
        return { valid: false, kind: "detached" };
      }
    } catch (err) {
      return { valid: false, error: String(err.message || err) };
    }
    return null;
  }

  async function classify(tx) {
    const senders = inputAddrs(tx);
    const fromHolder = senders.has(HOLDER);
    const fromContact = senders.has(CONTACT);
    const payload = payloadOf(tx);
    const fed = paidTo(tx, FEDERATION);
    const pgp = payload ? await verifyPayload(payload) : null;
    const height = tx.status && tx.status.block_height;
    if (height && height < MIN_HEIGHT) return null;

    if (fromHolder && fed >= LARGE_SATS) {
      return { party: "holder", role: "funds", payload, pgp, fed };
    }
    if (fromHolder && payload) {
      return { party: "holder", role: "message", payload, pgp, fed };
    }
    if (fromContact && payload) {
      return { party: "blockstream", role: "message", payload, pgp, fed };
    }
    if (pgp && pgp.valid && payload) {
      return { party: "blockstream", role: "message", payload, pgp, fed };
    }
    if (tx.txid === BOOTSTRAP_TXIDS[0]) {
      return { party: "federation", role: "funds", payload: null, pgp: null, fed: 0 };
    }
    return null;
  }

  function eventSortKey(tx) {
    const s = tx.status || {};
    if (!s.confirmed) return [1e12, 0];
    return [s.block_height || 0, s.block_time || 0];
  }

  const blockTxids = new Map();

  async function attachBlockPositions(items) {
    const byHash = new Map();
    for (const item of items) {
      const hash = item.tx.status && item.tx.status.block_hash;
      if (!hash) continue;
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(item);
    }
    const need = [...byHash.entries()]
      .filter(([hash, list]) => list.length > 1 && !blockTxids.has(hash))
      .map(([hash]) => hash);
    for (const hash of need) {
      try {
        blockTxids.set(hash, await getJson(`/block/${hash}/txids`));
      } catch {
        /* order falls back to arrival */
      }
    }
    for (const item of items) {
      const hash = item.tx.status && item.tx.status.block_hash;
      const ids = hash && blockTxids.get(hash);
      item.pos = ids ? Math.max(0, ids.indexOf(item.txid)) : 0;
    }
  }

  function linkify(text) {
    const esc = String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return esc
      .replace(/https:\/\/[^\s<]+/g, (m) => {
        const trail = (m.match(/[).,;:]+$/) || [""])[0];
        const url = trail ? m.slice(0, -trail.length) : m;
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
      })
      .replace(
        /\b(bc1[a-z0-9]{20,})\b/g,
        (m) =>
          `<a href="${EXPLORER}/address/${m}" target="_blank" rel="noopener noreferrer">${shortAddr(m)}</a>`
      )
      .replace(
        /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
        '<a href="mailto:$1">$1</a>'
      );
  }

  function ticks(confirmed) {
    return confirmed
      ? '<span class="ticks" title="mined">✓✓</span>'
      : '<span title="in the mempool, sweating">✓</span>';
  }

  function renderCard(item, prev) {
    const tx = item.tx;
    const confirmed = !!(tx.status && tx.status.confirmed);
    const split = splitMessage(item.payload);
    const isFunds = item.role === "funds";
    const party = isFunds && item.party === "federation" ? "federation" : item.party;
    const height = confirmed ? tx.status.block_height : null;
    const clock = fmtClock(tx.status && tx.status.block_time);
    const day = fmtDay(tx.status && tx.status.block_time);
    const prevDay = prev ? fmtDay(prev.tx.status && prev.tx.status.block_time) : "";
    const dayChip = day !== prevDay ? `<li class="sys"><span class="day">${day}</span></li>` : "";

    const sameSide =
      prev &&
      prev.party === item.party &&
      prev.role === item.role &&
      !isFunds &&
      item.role !== "funds" &&
      prev.party !== "federation";

    const pgpBit = item.pgp && item.pgp.valid ? "pgp ✓" : "";
    const blockLink = height
      ? `<a href="${EXPLORER}/block/${height}" target="_blank" rel="noopener noreferrer">blk ${height.toLocaleString("en-US")}</a>`
      : "unconfirmed";
    const txLink = `<a href="${EXPLORER}/tx/${tx.txid}" target="_blank" rel="noopener noreferrer">${shortTx(tx.txid)}</a>`;
    const cipher = split.encrypted
      ? `<details class="cipher"><summary>peek at the ciphertext anyway</summary><pre>${linkify(split.encrypted)}</pre></details>`
      : "";

    if (item.party === "federation" || (isFunds && item.txid === BOOTSTRAP_TXIDS[0])) {
      const out = Math.max(...(tx.vout || []).map((v) => Number(v.value || 0)));
      return `${dayChip}<li class="sys">
        <div class="pay">
          <div class="amt">${satToBtc(out)} BTC</div>
          <div class="sub">left the peg. group chat just got interesting.</div>
          <div class="meta-row">${txLink} · ${blockLink}</div>
        </div>
      </li>`;
    }

    if (isFunds && item.party === "holder") {
      return `${dayChip}<li class="sys">
        <div class="pay">
          <div class="amt">${satToBtc(item.fed)} BTC</div>
          <div class="sub">whitehats tapped you back${usd(item.fed)} · kept the rest as a souvenir</div>
          <div class="meta-row">${txLink} · ${blockLink}</div>
        </div>
      </li>`;
    }

    const isLock = split.kind !== "plain" && split.kind !== "clearsign";
    let inner;
    if (isLock) {
      inner = `<p class="msg lock">🔒 sealed to the other guy’s key
        <small>${linkify(split.text)} · not even this website can read it</small></p>${cipher}`;
    } else {
      inner = `<p class="msg">${linkify(split.text)}</p>${cipher}`;
    }

    const who = party === "holder" ? "whitehats" : "blockstream";
    const face = party === "holder" ? "🎩" : "💧";
    const showName = !sameSide;
    const carrier =
      item.fed && item.fed > 0 && item.fed < DUST_CARRIER
        ? ` · ${item.fed.toLocaleString("en-US")} sat poke`
        : "";

    return `${dayChip}<li class="${party}${sameSide ? " tight" : ""}">
      <span class="face ${sameSide ? "ghost" : ""}" aria-hidden="true">${face}</span>
      <article class="bubble ${party}${confirmed ? "" : " unconfirmed"}">
        ${showName ? `<span class="name">${who}</span>` : ""}
        ${inner}
        <div class="meta-row">
          <span>${clock} UTC</span>
          ${ticks(confirmed)}
          <span>${blockLink}${carrier}</span>
          ${pgpBit ? `<span>${pgpBit}</span>` : ""}
          ${txLink}
        </div>
      </article>
    </li>`;
  }

  function render(items) {
    const messages = items.filter((i) => i.role === "message" || (i.role === "funds" && i.party === "holder") || i.party === "federation");
    messages.sort((a, b) => {
      const [ha] = eventSortKey(a.tx);
      const [hb] = eventSortKey(b.tx);
      const ua = a.tx.status && a.tx.status.confirmed ? 0 : 1;
      const ub = b.tx.status && b.tx.status.confirmed ? 0 : 1;
      return ua - ub || ha - hb || (a.pos || 0) - (b.pos || 0);
    });

    const fp = messages
      .map((i) => {
        const s = i.tx.status || {};
        return i.txid + ":" + (s.confirmed ? s.block_height : "mem");
      })
      .join(",");
    const thread = document.getElementById("thread");
    const empty = document.getElementById("thread-empty");
    if (fp !== state.threadFp) {
      state.threadFp = fp;
      if (!messages.length) {
        thread.innerHTML = "";
        empty.hidden = false;
      } else {
        empty.hidden = true;
        thread.innerHTML = messages.map((item, i) => renderCard(item, messages[i - 1])).join("");
      }
    }

    const holder = state.holderInfo;
    const held = holder
      ? holder.chain_stats.funded_txo_sum - holder.chain_stats.spent_txo_sum +
        holder.mempool_stats.funded_txo_sum - holder.mempool_stats.spent_txo_sum
      : 59849963206;
    document.getElementById("stat-held").textContent = satToBtc(held) + " BTC";
    document.getElementById("stat-held-note").textContent =
      "live from " + shortAddr(HOLDER) + usd(held) + " · the awkward 15%";

    const returned = items
      .filter((i) => i.party === "holder" && i.role === "funds")
      .reduce((s, i) => s + i.fed, 0);
    if (returned) {
      document.getElementById("stat-returned").textContent = satToBtc(returned) + " BTC";
      const pct = held + returned ? Math.round((returned / (returned + held)) * 1000) / 10 : 85;
      document.getElementById("stat-returned-note").textContent =
        `${pct}% of the pile · “most” means this` + usd(returned);
    }

    const last = messages[messages.length - 1];
    if (last) {
      const s = last.tx.status || {};
      document.getElementById("stat-last").textContent = s.block_height
        ? String(s.block_height)
        : "mempool";
      document.getElementById("stat-last-note").textContent =
        (last.party === "holder" ? "whitehats" : last.party) + " · " + fmtTime(s.block_time);
    }

    if (state.tip) {
      document.getElementById("stat-tip").textContent = String(state.tip);
      const px = state.prices && state.prices.USD;
        document.getElementById("stat-tip-note").textContent = px
        ? `BTC ${px.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} · still typing`
        : "miners are the typing indicator";
    }

    const flows = messages.filter((i) => i.role === "funds" || i.party === "federation");
    document.getElementById("flow-list").innerHTML = flows
      .map((i) => {
        const s = i.tx.status || {};
        const label =
          i.party === "federation"
            ? "the peg got emptied into the group chat"
            : `whitehats venmo’d back ${satToBtc(i.fed)} BTC`;
        return `<li>
          <time>${fmtTime(s.block_time)}</time>
          <div>${label}<br><a href="${EXPLORER}/tx/${i.tx.txid}" target="_blank" rel="noopener noreferrer">${i.tx.txid}</a></div>
        </li>`;
      })
      .join("");
  }

  async function ingestAndRender(txList, { skipBlockPositions = false } = {}) {
    const merged = new Map(state.txs);
    for (const tx of txList) {
      if (tx && tx.txid) merged.set(tx.txid, tx);
    }
    state.txs = merged;
    const items = [];
    let watchesGrew = false;
    for (const tx of merged.values()) {
      const classified = await classify(tx);
      if (!classified) continue;
      items.push({ ...classified, tx, txid: tx.txid });
      if (harvestWatchlist(tx, classified.party)) watchesGrew = true;
    }
    if (skipBlockPositions) {
      for (const item of items) item.pos = item.pos || 0;
    } else {
      await attachBlockPositions(items);
    }
    state.itemCount = items.filter(
      (i) => i.role === "message" || (i.role === "funds" && i.party === "holder") || i.party === "federation"
    ).length;
    render(items);
    state.lastRefresh = Date.now();
    setLive("live", funnyLive("live", state.itemCount));
    if (watchesGrew) sendWatches(state.ws);
    return items;
  }

  async function refresh({ full = false, silent = false } = {}) {
    if (!silent) setLive("poll", funnyLive("poll"));
    try {
      const meta = [
        getJson("/v1/prices").catch(() => null),
        getJson("/blocks/tip/height").catch(() => state.tip),
        getJson(`/address/${HOLDER}`).catch(() => null),
      ];
      const [prices, tip, holderInfo] = await Promise.all(meta);
      if (prices && prices.USD) state.prices = prices;
      if (tip) state.tip = tip;
      if (holderInfo) state.holderInfo = holderInfo;

      if (full && !state.snapshotTxids.size) {
        const [firstHolder, firstContact] = await Promise.all([
          fetchRecentTxs(HOLDER),
          fetchRecentTxs(CONTACT),
        ]);
        await ingestAndRender(firstHolder.concat(firstContact));

        const missing = BOOTSTRAP_TXIDS.filter((id) => !state.txs.has(id));
        for (const id of missing) {
          const tx = await getJson(`/tx/${id}`).catch(() => null);
          if (tx) await ingestAndRender([tx]);
        }

        const [holderTxs, contactTxs] = await Promise.all([
          fetchAddressTxs(HOLDER, { untilKnown: false }).catch(() => []),
          fetchAddressTxs(CONTACT, { untilKnown: false }).catch(() => []),
        ]);
        await ingestAndRender(holderTxs.concat(contactTxs));
      } else if (full) {
        const addrs = [HOLDER, CONTACT];
        const pages = await mapPool(addrs, 2, (addr) =>
          fetchAddressTxs(addr).catch(() => fetchRecentTxs(addr).catch(() => []))
        );
        const extras = watchedForPoll().filter((a) => a !== HOLDER && a !== CONTACT);
        const mem = extras.length
          ? await mapPool(extras, 3, (addr) => fetchMempoolTxs(addr))
          : [];
        await ingestAndRender(pages.flat().concat(mem.flat()));
      } else {
        const addrs = watchedForPoll();
        const pages = await mapPool(addrs, 3, (addr) =>
          addr === HOLDER || addr === CONTACT ? fetchRecentTxs(addr) : fetchMempoolTxs(addr)
        );
        const incoming = pages.flat();
        const unconfirmed = [...state.txs.values()]
          .filter((tx) => !(tx.status && tx.status.confirmed))
          .map((tx) => tx.txid)
          .slice(0, 8);
        if (unconfirmed.length) {
          const fresh = await mapPool(unconfirmed, 3, (id) => getJson(`/tx/${id}`).catch(() => null));
          incoming.push(...fresh.filter(Boolean));
        }
        await ingestAndRender(incoming);
      }
    } catch (err) {
      setLive("error", funnyLive("error") + " " + (err.message || err));
    }
  }

  function connectWs() {
    const open = () => {
      const ws = new WebSocket(WS_URL);
      state.ws = ws;
      ws.onopen = () => {
        state.wsOpen = true;
        sendWatches(ws);
        setLive("live", funnyLive("live"));
      };
      let blockTimer = null;
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg["track-addresses-error"]) {
          console.warn(msg["track-addresses-error"]);
        }
        if (msg.block && msg.block.height) {
          state.tip = msg.block.height;
        }
        const fresh = txsFromWs(msg);
        if (fresh.length) {
          enqueue(() => ingestAndRender(fresh));
        }
        if (msg.block) {
          clearTimeout(blockTimer);
          blockTimer = setTimeout(() => enqueue(() => refresh({ silent: true })), 900);
        }
      };
      ws.onclose = () => {
        state.wsOpen = false;
        setTimeout(open, 5000);
      };
      ws.onerror = () => ws.close();
    };
    open();
  }

  async function start() {
    setLive("poll", "opening the baked transcript…");
    try {
      state.key = await loadKey();
    } catch (err) {
      console.warn(err);
    }
    const baked = await loadSnapshot();
    if (baked) setLive("live", funnyLive("live", state.itemCount));
    pickApi().catch(() => {});
    connectWs();
    await enqueue(() => refresh({ full: true, silent: baked }));
    setInterval(() => enqueue(() => refresh({ silent: true })), 20000);
  }

  start();
})();
