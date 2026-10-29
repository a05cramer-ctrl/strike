import {
  route, send, nowSec, hourStartOf, roundTimes, lamportsToSol, poolConfig, fetchPoolTxs, poolRecords,
  aggregateBets, getTopTokens, getStonkToken, tokenView, getPair, getHourOpen, mapLimit, logSoft,
} from './_lib.js';

const MAX_EXTRA = 20;

export default route(async (req, res) => {
  const now = nowSec();
  const times = roundTimes(hourStartOf(now));
  const hs = times.hourStart;
  const pool = poolConfig();

  const [top, hist] = await Promise.all([
    getTopTokens(),
    pool ? fetchPoolTxs(pool, { since: hs, maxPages: 3 }) : null,
  ]);

  const bets = hist ? poolRecords(hist, pool.address).filter((r) => r.kind === 'bet' && r.hourStart === hs) : [];
  const agg = aggregateBets(bets);

  const tokens = [...top];
  const listed = new Set(top.map((t) => t.mint));
  const extra = [...agg.keys()].filter((m) => !listed.has(m)).slice(0, MAX_EXTRA);
  const extraTokens = await mapLimit(extra, 5, (m) => getStonkToken(m).catch((e) => (logSoft('stonk token', e), null)));
  for (const t of extraTokens) if (t) tokens.push(t);

  const budget = { n: 6 }; // gecko calls per request (free tier ~30/min)
  const coins = await mapLimit(tokens, 6, async (t) => {
    const v = tokenView(t);
    let pair = null;
    let last = null;
    let strike = null;
    try {
      const p = await getPair(t.mint);
      if (p) {
        pair = p.pairAddress;
        last = p.priceUsd;
      }
    } catch (e) {
      logSoft('pair', e);
    }
    if (pair) {
      try {
        strike = (await getHourOpen(pair, hs, budget)) ?? null;
      } catch (e) {
        logSoft('hour open', e);
      }
    }
    const a = agg.get(t.mint);
    return {
      mint: v.mint,
      symbol: v.symbol,
      name: v.name,
      image: v.image,
      quote: v.quote,
      mcap: v.mcap,
      vol24: v.vol24,
      pair,
      strike,
      last,
      chg: strike && last !== null ? last / strike - 1 : null,
      call: a ? lamportsToSol(a.call) : 0,
      put: a ? lamportsToSol(a.put) : 0,
      bettors: a ? a.wallets.size : 0,
    };
  });

  let pot = 0n;
  for (const b of bets) pot += b.lamports;

  send(res, 200, {
    now,
    hourStart: times.hourStart,
    closeAt: times.closeAt,
    expiry: times.expiry,
    pool: pool ? pool.address : null,
    coins,
    totals: { pot: lamportsToSol(pot), bets: bets.length },
  }, 30);
});
