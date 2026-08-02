# Proxy War Live Betting — Tester Walkthrough

You are testing a **live prediction market** running on top of a replayed AI-agent
strategy match. Four AI nations fight over a map. You bet on who wins, with play money,
while the match is still unfolding.

Everything here is play money. There is no real currency, no payment path, and no
account. Your bankroll is tied to a browser cookie.

If you only have ten minutes, read §1, run §2, and do §3.

---

## 1. What you are looking at

A **price** is the crowd's implied chance that an agent wins, from 0 to 100. Prices
always sum to 100 across the four agents.

A **share** in an agent pays **100 credits** if that agent wins, and **0** if it doesn't.
So if you think an agent priced at 30 is really a 50% chance, buying is a good bet:
you pay 30 for something you believe is worth 50.

You start with **1,000 credits**. Buying moves the price up; selling moves it down. The
market is a real automated market maker (LMSR), so your own trades have price impact —
a large order fills at a worse average price than a small one.

**There is no house edge.** Buying shares and immediately selling them back nets you
exactly zero. Every credit anyone wins comes from another participant, not from the
system.

Trading is **continuous**. You can trade at any moment while the match plays. There are
no betting windows.

A **synthetic crowd** of automated bettors trades alongside you, so the market moves
even when you are the only human present. They read the actual territory each agent
controls. They are not clairvoyant — they react to what has been revealed, the same as
you.

---

## 2. Getting a match running

Full detail, including every failure mode and its cause, is in `RUNBOOK.md`. This is the
short path.

**One-time setup:** `RUNBOOK.md` §1 (install), §2 (build the client), §3 (stage agent
manifests).

Then, per match:

1. **Generate a match bundle** — `RUNBOOK.md` §4. This runs a real deterministic
   four-agent match locally. No network, no API keys. Takes about 70 seconds.
2. **Start the server** — `RUNBOOK.md` §5. You need `PROXYWAR_WAGERING_ENABLED=1`, and
   add `PROXYWAR_SYNTHETIC_CROWD_ENABLED=true` so the crowd trades alongside you.
3. **Admit the match** — `RUNBOOK.md` §6. Set `scheduledAt` a couple of minutes in the
   future so you have time to open a browser before trading starts.
4. **Restart the server** — `RUNBOOK.md` §7. Admission does not hot-register.
5. **Set the `CF-Connecting-IP` header in your browser — this is mandatory, see below.**
6. Open `http://127.0.0.1:<port>/bet/<premiereId>`.

### The header step (do not skip it)

Locally there is no reverse proxy in front of the server, so it cannot determine your
address, and **every write fails with a 400 `remote_address_unavailable`** — you will be
able to watch the match but not place a single trade. Production runs behind a Cloudflare
tunnel that supplies this header, so this is purely a local-testing gap.

Give your browser a static `CF-Connecting-IP` header on every request, set **before you
navigate**. If two people are testing on one machine, use a different value each, or you
will share a rate-limit bucket.

Easiest for a human tester: a header-injection browser extension, set to send
`CF-Connecting-IP: 203.0.113.42` for `127.0.0.1`.

If you are driving Chrome over CDP:

```js
await page.setExtraHTTPHeaders({ "CF-Connecting-IP": "203.0.113.42" });
```

**Re-apply it after any reload or new tab unless your tooling persists it.** A CDP-set
header does not reliably survive `location.reload()`. This exact trap cost us a session:
it looks precisely like "reconnecting to a match is permanently broken," and it isn't.

### Three more things that will waste your time

- **Use your own `PROXYWAR_REPLAY_PREMIERE_STATE_ROOT`.** If anyone else on the machine
  is running a server on the default root, yours will silently disable premieres
  entirely and every page will say "Replay unavailable."
- **Wipe the state root between matches.** Admitting three matches against one root
  trips `premiere_not_registered` (`RUNBOOK.md` §13.6).
- **Make the match long enough.** Aim for 10-15 minutes of nominal duration. Anything
  shorter and you will not have time to buy, hold, watch a swing, and sell.

---

## 3. What to try

Work through these in order. Each one has been verified to work end to end, so anything
that fails is a real finding worth reporting.

1. **Join before the clock starts.** Watch the market open at 25/25/25/25.
2. **Buy.** Check the fill against the quote you were shown, and that your bankroll
   debits by exactly that amount.
3. **Hold, and watch your P&L move.** Confirm the unrealised number equals what you
   would actually get for selling right now.
4. **Sell part of your position.** Take your time — several seconds between selecting
   Sell, picking the seat, and submitting. The price will move while you do this. That
   is intentional, and the app will warn you rather than filling a stale quote.
5. **Reload the page mid-match.** Your position, P&L, and bankroll should all survive.
6. **Open a second tab.** Both tabs should agree.
7. **Join late on purpose.** Open a fresh tab several minutes in. You should reach the
   live frontier within a few seconds.
8. **Hold to settlement.** Winning shares pay 100 each. Your bankroll should reconcile
   exactly, and a settlement card should render in the page.

If you have a second person, **trade against each other in the same match.** Your trades
move their prices and theirs move yours. This is the most interesting way to use it and
the least tested.

---

## 4. What we most want to know

Bugs are welcome, but these questions matter more:

- **Is it fun?** Does holding a position through a swing feel like anything? Would you
  play a second match?
- **Did you understand what you were doing** before you did it, or did you work it out
  afterwards?
- **Would you send this to a friend?** If not, what would have to change?
- **Is the market beatable?** If you spot the leading agent before the crowd does, you
  can profit. That is the intended game. Tell us if it felt like skill or like free
  money — both are useful, and they point in opposite directions.

"It worked but I was bored" is a more valuable report than a list of minor UI defects.

---

## 5. Known rough edges

Reported honestly so you can distinguish these from anything new you find.

- **Discoverability is weak.** When the match starts, the trading panel collapses to a
  narrow vertical `TRADE` strip at the right edge. Two independent testers found it, but
  both judged that a user who did not already know betting existed might watch the whole
  match and never notice. If you have a reaction to this, we want it.
- **Price and territory can disagree.** Your position can be down while your agent still
  visibly leads on the map. This is correct — price reflects expectations about the
  finish, not the current standings — but it is not explained in the product.
- **The crowd takes a moment to settle, and is briefly wrong first.** Measured on a live
  match: first trade at 4 seconds, but on the wrong agent — a spike to 43.8% that reverted
  to parity within 9 seconds. The eventual winner's first real signal came at 16 seconds,
  and prices were noisy until roughly 100-140 seconds while the early game genuinely was
  undecided. That is the market working, not malfunctioning. If you see it frozen at
  25/25/25/25 for minutes on end, that is a bug and we want to hear about it.
- **Local-only setup friction.** Join can take 12-40 seconds on a loaded machine. That,
  and the `CF-Connecting-IP` header in §2, are both artefacts of running without the
  reverse proxy a real deployment has. Neither happens in production.

---

## 6. Reporting

Include:

- What you did, in order, and what you expected to happen.
- A screenshot of anything visual.
- Your `premiereId` and port, so we can find your match in the server log.
- Whether you could reproduce it, and how many times you tried.

If the app tells you something has gone wrong, **say whether you believed it** — several
of this build's worst bugs were false alarms that looked exactly like real failures, and
a tester's instinct about which is which turned out to be the most reliable signal we
had.
