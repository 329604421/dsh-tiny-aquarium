import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTokenLedger, emptyLedgerSnapshot, isLedgerState, totalOf,
  LEDGER_VERSION, SCOOPS_PER_UNIT, QUEUE_CAP, TOKEN_UNIT, WELCOME_SCOOPS,
} from '../src/token-ledger.js';

const UNIT = 1_000;                     // small unit keeps the assertions readable
// Most cases below are about the arithmetic of conversion, so they start from an
// empty queue; the welcome stock has its own cases and uses the real default.
const options = { unit: UNIT, scoops: 5, cap: 100, welcome: 0 };
const prodOptions = { unit: UNIT, scoops: 5, cap: 100 };
const ledgerWith = (state = null) => createTokenLedger(state, options);
const round = (ledger, entries) => ledger.observe(entries);

test('totalOf sums the four non-overlapping buckets and ignores junk', () => {
  assert.equal(totalOf({ uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 }), 20);
  assert.equal(totalOf({ outputTokens: 7 }), 7);
  assert.equal(totalOf(undefined), undefined);
  assert.equal(totalOf({}), undefined);
  assert.equal(totalOf({ outputTokens: -1 }), undefined);
  assert.equal(totalOf({ outputTokens: 4, cacheReadTokens: Number.NaN }), 4);
});

test('A1 first sight only records a baseline', () => {
  const ledger = ledgerWith();
  const { gained } = round(ledger, [{ id: 'a', tokens: 1e9 }]);
  assert.equal(gained, 0);
  assert.equal(ledger.snapshot().observed, 0);
  assert.equal(ledger.snapshot().foodQueue, 0);
});

test('A2 crossing the unit converts one block and keeps the remainder', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 1e6 }]);
  const { gained } = round(ledger, [{ id: 'a', tokens: 1e6 + UNIT + 100 }]);
  assert.equal(gained, SCOOPS_PER_UNIT);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.pending, 100);
  assert.equal(snapshot.foodQueue, SCOOPS_PER_UNIT);
  assert.equal(snapshot.observed, UNIT + 100);
  assert.equal(snapshot.toNextUnit, UNIT - 100);
});

test('A3 a pending balance just short of the unit converts nothing', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 0 }]);
  round(ledger, [{ id: 'a', tokens: UNIT - 1 }]);
  assert.equal(ledger.snapshot().foodQueue, 0);
  assert.equal(ledger.snapshot().pending, UNIT - 1);
});

test('A4 a falling total never produces a negative delta', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 1e7 }]);
  const { gained } = round(ledger, [{ id: 'a', tokens: 0 }]);
  assert.equal(gained, 0);
  assert.equal(ledger.snapshot().observed, 0);
  assert.equal(ledger.snapshot().pending, 0);
});

test('A5 a brand-new session with an inherited prefix converts nothing', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 10 }]);
  const { gained } = round(ledger, [{ id: 'a', tokens: 20 }, { id: 'fork', tokens: 6 * UNIT }]);
  assert.equal(gained, 0);
  assert.equal(ledger.snapshot().observed, 10);
});

test('A6 a nearly full queue keeps counting but holds the next block', () => {
  const ledger = createTokenLedger({ ...fresh(), foodQueue: QUEUE_CAP - 3 }, options);
  round(ledger, [{ id: 'a', tokens: 0 }]);
  const { gained } = round(ledger, [{ id: 'a', tokens: UNIT }]);
  assert.equal(gained, 0);
  assert.equal(ledger.snapshot().foodQueue, QUEUE_CAP - 3);
  assert.equal(ledger.snapshot().pending, UNIT);
  // Making room converts the held block on the next sample, without new usage.
  assert.equal(ledger.takeScoops(10), 10);
  const next = round(ledger, [{ id: 'a', tokens: UNIT + 1 }]);
  assert.equal(next.gained, SCOOPS_PER_UNIT);
  const afterDelivery = QUEUE_CAP - 3 - 10;
  assert.equal(ledger.snapshot().foodQueue, afterDelivery + SCOOPS_PER_UNIT);
  assert.equal(ledger.snapshot().pending, 1);
});

test('A7 one pour takes one scoop, and the jar never goes negative', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 0 }]);
  round(ledger, [{ id: 'a', tokens: 3 * UNIT }]);
  assert.equal(ledger.snapshot().foodQueue, 15);
  // 一次点击就是一勺：有 15 勺也只扣 1 勺，不会把整罐倒出去。
  assert.equal(ledger.takeScoops(1), 1);
  assert.equal(ledger.snapshot().foodQueue, 14);
  assert.equal(ledger.takeScoops(100), 14);
  assert.equal(ledger.snapshot().foodQueue, 0);
  assert.equal(ledger.takeScoops(1), 0, 'an empty jar gives nothing');
  assert.equal(ledger.snapshot().delivered, 15);
});

test('A8/A9 serialization round-trips balances and baselines', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 1e6 }, { id: 'b', tokens: 2e6 }]);
  round(ledger, [{ id: 'a', tokens: 1e6 + 2 * UNIT }, { id: 'b', tokens: 2e6 }]);
  const payload = ledger.serialize();
  assert.equal(payload.v, LEDGER_VERSION);
  const resumed = createTokenLedger(payload, options);
  assert.deepEqual(resumed.snapshot(), ledger.snapshot());
  // The resumed baseline still suppresses the pre-restart prefix.
  const { gained } = round(resumed, [{ id: 'a', tokens: 1e6 + 2 * UNIT + UNIT }, { id: 'b', tokens: 2e6 }]);
  assert.equal(gained, SCOOPS_PER_UNIT);
});

test('A10 a crash between writes is recovered without double counting', () => {
  const first = ledgerWith();
  round(first, [{ id: 'a', tokens: 1e6 }]);
  round(first, [{ id: 'a', tokens: 1e6 + 300 }]);
  const stalePayload = first.serialize();          // written before the next sample
  round(first, [{ id: 'a', tokens: 1e6 + 700 }]);
  const recovered = createTokenLedger(stalePayload, options);
  const { gained } = round(recovered, [{ id: 'a', tokens: 1e6 + 700 }]);
  assert.equal(gained, 0);
  assert.equal(recovered.snapshot().observed, first.snapshot().observed);
  assert.equal(recovered.snapshot().observed, 700);
});

test('A11 reset zeroes every balance and moves the epoch', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 0 }]);
  round(ledger, [{ id: 'a', tokens: 3 * UNIT }]);
  const before = ledger.snapshot();
  const after = ledger.reset();
  assert.ok(after.epochAt >= before.epochAt);
  for (const key of ['observed', 'pending', 'foodQueue', 'earned', 'exchanges']) assert.equal(after[key], 0, key);
});

test('A12 usage present at the reset instant becomes the new baseline', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 100 * UNIT }]);
  ledger.reset();
  round(ledger, [{ id: 'a', tokens: 100 * UNIT }]);            // re-baseline, no credit
  assert.equal(ledger.snapshot().observed, 0);
  const { gained } = round(ledger, [{ id: 'a', tokens: 105 * UNIT }]);
  assert.equal(gained, SCOOPS_PER_UNIT * 5);                  // five blocks, not a hundred
  assert.equal(ledger.snapshot().observed, 5 * UNIT);
});

test('A13 a reset payload serializes as empty with the new epoch', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 0 }]);
  round(ledger, [{ id: 'a', tokens: 4 * UNIT }]);
  const after = ledger.reset();
  const payload = ledger.serialize();
  assert.equal(payload.observed, 0);
  assert.equal(payload.foodQueue, 0);
  assert.equal(payload.baseline.length, 0);
  const resumed = createTokenLedger(payload, options);
  assert.deepEqual(resumed.snapshot(), after);
  assert.equal(isLedgerState(payload), true);
});

test('prune drops sessions the host no longer lists', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 10 }, { id: 'b', tokens: 20 }]);
  ledger.prune(['a']);
  assert.deepEqual(ledger.serialize().baseline, [['a', 10]]);
});

test('refund returns a refused batch to the queue', () => {
  const ledger = ledgerWith();
  round(ledger, [{ id: 'a', tokens: 0 }]);
  round(ledger, [{ id: 'a', tokens: UNIT }]);
  const taken = ledger.takeScoops(5);
  assert.equal(taken, 5);
  assert.equal(ledger.snapshot().delivered, 5, 'a taken batch counts as fed');
  ledger.refund(taken);
  assert.equal(ledger.snapshot().foodQueue, 5);
  assert.equal(ledger.snapshot().delivered, 0, 'a refused batch is not fed');
  ledger.refund(-3);
  ledger.refund(Number.NaN);
  assert.equal(ledger.snapshot().foodQueue, 5);
});

test('delivered food closes the books: fed + queued = welcome + credited', () => {
  const ledger = ledgerWith({ welcome: 0 });
  round(ledger, [{ id: 'a', tokens: 0 }]);
  round(ledger, [{ id: 'a', tokens: 2 * UNIT }]);
  assert.equal(ledger.snapshot().earned, 10);
  ledger.takeScoops(5);
  const after = ledger.snapshot();
  assert.equal(after.delivered, 5);
  assert.equal(after.foodQueue, 5);
  // 这条恒等式就是设置页那三行数字的摆放依据：少了「已投喂」，前两行永远对不上。
  assert.equal(after.delivered + after.foodQueue, after.earned);
  // 重启用 serialize 回来的账本要接着记，不能把已投喂清零。
  const resumed = createTokenLedger(ledger.serialize(), options);
  assert.equal(resumed.snapshot().delivered, 5);
  assert.equal(resumed.snapshot().foodQueue, 5);
});

test('the welcome stock shows up as fed once it is dropped, never as credited', () => {
  const ledger = createTokenLedger(null, { ...options, welcome: 5 });
  assert.equal(ledger.snapshot().foodQueue, 5);
  assert.equal(ledger.takeScoops(5), 5);
  const after = ledger.snapshot();
  assert.equal(after.delivered, 5, '初装落水后计入已投喂');
  assert.equal(after.earned, 0, '初装不是兑换出来的');
  assert.equal(after.delivered + after.foodQueue, 5 + after.earned);
});

test('a payload from before delivered existed resumes at zero fed', () => {
  const legacy = { ...fresh(), delivered: undefined };
  const ledger = createTokenLedger(legacy, options);
  assert.equal(ledger.snapshot().delivered, 0);
});

test('unknown payload versions and malformed states start fresh', () => {
  const future = { ...fresh(), v: 99, observed: 5_000 };
  assert.equal(isLedgerState(future), false);
  assert.equal(createTokenLedger(future, options).snapshot().observed, 0);
  assert.equal(isLedgerState(null), false);
  assert.equal(isLedgerState({ v: 1 }), false);
  assert.equal(isLedgerState({ ...fresh(), baseline: [['a', 'nope']] }), false);
  // The schema default the host resolves before any write is not a resume.
  const zeroed = { v: 1, epochAt: 0, observed: 0, pending: 0, foodQueue: 0, earned: 0, exchanges: 0, baseline: [] };
  assert.equal(isLedgerState(zeroed), false);
  assert.ok(createTokenLedger(zeroed, options).snapshot().epochAt > 0, 'a zeroed section starts a real epoch');
});

test('the production constants are the agreed ones', () => {
  assert.equal(TOKEN_UNIT, 5_000_000);
  assert.equal(SCOOPS_PER_UNIT, 5);
  assert.equal(QUEUE_CAP, 100);
  assert.equal(WELCOME_SCOOPS, 5);
  assert.deepEqual(emptyLedgerSnapshot(), {
    epochAt: 0, observed: 0, pending: 0, foodQueue: 0, earned: 0, exchanges: 0, delivered: 0,
    unit: TOKEN_UNIT, scoops: SCOOPS_PER_UNIT, toNextUnit: TOKEN_UNIT,
  });
});

test('a fresh install is stocked with the welcome scoops, not credited as earnings', () => {
  const ledger = createTokenLedger(null, prodOptions);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.foodQueue, WELCOME_SCOOPS);
  assert.equal(snapshot.observed, 0);
  assert.equal(snapshot.earned, 0, 'the gift is stock, not an exchange');
  assert.equal(snapshot.exchanges, 0);
  assert.ok(snapshot.epochAt > 0);
});

test('the welcome stock is handed out once per ledger, not once per start', () => {
  const first = createTokenLedger(null, prodOptions);
  assert.equal(first.takeScoops(WELCOME_SCOOPS), WELCOME_SCOOPS, 'the first visit can feed it');
  assert.equal(first.snapshot().foodQueue, 0);
  const resumed = createTokenLedger(first.serialize(), prodOptions);
  assert.equal(resumed.snapshot().foodQueue, 0, 'a restart does not restock');
  assert.equal(resumed.serialize().gifted, true);
});

test('a payload written before the welcome stock existed gets it on the upgrade', () => {
  const legacy = { ...fresh(), epochAt: 10 };        // no `gifted` key at all
  assert.equal(isLedgerState(legacy), true, 'old payloads stay resumable');
  const upgraded = createTokenLedger(legacy, prodOptions);
  assert.equal(upgraded.snapshot().foodQueue, WELCOME_SCOOPS);
  assert.equal(upgraded.serialize().gifted, true, 'and the flag is written back');
  assert.equal(createTokenLedger(upgraded.serialize(), prodOptions).snapshot().foodQueue, WELCOME_SCOOPS,
    'resuming the upgraded payload does not stock it again');
});

test('reset reinstalls the welcome stock but keeps it out of the books', () => {
  const ledger = createTokenLedger(null, prodOptions);
  ledger.takeScoops(WELCOME_SCOOPS);
  round(ledger, [{ id: 'a', tokens: 0 }]);
  round(ledger, [{ id: 'a', tokens: 3 * UNIT }]);
  const after = ledger.reset();
  assert.equal(after.foodQueue, WELCOME_SCOOPS);
  assert.equal(after.earned, 0);
  assert.equal(after.exchanges, 0);
  assert.equal(after.observed, 0);
  assert.deepEqual(createTokenLedger(ledger.serialize(), prodOptions).snapshot(), after);
});

test('the welcome stock cannot push a nearly full queue past the cap', () => {
  const ledger = createTokenLedger({ ...fresh(), foodQueue: QUEUE_CAP - 2 }, { ...prodOptions, welcome: 10 });
  assert.equal(ledger.snapshot().foodQueue, QUEUE_CAP);
});

function fresh() {
  return { v: LEDGER_VERSION, epochAt: 1, observed: 0, pending: 0, foodQueue: 0, earned: 0, exchanges: 0, baseline: [] };
}
