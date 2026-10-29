// STRIKE API shared code. Leading underscore: Vercel does not expose this file as a route.

// ==== STRIKE RULES BEGIN ====
// Shared, pure round rules. This block is byte-identical in engine/rules.mjs and site/api/_lib.js.
// Edit one, copy to the other (rules.test.mjs fails if they drift).

export const MIN_STAKE = 10_000_000n; // 0.01 SOL in lamports
export const MAX_STAKE = 5_000_000_000n; // 5 SOL
export const ROUND_SEC = 3600;
export const BET_CLOSE_SEC = 50 * 60; // bets close at :50
export const SETTLE_DELAY_SEC = 180; // settle 3 min after the hour ends
export const FEE_BPS = 100n; // 1% of a settled C/P pot
export const BUYBACK_MIN = 50_000_000n; // 0.05 SOL
export const MAX_RECIPIENTS_PER_TX = 12;
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_PROGRAM_LEGACY = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
export const MEMO_PROGRAMS = new Set([MEMO_PROGRAM, MEMO_PROGRAM_LEGACY]);
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET.charCodeAt(i)] = i;
  return m;
})();
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function base58Decode(str) {
  if (typeof str !== 'string') return null;
  if (str.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = []; // little-endian accumulator
  for (let i = zeros; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? B58_MAP[c] : -1;
    if (v < 0) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = []; // little-endian base58 digits
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let s = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) s += B58_ALPHABET[digits[i]];
  return s;
}

export function isAddress(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44 || !B58_RE.test(s)) return false;
  const b = base58Decode(s);
  return b !== null && b.length === 32;
}

export function hourStartOf(unixSec) {
  return Math.floor(unixSec / ROUND_SEC) * ROUND_SEC;
}

export function roundTimes(hourStart) {
  return { hourStart, closeAt: hourStart + BET_CLOSE_SEC, expiry: hourStart + ROUND_SEC };
}

export function lamportsToSol(l) {
  const v = BigInt(l);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const n = Number(a / 1_000_000_000n) + Number(a % 1_000_000_000n) / 1e9;
  return neg ? -n : n;
}

function toLamports(x) {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number' && Number.isSafeInteger(x)) return BigInt(x);
  if (typeof x === 'string' && /^\d+$/.test(x)) return BigInt(x);
  return 0n;
}

export function decodeMemoData(data) {
  const raw = base58Decode(data);
  if (raw === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

// All memo texts in a Helius enhanced tx (top-level and inner instructions).
export function extractMemos(tx) {
  const out = [];
  const visit = (ix) => {
    if (!ix || typeof ix !== 'object') return;
    if (MEMO_PROGRAMS.has(ix.programId) && typeof ix.data === 'string') {
      const t = decodeMemoData(ix.data);
      if (t !== null) out.push(t);
    }
    if (Array.isArray(ix.innerInstructions)) ix.innerInstructions.forEach(visit);
  };
  if (Array.isArray(tx?.instructions)) tx.instructions.forEach(visit);
  return out;
}

export function parseBetMemo(text) {
  const m = /^STRIKE:([1-9A-HJ-NP-Za-km-z]{32,44}):([CP])$/.exec(text);
  if (!m || !isAddress(m[1])) return null;
  return { mint: m[1], side: m[2] };
}

export function payMemo(hourStart, mint, result) {
  return `STRIKE:PAY:${hourStart}:${mint}:${result}`;
}
export function refundMemo(betSig) {
  return `STRIKE:REFUND:${betSig.slice(0, 16)}`;
}
export function buyMemo(lamports) {
  return `STRIKE:BUY:${BigInt(lamports)}`;
}
export function burnMemo(amountRaw) {
  return `STRIKE:BURN:${BigInt(amountRaw)}`;
}

// Memos the engine writes on its own (pool-signed) txs.
export function parseTagMemo(text) {
  let m;
  if ((m = /^STRIKE:PAY:(\d{1,12}):([1-9A-HJ-NP-Za-km-z]{32,44}):([CPR])$/.exec(text))) {
    const hourStart = Number(m[1]);
    if (hourStart % ROUND_SEC !== 0 || !isAddress(m[2])) return null;
    return { kind: 'pay', hourStart, mint: m[2], result: m[3] };
  }
  if ((m = /^STRIKE:REFUND:([1-9A-HJ-NP-Za-km-z]{16})$/.exec(text))) return { kind: 'refund', ref: m[1] };
  if ((m = /^STRIKE:BUY:(\d{1,20})$/.exec(text))) return { kind: 'buy', lamports: BigInt(m[1]) };
  if ((m = /^STRIKE:BURN:(\d{1,30})$/.exec(text))) return { kind: 'burn', amountRaw: BigInt(m[1]) };
  return null;
}

// Classify one Helius enhanced tx touching the pool.
// Returns null (failed/unusable) or a record with kind:
//   bet | invalid (refundable) | deposit (plain SOL, no STRIKE memo) | pay | refund | buy | burn | other
export function classifyPoolTx(tx, pool) {
  if (!tx || tx.transactionError || typeof tx.signature !== 'string' || !Number.isFinite(tx.timestamp)) return null;
  const memos = extractMemos(tx);
  const nt = Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [];
  const base = { sig: tx.signature, t: tx.timestamp, feePayer: tx.feePayer };

  if (tx.feePayer === pool) {
    const byWallet = new Map();
    for (const x of nt) {
      if (x && x.fromUserAccount === pool && x.toUserAccount && x.toUserAccount !== pool) {
        byWallet.set(x.toUserAccount, (byWallet.get(x.toUserAccount) || 0n) + toLamports(x.amount));
      }
    }
    const transfers = [...byWallet].map(([wallet, lamports]) => ({ wallet, lamports }));
    for (const text of memos) {
      const tag = parseTagMemo(text);
      if (tag) return { ...base, ...tag, memo: text, transfers };
    }
    return { ...base, kind: 'other' };
  }

  let stake = 0n;
  for (const x of nt) {
    if (x && x.fromUserAccount === tx.feePayer && x.toUserAccount === pool) stake += toLamports(x.amount);
  }
  if (stake <= 0n) return { ...base, kind: 'other' };

  const hourStart = hourStartOf(tx.timestamp);
  const strikeMemos = memos.filter((m) => m.trim().toUpperCase().startsWith('STRIKE'));
  if (strikeMemos.length === 0) return { ...base, kind: 'deposit', lamports: stake };
  const invalid = (reason) => ({ ...base, kind: 'invalid', wallet: tx.feePayer, lamports: stake, hourStart, reason });
  const bet = strikeMemos.length === 1 ? parseBetMemo(strikeMemos[0]) : null;
  if (!bet) return invalid('malformed memo');
  if (stake < MIN_STAKE) return invalid('stake below 0.01 SOL');
  if (stake > MAX_STAKE) return invalid('stake above 5 SOL');
  if (tx.timestamp - hourStart >= BET_CLOSE_SEC) return invalid('late (bets close at :50)');
  return { ...base, kind: 'bet', wallet: tx.feePayer, mint: bet.mint, side: bet.side, lamports: stake, hourStart };
}

export function roundKey(hourStart, mint) {
  return `${hourStart}:${mint}`;
}

// Group valid bets into rounds: Map key -> {hourStart, mint, bets[]}
export function groupRounds(records) {
  const rounds = new Map();
  for (const r of records) {
    if (!r || r.kind !== 'bet') continue;
    const k = roundKey(r.hourStart, r.mint);
    if (!rounds.has(k)) rounds.set(k, { hourStart: r.hourStart, mint: r.mint, bets: [] });
    rounds.get(k).bets.push(r);
  }
  return rounds;
}

export function roundTotals(bets) {
  let call = 0n;
  let put = 0n;
  for (const b of bets) {
    if (b.side === 'C') call += b.lamports;
    else if (b.side === 'P') put += b.lamports;
  }
  return { call, put, pot: call + put };
}

// Pick the price pair from a DexScreener token-pairs response.
export function selectPair(pairs, mint) {
  if (!Array.isArray(pairs)) return null;
  const own = pairs.filter((p) => p && p.baseToken && p.baseToken.address === mint && typeof p.pairAddress === 'string');
  const liq = (p) => {
    const v = Number(p.liquidity && p.liquidity.usd);
    return Number.isFinite(v) ? v : 0;
  };
  const best = (list) => list.reduce((a, b) => (a === null || liq(b) > liq(a) ? b : a), null);
  return best(own.filter((p) => p.dexId === 'raydium')) || best(own);
}

// The hour candle for hourStart from a GeckoTerminal ohlcv_list, or null.
export function candleFor(ohlcvList, hourStart) {
  if (!Array.isArray(ohlcvList)) return null;
  const row = ohlcvList.find((r) => Array.isArray(r) && Number(r[0]) === hourStart);
  if (!row) return null;
  const strike = Number(row[1]);
  const close = Number(row[4]);
  if (!Number.isFinite(strike) || !Number.isFinite(close)) return null;
  return { strike, close };
}

export function roundResult(candle, call, put) {
  if (call <= 0n || put <= 0n || !candle) return 'R';
  if (candle.close > candle.strike) return 'C';
  if (candle.close < candle.strike) return 'P';
  return 'R';
}

// Payouts for a round given its result. Stakes are aggregated per wallet.
// R: every wallet gets back all it staked (both sides). C/P: winners split pot*0.99 pro rata, floored.
export function computePayouts(bets, result) {
  const { call, put, pot } = roundTotals(bets);
  const byWallet = new Map();
  for (const b of bets) {
    const w = byWallet.get(b.wallet) || { C: 0n, P: 0n };
    w[b.side] += b.lamports;
    byWallet.set(b.wallet, w);
  }
  const wallets = [...byWallet.keys()].sort();
  const winTotal = result === 'C' ? call : result === 'P' ? put : 0n;
  const payouts = [];
  if ((result !== 'C' && result !== 'P') || winTotal === 0n) {
    for (const wallet of wallets) {
      const w = byWallet.get(wallet);
      const lamports = w.C + w.P;
      if (lamports > 0n) payouts.push({ wallet, lamports });
    }
    return { result: 'R', call, put, pot, payouts, fee: 0n };
  }
  let paid = 0n;
  for (const wallet of wallets) {
    const stake = byWallet.get(wallet)[result];
    if (stake <= 0n) continue;
    const lamports = (stake * pot * (10_000n - FEE_BPS)) / (winTotal * 10_000n);
    if (lamports > 0n) {
      payouts.push({ wallet, lamports });
      paid += lamports;
    }
  }
  return { result, call, put, pot, payouts, fee: pot - paid };
}

export function settleRound(bets, candle) {
  const { call, put } = roundTotals(bets);
  return computePayouts(bets, roundResult(candle, call, put));
}

// Earliest PAY result per round + lamports already paid per wallet, from pay records.
export function payState(records, hourStart, mint) {
  let result = null;
  let firstT = Infinity;
  const paid = new Map();
  for (const r of records) {
    if (!r || r.kind !== 'pay' || r.hourStart !== hourStart || r.mint !== mint) continue;
    if (r.t < firstT) {
      firstT = r.t;
      result = r.result;
    }
    for (const x of r.transfers || []) paid.set(x.wallet, (paid.get(x.wallet) || 0n) + x.lamports);
  }
  return { result, paid, firstPayT: result === null ? null : firstT };
}

// Unspent buyback fees from history. Walks events oldest first: each settled C/P round adds
// its fee at its first PAY time, each BUY subtracts its lamports, floored at 0 (a BUY can
// never be credited against fees we cannot see). Rounds whose bets may predate the loaded
// history (hourStart < coveredFrom) are skipped, so this can only undercount.
export function unspentFees(records, coveredFrom) {
  const rounds = groupRounds(records);
  const events = [];
  for (const round of rounds.values()) {
    if (round.hourStart < coveredFrom) continue;
    const st = payState(records, round.hourStart, round.mint);
    if (st.result !== 'C' && st.result !== 'P') continue;
    const { fee } = computePayouts(round.bets, st.result);
    if (fee > 0n) events.push({ t: st.firstPayT, d: fee });
  }
  for (const r of records) if (r && r.kind === 'buy') events.push({ t: r.t, d: -r.lamports });
  events.sort((a, b) => a.t - b.t || (a.d < b.d ? 1 : -1));
  let acc = 0n;
  for (const e of events) {
    acc += e.d;
    if (acc < 0n) acc = 0n;
  }
  return acc;
}
// ==== STRIKE RULES END ====

// ==== API HELPERS (Vercel functions only) ====

export const STONK_BASE = 'https://www.stonkfun.xyz';
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };
const HELIUS_TX_BASE = 'https://api-mainnet.helius-rpc.com/v0/addresses';
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export class UpstreamError extends Error {
  constructor(host, detail) {
    super(`${host}: ${detail}`);
    this.host = host;
    this.detail = detail;
  }
}

export const nowSec = () => Math.floor(Date.now() / 1000);

const scrub = (s) => String(s).replace(/api-key=[^&\s"']+/gi, 'api-key=***');

// ---- tiny TTL cache (module scope, survives warm invocations) ----
class TTLCache {
  constructor(max) {
    this.max = max;
    this.m = new Map();
  }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k, v, ttlMs) {
    if (!this.m.has(k) && this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(k, { v, exp: Date.now() + ttlMs });
    return v;
  }
}
const cache = new TTLCache(5000);
const inflight = new Map();
const FOREVER = Number.MAX_SAFE_INTEGER / 2;

async function cached(key, ttlFor, loader) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await loader();
      const ttl = ttlFor(v);
      if (ttl > 0) cache.set(key, v, ttl);
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function getJson(url, { method = 'GET', headers = {}, body, allow404 = false, timeoutMs = 8000 } = {}) {
  const host = new URL(url).host;
  let r;
  try {
    r = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new UpstreamError(host, e && e.name === 'TimeoutError' ? 'timeout' : 'network error');
  }
  if (allow404 && r.status === 404) return null;
  if (!r.ok) throw new UpstreamError(host, `status ${r.status}`);
  try {
    return await r.json();
  } catch {
    throw new UpstreamError(host, 'invalid json');
  }
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---- responses ----
export function send(res, status, body, sMaxAge) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', sMaxAge > 0 ? `s-maxage=${sMaxAge}, stale-while-revalidate=${2 * sMaxAge}` : 'no-store');
  res.end(JSON.stringify(body));
}

export function route(fn) {
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, { error: 'method not allowed' }, 0);
    }
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      await fn(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message }, 0);
      console.error(scrub(e && e.stack ? e.stack : e));
      if (e instanceof UpstreamError) return send(res, 502, { error: `upstream unavailable (${e.host})` }, 0);
      return send(res, 500, { error: 'internal error' }, 0);
    }
  };
}

export const logSoft = (what, e) => console.error(`${what}: ${scrub(e && e.message ? e.message : e)}`);

// ---- config ----
// null when POOL_WALLET is unset; throws 500 on a broken config.
export function poolConfig() {
  const address = (process.env.POOL_WALLET || '').trim();
  if (!address) return null;
  const key = (process.env.HELIUS_API_KEY || '').trim();
  if (!isAddress(address) || !key) throw new HttpError(500, 'server misconfigured');
  return { address, key };
}

// ---- StonkFun ----
export function absImage(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return STONK_BASE + u;
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

export function tokenView(t) {
  return {
    mint: t.mint,
    symbol: t.symbol ?? null,
    name: t.name ?? null,
    image: absImage(t.imageUrl),
    quote: (t.quote && t.quote.symbol) ?? null,
    mcap: num(t.market && t.market.marketCapUsd),
    vol24: num(t.market && t.market.volume24hUsd),
  };
}

export function getTopTokens() {
  return cached('stonk:top', () => 30_000, async () => {
    const j = await getJson(`${STONK_BASE}/api/public/v1/tokens?sort=volume&status=graduated&pageSize=12`);
    const list = j && j.data && Array.isArray(j.data.tokens) ? j.data.tokens : null;
    if (!list) throw new UpstreamError('www.stonkfun.xyz', 'unexpected shape');
    return list.filter((t) => t && isAddress(t.mint));
  });
}

// StonkFun token object, or null when the mint is not a StonkFun coin.
export function getStonkToken(mint) {
  return cached(`stonk:tok:${mint}`, (v) => (v ? 3_600_000 : 300_000), async () => {
    const j = await getJson(`${STONK_BASE}/api/public/v1/tokens/${mint}`, { allow404: true });
    const t = j && j.data && j.data.token;
    return t && typeof t === 'object' && t.mint === mint ? t : null;
  });
}

// ---- DexScreener ----
function getTokenPairs(mint) {
  return cached(`ds:${mint}`, () => 20_000, async () => {
    const j = await getJson(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`);
    return Array.isArray(j) ? j : [];
  });
}

// {pairAddress, priceUsd} with the pair choice pinned for 1 h, or null if no pair.
export async function getPair(mint) {
  const pairs = await getTokenPairs(mint);
  const pinned = cache.get(`pair:${mint}`);
  let p = pinned ? pairs.find((x) => x && x.pairAddress === pinned && x.baseToken && x.baseToken.address === mint) : null;
  if (!p) {
    p = selectPair(pairs, mint);
    if (p) cache.set(`pair:${mint}`, p.pairAddress, 3_600_000);
  }
  return p ? { pairAddress: p.pairAddress, priceUsd: num(p.priceUsd) } : null;
}

// ---- GeckoTerminal ----
// Hour candle {strike, close} for (pair, hourStart), null if none.
// Returns undefined (not fetched) when the per-request budget is spent.
export async function getHourCandle(pair, hourStart, budget) {
  const key = `gh:${pair}:${hourStart}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (budget) {
    if (budget.n <= 0) return undefined;
    budget.n--;
  }
  return cached(
    key,
    () => (nowSec() >= hourStart + ROUND_SEC + 300 ? FOREVER : 60_000),
    async () => {
      const url = `${GECKO_BASE}/${pair}/ohlcv/hour?aggregate=1&limit=3&currency=usd&before_timestamp=${hourStart + ROUND_SEC}`;
      const j = await getJson(url, { headers: GECKO_HEADERS, allow404: true });
      return candleFor(j && j.data && j.data.attributes && j.data.attributes.ohlcv_list, hourStart);
    },
  );
}

// Current-hour open (the strike). Cached for good once seen: it cannot change.
export async function getHourOpen(pair, hourStart, budget) {
  const key = `go:${pair}:${hourStart}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const c = await getHourCandle(pair, hourStart, budget);
  if (c) {
    cache.set(key, c.strike, FOREVER);
    return c.strike;
  }
  return c === undefined ? undefined : null;
}

// Minute candles of the given hour, oldest first, as [ts, o, h, l, c].
export async function getMinuteCandles(pair, hourStart) {
  const list = await cached(`gm:${pair}`, () => 15_000, async () => {
    const url = `${GECKO_BASE}/${pair}/ohlcv/minute?aggregate=1&limit=60&currency=usd`;
    const j = await getJson(url, { headers: GECKO_HEADERS, allow404: true });
    const l = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
    return Array.isArray(l) ? l : [];
  });
  return list
    .filter((r) => Array.isArray(r) && Number(r[0]) >= hourStart && Number(r[0]) < hourStart + ROUND_SEC)
    .map((r) => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])])
    .filter((r) => r.every(Number.isFinite))
    .sort((a, b) => a[0] - b[0]);
}

// ---- Helius ----
// Pool txs newest first, paging back until a tx older than `since` or maxPages (≤3).
// exhausted=true means the full history was read.
export function fetchPoolTxs(cfg, { since = 0, maxPages = 3 } = {}) {
  const pages = Math.min(3, Math.max(1, maxPages));
  return cached(`helius:${cfg.address}:${since}:${pages}`, () => 8_000, async () => {
    const txs = [];
    let before = null;
    let exhausted = false;
    for (let page = 0; page < pages; page++) {
      const q = new URLSearchParams({ 'api-key': cfg.key, limit: '100' });
      if (before) q.set('before', before);
      const url = `${HELIUS_TX_BASE}/${cfg.address}/transactions?${q}`;
      let r;
      try {
        r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
      } catch (e) {
        throw new UpstreamError('api-mainnet.helius-rpc.com', e && e.name === 'TimeoutError' ? 'timeout' : 'network error');
      }
      let j = null;
      try {
        j = await r.json();
      } catch {
        j = null;
      }
      if (!r.ok || !Array.isArray(j)) {
        // "Failed to find events within the search period... set to <sig>" → continue from there
        const msg = j && typeof j.error === 'string' ? j.error : '';
        const m = /set to ([1-9A-HJ-NP-Za-km-z]{64,90})/.exec(msg);
        if (m) {
          before = m[1];
          continue;
        }
        throw new UpstreamError('api-mainnet.helius-rpc.com', `status ${r.status}`);
      }
      if (j.length === 0) {
        exhausted = true;
        break;
      }
      txs.push(...j);
      const last = j[j.length - 1];
      if (!last || typeof last.signature !== 'string' || last.signature === before) break;
      if (Number(last.timestamp) < since) break;
      before = last.signature;
    }
    let oldestT = null;
    for (const tx of txs) if (Number.isFinite(tx.timestamp) && (oldestT === null || tx.timestamp < oldestT)) oldestT = tx.timestamp;
    return { txs, exhausted, oldestT };
  });
}

export function poolRecords(hist, pool) {
  const seen = new Set();
  const out = [];
  for (const tx of hist.txs) {
    if (!tx || seen.has(tx.signature)) continue;
    seen.add(tx.signature);
    const r = classifyPoolTx(tx, pool);
    if (r) out.push(r);
  }
  return out;
}

// Per-mint {call, put, wallets:Set} for a list of bet records.
export function aggregateBets(bets) {
  const m = new Map();
  for (const b of bets) {
    const a = m.get(b.mint) || { call: 0n, put: 0n, wallets: new Set() };
    if (b.side === 'C') a.call += b.lamports;
    else a.put += b.lamports;
    a.wallets.add(b.wallet);
    m.set(b.mint, a);
  }
  return m;
}

export async function getLatestBlockhash() {
  const key = (process.env.HELIUS_API_KEY || '').trim();
  if (!key) throw new HttpError(500, 'server misconfigured');
  const j = await getJson(`${HELIUS_RPC}?api-key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
  });
  const v = j && j.result && j.result.value;
  if (!v || typeof v.blockhash !== 'string' || !Number.isFinite(v.lastValidBlockHeight)) {
    throw new UpstreamError('mainnet.helius-rpc.com', 'unexpected shape');
  }
  return { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight };
}
