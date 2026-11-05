// `companion:agenda` — the agenda port the reminder side talks to (P2.5 3A-4 / 3A-5).
//
// The QQ reminder feature needs three things from the runtime's H1 agenda and nothing else:
// create a schedule for a reminder, ask "is this still the plan?" right before sending, and record
// the send afterwards. Its seam (`dsh-channel-qq/src/features/reminders/agenda-seam.ts`) expects a
// **narrow, never-throwing** port with exactly those three methods; this file is that port.
//
// Two honesty rules that must not drift:
//   1. `reminderDelivery` stays `not-wired`. Implementing the seam does **not** create a delivery
//      path: the reminder channel sends, this module only answers questions and keeps the book
//      (CONTRACT §13.8). Anything that said "reminders are wired now" would be an over-claim.
//   2. When the runtime is not mounted, or the agenda switch is off, the port says so
//      (`runtime-not-mounted` / `disabled`) instead of pretending the reminder is bound. A reminder
//      created without an occurrence must be described to the user as "not bound to a schedule".

const FALLBACK_TIME_ZONE = 'Asia/Shanghai';

function localDateAndTime(at, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(Number(at)))) parts[part.type] = part.value;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // `24:00` is what some engines report for midnight with hour12:false; a schedule wants 00:00.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date, time: `${hour}:${parts.minute}` };
}

/**
 * Publish the port as `companionAgenda` on the host context.
 *
 * The reminder channel resolves its agenda handle with `ctx.get('companionAgenda')`, exactly like
 * this plugin resolves memory with `ctx.get('companionMemory')`. A value that only exists on the
 * `mount()` result is invisible to other plugins, so without this the seam degrades silently to
 * "no binding, no CAS" — the failure mode that looks like everything is fine.
 *
 * Three paths, most explicit first, and the chosen one is logged so an operator can see which
 * host API actually existed:
 *   1. `ctx.provide(name, value)` — the cordis contract;
 *   2. `ctx.set(name, value)` — older/simpler host shims;
 *   3. a plain property on the context — last resort.
 * Never throws: a failed publish must not take the whole mount down, but it *is* reported.
 */
/**
 * C4-1: one place that decides the identity handed to **every** agenda call. The runtime resolves the
 * scope from it, so a method without it answers `not-found` no matter how correct it is.
 */
function identityOf(input) {
  const out = {};
  const sessionId = String(input?.sessionId ?? '').trim();
  if (sessionId) out.sessionId = sessionId;
  const scopeKey = String(input?.scopeKey ?? '').trim();
  if (scopeKey) out.scopeKey = scopeKey;
  return out;
}

export function provideAgendaService(ctx, port, { name = 'companionAgenda', logger = null } = {}) {
  const say = message => {
    const text = `[companion-foundation] agenda service: ${message}`;
    try {
      if (typeof logger === 'function') logger(text);
      else console.log(text);
    } catch { /* logging must never fail the mount */ }
  };
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) {
    say('no host context; the port is only available on the mount result');
    return { ok: false, via: 'none', verified: false };
  }

  /**
   * Publish through one tier and **read it back** (round-3 B1).
   *
   * "I called provide() without an error" is not "the value is published": the read-back must return
   * *this* object, not merely *something*. A tier that does not verify is treated as failed and the
   * next tier is tried.
   */
  // round-4 B6: `ctx.provide` may refuse because the *name is taken* by somebody else, and falling
  // back then overwrites their service through `ctx.set`/property assignment. Read the current value
  // first: a different object already published under this name is somebody else's service.
  const existing = (() => {
    try {
      if (typeof ctx.get === 'function') return ctx.get(name);
      return ctx[name];
    } catch { return undefined; }
  })();
  if (existing && existing !== port) {
    say(`name ${name} is already taken by another service; refusing to overwrite it`);
    return { ok: false, via: 'conflict', verified: false, reason: 'name-taken' };
  }


  const publish = (tier, write) => {
    const marker = `pub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    try {
      Object.defineProperty(port, '__dshPublicationId', { value: marker, enumerable: false, configurable: true, writable: true });
    } catch { /* a frozen port cannot carry a marker; fall back to identity below */ }
    try {
      write();
    } catch (error) {
      say(`tier=${tier} refused: ${String(error?.message ?? error)}`);
      return false;
    }
    let readBack = null;
    try {
      if (typeof ctx.get === 'function') readBack = ctx.get(name, false);
      else readBack = ctx[name];
    } catch { readBack = null; }
    // Marker first (survives proxying), identity second (survives a host that strips unknown props).
    const hit = readBack?.__dshPublicationId === marker || readBack === port;
    say(`publish tier=${tier}, read-back=${hit ? 'hit' : 'MISS'}`);
    return hit;
  };

  const tiers = [
    ['provide', () => { if (typeof ctx.provide !== 'function') throw new Error('no ctx.provide'); ctx.provide(name, port); }],
    ['set', () => { if (typeof ctx.set !== 'function') throw new Error('no ctx.set'); ctx.set(name, port); }],
    ['property', () => { ctx[name] = port; }],
  ];
  for (const [tier, write] of tiers) {
    if (publish(tier, write)) return { ok: true, via: tier, verified: true };
  }
  say(`no tier could publish ${name} with a verified read-back; the reminder binding will degrade`);
  return { ok: false, via: 'failed', verified: false };
}

/**
 * Build the agenda port.
 *
 * @param {{ cognitive?: object|null, timeZone?: string, now?: () => number }} input `cognitive` is
 *   the mounted runtime handle; every method degrades honestly when it is null.
 */
export function createAgendaPort({ cognitive = null, timeZone = FALLBACK_TIME_ZONE, now = () => Date.now() } = {}) {
  const zone = String(timeZone || FALLBACK_TIME_ZONE);
  const runtime = () => (cognitive && typeof cognitive === 'object' ? cognitive : null);

  return {
    /**
     * Create a schedule that stands for one reminder.
     *
     * The reminder's own instant is the input: the schedule is a `once` rule at that local time.
     * If an occurrence cannot be identified afterwards the result says so by **omitting**
     * `occurrenceId` rather than inventing one — an unbound reminder must be describable as unbound.
     */
    createSchedule(input = {}) {
      const handle = runtime();
      if (!handle) return { ok: false, code: 'runtime-not-mounted' };
      if (typeof handle.createSchedule !== 'function') return { ok: false, code: 'runtime-not-mounted' };
      const at = Number(input.at);
      if (!Number.isFinite(at) || at <= 0) return { ok: false, code: 'invalid-input', error: 'at is required' };
      const text = String(input.text ?? '').trim();
      if (!text) return { ok: false, code: 'invalid-input', error: 'text is required' };
      const { date, time } = localDateAndTime(at, zone);
      let created;
      try {
        created = handle.createSchedule({
          title: text.slice(0, 120),
          rule: 'once',
          timeZone: zone,
          date,
          time,
          category: 'plan',
          // A reminder is something the user asked to be told about; the agenda records the plan,
          // it never authorizes sending by itself.
          authorization: 'reminder',
          requestKey: input.requestKey ?? `reminder:${at}:${text.slice(0, 40)}`,
          sessionId: input.sessionId ?? '',
        });
      } catch (error) {
        return { ok: false, code: String(error?.code ?? 'agenda-failed') };
      }
      if (!created || created.ok !== true) {
        const code = String(created?.code ?? 'agenda-failed');
        return { ok: false, code: code === 'agenda-disabled' ? 'disabled' : code };
      }
      // The runtime answers which occurrence *this* call created (`chosen: 'slot' | 'only' |
      // 'none'`). The port does **not** re-derive it by looking for a nearby instant: two
      // reminders in the same minute would then be indistinguishable, and a wrong binding is
      // worse than none — it would look verified and make every later CAS compare the wrong
      // revision.
      const occurrence = created.occurrence && created.occurrence.id
        ? { id: String(created.occurrence.id), revision: Number(created.occurrence.revision), dueAt: Number(created.occurrence.dueAt) || 0 }
        : null;
      return {
        ok: true,
        itemId: created.itemId ?? '',
        // Kept flat for the existing seam shape, and `occurrence` carries the honest binding.
        revision: occurrence ? occurrence.revision : undefined,
        occurrenceId: occurrence ? occurrence.id : undefined,
        occurrence,
        chosen: String(created.chosen ?? (occurrence ? 'slot' : 'none')),
        // Kept in the answer so nothing downstream can mistake a plan for a delivery path.
        reminderDelivery: 'not-wired',
      };
    },

    /**
     * The next occurrence of a recurring schedule (third seam method).
     *
     * A repeating reminder asks this every round: it advances its own `at`, and without the next
     * occurrence it would CAS against a revision that the previous dispatch already moved — the
     * second round would look stale and land in `unknown`. The runtime answers from the agenda it
     * already materialised, so the same `(scheduleId, dueAt)` always yields the same occurrence and
     * nothing is appended per call. Never throws.
     */
    nextOccurrence(input = {}) {
      const handle = runtime();
      if (!handle) return { ok: false, code: 'not-found' };
      if (typeof handle.nextOccurrence !== 'function') return { ok: false, code: 'not-found' };
      const occurrenceId = String(input.occurrenceId ?? '').trim();
      if (!occurrenceId) return { ok: false, code: 'not-found' };
      let result;
      try {
        result = handle.nextOccurrence({ occurrenceId, at: Number(input.at ?? now()), ...identityOf(input) });
      } catch (error) {
        return { ok: false, code: String(error?.code ?? 'agenda-failed') };
      }
      if (!result || result.ok !== true) {
        const code = String(result?.code ?? 'agenda-failed');
        return { ok: false, code: code === 'agenda-disabled' ? 'disabled' : code };
      }
      const occurrence = result.occurrence ?? null;
      if (!occurrence || !occurrence.id) return { ok: false, code: 'exhausted' };
      return {
        ok: true,
        occurrence: {
          id: String(occurrence.id),
          scheduleId: String(occurrence.scheduleId ?? ''),
          dueAt: Number(occurrence.dueAt) || 0,
          revision: Number(occurrence.revision) || 0,
          status: String(occurrence.status ?? ''),
        },
      };
    },

    /** "Is this the plan I read?" — before sending. Never throws. */
    casOccurrence(input = {}) {
      const handle = runtime();
      if (!handle) return { ok: false, code: 'runtime-not-mounted' };
      if (typeof handle.casOccurrence !== 'function') return { ok: false, code: 'runtime-not-mounted' };
      const occurrenceId = String(input.occurrenceId ?? '').trim();
      const revision = Number(input.revision);
      if (!occurrenceId) return { ok: false, code: 'not-found' };
      if (!Number.isFinite(revision)) return { ok: false, code: 'revision-changed' };
      let result;
      try {
        result = handle.casOccurrence({ occurrenceId, revision, at: Number(input.at ?? now()), ...identityOf(input) });
      } catch (error) {
        return { ok: false, code: String(error?.code ?? 'agenda-failed') };
      }
      if (!result || result.ok !== true) {
        const code = String(result?.code ?? 'agenda-failed');
        return {
          ok: false,
          code: code === 'agenda-disabled' ? 'disabled' : code,
          ...(Number.isFinite(Number(result?.actualRevision)) ? { actualRevision: Number(result.actualRevision) } : {}),
        };
      }
      // The rich runtime answer is narrowed here, so the reminder code only ever sees this shape.
      return {
        ok: true,
        revision: Number(result.revision),
        occurrenceId,
        dueAt: Number(result.occurrence?.dueAt) || 0,
        status: String(result.occurrence?.status ?? ''),
      };
    },

    /** Record the send. Never throws; idempotent per (occurrenceId, revision). */
    markOccurrenceDispatched(input = {}) {
      const handle = runtime();
      if (!handle) return { ok: false, code: 'runtime-not-mounted' };
      if (typeof handle.markOccurrenceDispatched !== 'function') return { ok: false, code: 'runtime-not-mounted' };
      const occurrenceId = String(input.occurrenceId ?? '').trim();
      const revision = Number(input.revision);
      if (!occurrenceId) return { ok: false, code: 'not-found' };
      if (!Number.isFinite(revision)) return { ok: false, code: 'revision-changed' };
      let result;
      try {
        result = handle.markOccurrenceDispatched({
          ...identityOf(input),
          occurrenceId,
          revision,
          at: Number(input.at ?? now()),
          receipt: typeof input.receipt === 'string' ? input.receipt : JSON.stringify(input.receipt ?? '').slice(0, 200),
          consumer: 'reminders',
        });
      } catch (error) {
        return { ok: false, code: String(error?.code ?? 'agenda-failed') };
      }
      if (!result || result.ok !== true) {
        const code = String(result?.code ?? 'agenda-failed');
        return { ok: false, code: code === 'agenda-disabled' ? 'disabled' : code };
      }
      return { ok: true, revision: Number(result.revision) };
    },

    /**
     * What this port can and cannot do. `reminderDelivery` is `not-wired` **by design**: this port
     * answers questions and keeps the book; it never sends.
     */
    describe() {
      const handle = runtime();
      return {
        service: 'companion:agenda',
        timeZone: zone,
        mounted: Boolean(handle),
        methods: ['createSchedule', 'casOccurrence', 'markOccurrenceDispatched', 'nextOccurrence'],
        reminderDelivery: 'not-wired',
        note: 'schedules are plans; delivery stays with the reminder channel (CONTRACT §13.8)',
      };
    },
  };
}
