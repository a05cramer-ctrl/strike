import {
  route, send, HttpError, nowSec, hourStartOf, roundTimes, lamportsToSol, isAddress, poolConfig, fetchPoolTxs,
  poolRecords, getStonkToken, tokenView, getPair, getHourOpen, getMinuteCandles, logSoft,
} from './_lib.js';

export default route(async (req, res, url) => {
  const mint = (url.searchParams.get('mint') || '').trim();
  if (!isAddress(mint)) throw new HttpError(400, 'invalid mint');

  const now = nowSec();
  const times = roundTimes(hourStartOf(now));
  const hs = times.hourStart;
  const pool = poolConfig();

  const [token, hist] = await Promise.all([
    getStonkToken(mint),
    pool ? fetchPoolTxs(pool, { since: hs, maxPages: 3 }) : null,
  ]);
  if (!token) throw new HttpError(404, 'not a StonkFun coin');
  const v = tokenView(token);

  let pair = null;
  let last = null;
  let strike = null;
  let candles = [];
  try {
    const p = await getPair(mint);
    if (p) {
      pair = p.pairAddress;
      last = p.priceUsd;
    }
  } catch (e) {
    logSoft('pair', e);
  }
  if (pair) {
    const [o, c] = await Promise.allSettled([getHourOpen(pair, hs, { n: 2 }), getMinuteCandles(pair, hs)]);
    if (o.status === 'fulfilled') strike = o.value ?? null;
    else logSoft('hour open', o.reason);
    if (c.status === 'fulfilled') candles = c.value;
    else logSoft('minute candles', c.reason);
  }

  const bets = hist
    ? poolRecords(hist, pool.address).filter((r) => r.kind === 'bet' && r.hourStart === hs && r.mint === mint)
    : [];
  let call = 0n;
  let put = 0n;
  for (const b of bets) {
    if (b.side === 'C') call += b.lamports;
    else put += b.lamports;
  }

  send(res, 200, {
    now,
    pool: pool ? pool.address : null,
    mint,
    symbol: v.symbol,
    name: v.name,
    image: v.image,
    quote: v.quote,
    pair,
    hourStart: times.hourStart,
    closeAt: times.closeAt,
    expiry: times.expiry,
    strike,
    last,
    candles,
    call: lamportsToSol(call),
    put: lamportsToSol(put),
    bets: bets
      .sort((a, b) => b.t - a.t)
      .slice(0, 50)
      .map((b) => ({ sig: b.sig, wallet: b.wallet, side: b.side, sol: lamportsToSol(b.lamports), t: b.t })),
  }, 10);
});
