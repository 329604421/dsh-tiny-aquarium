/**
 * Token usage → fish food. Pure arithmetic: no clock, no DOM, no storage, so
 * every rule here is table-testable with `node --test`.
 *
 * The ledger owns three separate numbers on purpose:
 * - `observed`  every token counted since the epoch (install or last reset);
 * - `pending`   the part of it that has not been converted yet, `0 ≤ pending < unit`;
 * - `foodQueue` pellets already paid for but not dropped into the tank yet.
 *
 * Token usage is money, food is stock, and the queue is "paid, not shipped".
 * Pellets only live 25 s and the tank holds 100, so delivery happens when the
 * aquarium is open and never in halves.
 *
 * A fresh install also starts with a small welcome stock (`WELCOME_SCOOPS`) so
 * the first visit has something to feed without waiting for 5M tokens. It is
 * stock, not earnings: `earned`/`exchanges` keep counting conversions only, and
 * the `gifted` flag makes the grant once-in-a-ledger instead of once per start.
 */

export const TOKEN_UNIT = 5_000_000;
export const SCOOPS_PER_UNIT = 5;
export const QUEUE_CAP = 100;
export const WELCOME_SCOOPS = 5;
export const LEDGER_VERSION = 1;
export const BASELINE_LIMIT = 200;

/** The four buckets of the `tokenUsage` projection; they never overlap. */
const USAGE_FIELDS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/**
 * Sum one `tokenUsage` projection value.
 * @param usage Projection value, possibly partial or absent.
 * @returns Total tokens, or undefined when the projection never reported a number.
 */
export function totalOf(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  let total = 0;
  let seen = false;
  for (const key of USAGE_FIELDS) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) { total += value; seen = true; }
  }
  return seen ? total : undefined;
}

const snapshotOf = ({ epochAt, observed, pending, foodQueue, earned, exchanges, delivered }, unit, scoops) => ({
  epochAt, observed, pending, foodQueue, earned, exchanges, delivered,
  unit, scoops, toNextUnit: Math.max(0, unit - pending),
});

/** A zeroed snapshot for the first render, before any persisted state arrives. */
export function emptyLedgerSnapshot(options = {}) {
  const unit = options.unit ?? TOKEN_UNIT;
  const scoops = options.scoops ?? SCOOPS_PER_UNIT;
  return snapshotOf({ epochAt: 0, observed: 0, pending: 0, foodQueue: 0, earned: 0, exchanges: 0, delivered: 0 }, unit, scoops);
}

/**
 * Whether a stored config value carries a ledger this version understands.
 * A future `v` is dropped rather than misread: the statistics restart from the
 * current usage, which is the same semantic as a fresh install.
 * @param value Persisted `ledger` config section.
 * @returns Whether the payload can seed a ledger.
 */
export function isLedgerState(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.v !== LEDGER_VERSION) return false;
  // `epochAt: 0` is the schema default the host resolves for a section nobody
  // has written yet, so it means "no statistics" rather than "started in 1970".
  if (typeof value.epochAt !== 'number' || !Number.isFinite(value.epochAt) || value.epochAt <= 0) return false;
  for (const key of ['observed', 'pending', 'foodQueue', 'earned', 'exchanges']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) return false;
  }
  // `delivered` 是后加的：旧载荷没有它，按 0 起算；给了就必须是合法计数。
  if (value.delivered !== undefined
    && (typeof value.delivered !== 'number' || !Number.isFinite(value.delivered) || value.delivered < 0)) return false;
  // Payloads written before the welcome stock existed omit the flag; they are
  // still resumable, and the missing flag is exactly what grants it once.
  if (value.gifted !== undefined && typeof value.gifted !== 'boolean') return false;
  if (!Array.isArray(value.baseline)) return false;
  return value.baseline.every(pair => Array.isArray(pair) && typeof pair[0] === 'string'
    && typeof pair[1] === 'number' && Number.isFinite(pair[1]) && pair[1] >= 0);
}

/**
 * Create a ledger, optionally resuming one from `serialize()` output.
 * @param state Persisted payload, or null for a fresh install.
 * @param options Overrides for the unit, pellet count, queue cap and welcome stock (tests only).
 * @returns Ledger handle.
 */
export function createTokenLedger(state = null, options = {}) {
  const unit = options.unit ?? TOKEN_UNIT;
  const scoops = options.scoops ?? SCOOPS_PER_UNIT;
  const cap = options.cap ?? QUEUE_CAP;
  const welcome = options.welcome ?? WELCOME_SCOOPS;
  const resume = isLedgerState(state) ? state : null;
  const baseline = new Map(resume?.baseline ?? []);
  let epochAt = resume?.epochAt ?? Date.now();
  let observed = resume?.observed ?? 0;
  let pending = resume?.pending ?? 0;
  let foodQueue = resume?.foodQueue ?? 0;
  let earned = resume?.earned ?? 0;
  let exchanges = resume?.exchanges ?? 0;
  // Pellets that actually went into the tank. Without it the page can only show
  // "credited" and "queued", so a user who has fed twice sees 10 credited and
  // 10 queued and reasonably concludes the arithmetic is broken.
  let delivered = resume?.delivered ?? 0;
  let gifted = resume?.gifted ?? false;
  // Stock the tank once per ledger. A restart resumes a payload that already
  // carries the flag, so the welcome batch is never handed out twice; an older
  // payload without the flag gets it on the upgrade, which is also a first run
  // for this rule.
  if (!gifted) {
    foodQueue = Math.min(cap, foodQueue + welcome);
    gifted = true;
  }

  const snapshot = () => snapshotOf({ epochAt, observed, pending, foodQueue, earned, exchanges, delivered }, unit, scoops);

  /**
   * Fold one round of session totals into the ledger.
   * A session seen for the first time only records its baseline: usage that
   * happened before the install (or before a reset) never counts.
   * @param entries `{ id, tokens }` per session, tokens being the cumulative total.
   * @returns Pellets earned by this round and the resulting snapshot.
   */
  function observe(entries) {
    let gained = 0;
    for (const entry of entries ?? []) {
      const id = entry?.id;
      const tokens = entry?.tokens;
      if (typeof id !== 'string' || !Number.isFinite(tokens) || tokens < 0) continue;
      const previous = baseline.get(id);
      baseline.set(id, tokens);
      if (previous === undefined) continue;
      const delta = tokens - previous;
      if (delta <= 0) continue;
      observed += delta;
      pending += delta;
    }
    while (pending >= unit && foodQueue + scoops <= cap) {
      pending -= unit;
      foodQueue += scoops;
      earned += scoops;
      exchanges += 1;
      gained += scoops;
    }
    return { gained, snapshot: snapshot() };
  }

  /**
   * Drop baselines for sessions the host no longer lists, so the persisted
   * payload cannot grow without bound.
   * @param ids Every session id in the current list, subagents included.
   */
  function prune(ids) {
    const keep = new Set(ids ?? []);
    for (const id of [...baseline.keys()]) if (!keep.has(id)) baseline.delete(id);
  }

  /**
   * Reserve scoops for one pour. Stock is counted in scoops; how many pellets a
   * scoop becomes is the scene's business (`LIMITS.batch`), not the ledger's.
   * @param want Scoops requested; a manual click always asks for exactly one.
   * @returns Scoops actually taken (0 when the jar is empty).
   */
  function takeScoops(want = 1) {
    const ask = Math.floor(Math.max(0, Number.isFinite(want) ? want : 1));
    const taken = Math.min(foodQueue, ask);
    foodQueue -= taken;
    delivered += taken;
    return taken;
  }

  /**
   * Return reserved scoops that the scene refused (tank full, double click).
   * @param count Scoops to put back in the queue.
   */
  function refund(count) {
    // 场景拒收（水满/失焦）意味这批没真正落水，已投喂计数要一起退回。
    if (Number.isFinite(count) && count > 0) { foodQueue += count; delivered = Math.max(0, delivered - count); }
  }

  /**
   * Reset means "install the plugin again": clear the books, move the epoch to
   * now, restock the welcome pellets, and let the next `observe()` re-establish
   * baselines through the same first-sight rule, so the two paths cannot diverge.
   * @returns Snapshot with the new epoch and the welcome stock restored.
   */
  function reset() {
    baseline.clear();
    epochAt = Date.now();
    observed = 0;
    pending = 0;
    foodQueue = Math.min(cap, welcome);
    earned = 0;
    exchanges = 0;
    delivered = 0;
    gifted = true;
    return snapshot();
  }

  /** @returns Payload for one atomic config write: baselines and balances together. */
  function serialize() {
    return {
      v: LEDGER_VERSION, epochAt, observed, pending, foodQueue, earned, exchanges, delivered, gifted,
      baseline: [...baseline].slice(-BASELINE_LIMIT),
    };
  }

  return { observe, prune, takeScoops, refund, reset, snapshot, serialize };
}
