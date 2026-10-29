import {
  route, send, lamportsToSol, poolConfig, fetchPoolTxs, poolRecords, groupRounds, roundTotals, roundKey,
  getStonkToken, getPair, getHourCandle, mapLimit, logSoft,
} from './_lib.js';

const MAX_ROUNDS = 30;

export default route(async (req, res) => {
  const pool = poolConfig();
  if (!pool) return send(res, 200, { rounds: [], buyback: null, pool: null }, 30);

  const hist = await fetchPoolTxs(pool, { since: 0, maxPages: 3 });
  const records = poolRecords(hist, pool.address);
  const coveredFrom = hist.exhausted ? -Infinity : hist.oldestT ?? Infinity;

  // PAY txs grouped per round; result = earliest PAY memo of that round.
  const byRound = new Map();
  let buyL = 0n;
  let burnRaw = 0n;
  for (const r of records) {
    if (r.kind === 'buy') buyL += r.lamports;
    else if (r.kind === 'burn') burnRaw += r.amountRaw;
    if (r.kind !== 'pay') continue;
    const k = roundKey(r.hourStart, r.mint);
    let g = byRound.get(k);
    if (!g) {
      g = { hourStart: r.hourStart, mint: r.mint, result: r.result, firstT: r.t, paidL: 0n, payouts: [] };
      byRound.set(k, g);
    }
    if (r.t < g.firstT) {
      g.firstT = r.t;
      g.result = r.result;
    }
    for (const x of r.transfers) {
      g.paidL += x.lamports;
      g.payouts.push({ wallet: x.wallet, sol: lamportsToSol(x.lamports), sig: r.sig });
    }
  }

  const betRounds = groupRounds(records);
  const picked = [...byRound.values()]
    .sort((a, b) => b.hourStart - a.hourStart || b.firstT - a.firstT)
    .slice(0, MAX_ROUNDS);

  const budget = { n: 6 }; // gecko calls per request; finished candles are cached forever
  const rounds = await mapLimit(picked, 5, async (g) => {
    const bets = betRounds.get(roundKey(g.hourStart, g.mint));
    let pot;
    if (bets && g.hourStart >= coveredFrom) pot = lamportsToSol(roundTotals(bets.bets).pot);
    else if (g.result === 'R') pot = lamportsToSol(g.paidL);
    else pot = (lamportsToSol(g.paidL) * 100) / 99; // bets older than loaded history: derive from payouts

    let symbol = null;
    try {
      const t = await getStonkToken(g.mint);
      symbol = t ? t.symbol ?? null : null;
    } catch (e) {
      logSoft('stonk token', e);
    }

    let strike = null;
    let close = null;
    try {
      const p = await getPair(g.mint);
      if (p) {
        const c = await getHourCandle(p.pairAddress, g.hourStart, budget);
        if (c) {
          strike = c.strike;
          close = c.close;
        }
      }
    } catch (e) {
      logSoft('settled candle', e);
    }

    return {
      hourStart: g.hourStart,
      mint: g.mint,
      symbol,
      result: g.result,
      pot,
      payouts: g.payouts,
      strike,
      close,
    };
  });

  send(res, 200, {
    rounds,
    buyback: { solSpent: lamportsToSol(buyL), burnedRaw: burnRaw.toString() },
    pool: pool.address,
  }, 30);
});
