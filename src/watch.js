/**
 * Live data primitive — `client.watch()` and `client.watchSchema()`.
 *
 * Design:
 *
 *   - Client opens many `watch()`es; SDK fuses them onto ONE SSE
 *     connection and ONE consolidated POST /data/subscription/set.
 *   - Each Watch yields a thin, schema-resolved event stream.
 *   - `before`/`after` keys are resolved from attr-xid → attribute-name
 *     using a SchemaResolver fed by `client.schema()`; refreshed on
 *     `runtime-model` deploy events.
 *   - Coalesce-per-record by default — multiple pending updates on the
 *     same record collapse to the latest `after`. No silent UI drift
 *     across records; consumers can pick `lossless` or `sliding` modes
 *     when they want different.
 *   - Fresh AsyncIterator per `for await` so multiple consumers can
 *     share one Watch (e.g. siblings in a component tree).
 *   - Reconnect is transparent; consumer sees a `connection/resumed`
 *     sentinel on the same stream.
 *
 * This module covers the `watch(interest)` primitive and its schema
 * resolver. The higher-level `watchQuery` / `watchSqlTemplate` build on
 * it and live in watch-query.js.
 */

// ============================================================================
// Errors
// ============================================================================

export class WatchError extends Error {
  constructor(message, code, details) {
    super(message)
    this.name = 'WatchError'
    this.code = code
    this.details = details
  }
}

// ============================================================================
// Schema resolver — attr-xid → attribute-name, entity-xid → entity-name
// ============================================================================

/**
 * Lazy cache: fetches `client.schema()` once per client, parses out the
 * xid maps, refreshes on `runtime-model` deploy events. One per client.
 *
 * `schema` is plain JSON, IAM-projected, and carries
 * `:xid` per entity + `:xids {:attributes, :relations}` map — exactly
 * what the resolver needs to translate plug envelopes (which key
 * `before`/`after` by attribute xid) back to attribute names.
 *
 * @private
 */
class SchemaResolver {
  constructor(client) {
    this._client = client
    this._loaded = false
    this._loading = null              // in-flight promise; coalesces concurrent waiters
    this._attrXidToName = new Map()   // 'JAN1Rh8…' → 'title'
    this._tableXidToName = new Map()  // 'CuquTM…' → 'movie'
    this._nameToTableXid = new Map()  // 'movie'   → 'CuquTM…'
    this._relsByEntity = new Map()    // entity-xid → [relation-xid]; both directions
  }

  /** Best-effort: returns the cached map; loads if not yet loaded. */
  async ensureLoaded() {
    if (this._loaded) return
    if (!this._loading) this._loading = this._fetch()
    await this._loading
  }

  /** Force a refresh (called on `runtime-model` deploy events). */
  async refresh() {
    this._loading = this._fetch()
    await this._loading
  }

  async _fetch() {
    try {
      // /schema is the SDK introspection surface — plain JSON, IAM-projected,
      // includes xid maps as of the schema-xid-augment landing. Source is
      // the runtime model (deployed + identity + audit + reference relations)
      // so we cover everything the wire actually emits.
      //
      // Shape:
      //   { 'id-key',
      //     entities: { '<kebab-name>': {
      //       name, xid,
      //       attributes: {<kebab-attr>: type-string},
      //       relations:  {<label>:     {to, cardinality}},
      //       constraints, xids: {attributes, relations} }}}
      const schema = await this._client.schema()
      const attr = new Map()
      const table = new Map()
      const nameToTable = new Map()
      const relsByEntity = new Map()

      const entities = schema?.entities ?? {}
      for (const [name, entity] of Object.entries(entities)) {
        const xid = entity?.xid
        if (xid) {
          table.set(String(xid), name)
          nameToTable.set(name, String(xid))
        }
        const attrXids = entity?.xids?.attributes ?? {}
        for (const [attrName, attrXid] of Object.entries(attrXids)) {
          if (attrXid) attr.set(String(attrXid), attrName)
        }
        const relXids = entity?.xids?.relations ?? {}
        const xids = Object.values(relXids).map(String).filter(Boolean)
        if (xid && xids.length) {
          const existing = relsByEntity.get(String(xid)) ?? []
          // Each side of a relation references the same xid; Set dedupes
          // when a future caller fuses across entities.
          relsByEntity.set(String(xid), [...new Set([...existing, ...xids])])
        }
      }

      this._attrXidToName = attr
      this._tableXidToName = table
      this._nameToTableXid = nameToTable
      this._relsByEntity = relsByEntity
      this._loaded = true
    } catch (e) {
      // Don't poison the cache on transient failure; next ensureLoaded retries.
      this._loading = null
      throw e
    }
  }

  /** Lookup; returns the xid string back if no mapping exists yet. */
  attrName(xid) {
    return this._attrXidToName.get(String(xid)) ?? String(xid)
  }
  entityName(xid) {
    return this._tableXidToName.get(String(xid)) ?? null
  }
  /** Kebab-case entity-name → entity-xid; null if not found. */
  entityXidByName(name) {
    return this._nameToTableXid.get(kebab(name)) ?? null
  }
  /** All relation xids that have `entityXid` on either from or to side. */
  relationsForEntity(entityXid) {
    if (!entityXid) return []
    return this._relsByEntity.get(String(entityXid)) ?? []
  }
  /** True if the resolver successfully populated its maps. */
  isLoaded() { return this._loaded }
}

function kebab(s) {
  if (s == null) return null
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

// ============================================================================
// Coalescing buffer — one per AsyncIterator
// ============================================================================

/**
 * Append-and-await queue with coalescing semantics:
 *   - 'coalesce' (default): updates on the same record collapse;
 *      delete supersedes prior updates; relations + adds always preserved
 *   - 'lossless':           every event preserved; emits a 'paused'
 *                            sentinel if `bufferSize` is exceeded
 *   - 'sliding':            drop oldest when full (legacy SSE behaviour)
 *
 * @private
 */
export class CoalesceBuffer {
  constructor({ mode = 'coalesce', size = 100 } = {}) {
    this._mode = mode
    this._size = size
    this._queue = []                // ordered events
    this._byRecord = new Map()      // record-xid → queue index (for coalesce)
    this._waiters = []              // pending resolvers when buffer is empty
    this._closed = false
    this._paused = false
  }

  push(ev) {
    if (this._closed) return
    if (this._mode === 'coalesce' && ev.type?.startsWith('record/')) {
      const xid = ev.record
      const existing = this._byRecord.get(xid)
      if (existing !== undefined) {
        const prev = this._queue[existing]
        if (ev.type === 'record/delete') {
          // Delete supersedes — replace prior in place.
          this._queue[existing] = ev
          return this._wake()
        }
        if (prev.type === 'record/delete') return                // delete already wins
        // Merge updates: latest 'after' wins; union 'changed'; keep earliest
        // 'before' so the diff reflects "what the consumer last saw" → "current".
        this._queue[existing] = {
          ...ev,
          before: prev.before ?? ev.before,
          changed: unionChanged(prev.changed, ev.changed),
        }
        return this._wake()
      }
    }
    if (this._queue.length >= this._size) {
      if (this._mode === 'sliding') {
        const dropped = this._queue.shift()
        this._reindexAfterShift(dropped)
      } else if (this._mode === 'lossless') {
        if (!this._paused) {
          this._paused = true
          this._queue.push({ type: 'paused' })
          return this._wake()
        }
        return                                                   // already paused; drop silently
      }
    }
    if (ev.type?.startsWith('record/')) this._byRecord.set(ev.record, this._queue.length)
    this._queue.push(ev)
    this._paused = false
    this._wake()
  }

  async next() {
    if (this._queue.length) return this._shift()
    if (this._closed) return { done: true }
    return new Promise((resolve) => this._waiters.push(resolve))
  }

  close() {
    this._closed = true
    for (const w of this._waiters) w({ done: true })
    this._waiters = []
  }

  _shift() {
    const ev = this._queue.shift()
    // Any shift decrements every following index, so rebuild the coalesce map
    // whenever we're tracking one — not only when the shifted event was a
    // record event (a shifted relation/poke still invalidates record indices).
    if (this._mode === 'coalesce') this._reindexAfterShift(ev)
    return { value: ev, done: false }
  }

  _reindexAfterShift(_ev) {
    // Recompute the index map cheaply: walk the (now-shorter) queue.
    // Sized for typical UI buffers (<100); not worth a doubly-linked map.
    this._byRecord.clear()
    for (let i = 0; i < this._queue.length; i++) {
      const e = this._queue[i]
      if (e?.type?.startsWith('record/')) this._byRecord.set(e.record, i)
    }
  }

  _wake() {
    while (this._waiters.length && this._queue.length) {
      const w = this._waiters.shift()
      w(this._shift())
    }
  }
}

function unionChanged(a, b) {
  if (!a) return b
  if (!b) return a
  const set = new Set(a)
  for (const x of b) set.add(x)
  return [...set]
}

// ============================================================================
// WatchMultiplexer — one per client. Owns the single SSE + the union set.
// ============================================================================

/**
 * Internal state for one client:
 *   - the single SSE session
 *   - the union of all live Watches' interests
 *   - the list of live Watches (with their interests + iterators)
 *   - the schema resolver
 *
 * @private
 */
export class WatchMultiplexer {
  constructor(client, { schema = true, keepAlive = false } = {}) {
    this._client = client
    this._wantSchema = schema
    // When true, the SSE stays open even when the user-watch set is empty.
    // Set by `createClient({ keepAlive: true })` for long-lived servers
    // (BFFs, services) where dropping to zero watches and tearing the
    // SSE down would lose plug session state keyed by [sub, client_id].
    this._keepAlive = keepAlive
    this._watches = new Set()
    this._sseAbort = null
    this._ssePromise = null
    this._flushScheduled = false
    this._flushInflight = null        // promise chain — serialize POSTs
    this._lastUnion = null            // for change detection
    // True once the SSE fetch has handshaken at least once. Before this,
    // any /data/subscription/set POST would race the server's stream
    // creation; the sse/open sentinel branch in _runSse does the initial
    // flush. After this, the SDK SSE is established (or in a reconnect
    // loop) and it's safe for register/unregister/interest-change to
    // schedule flushes directly.
    this._sseEverOpened = false
    this._resolver = schema ? new SchemaResolver(client) : null
    // Warm the resolver eagerly when schema is wanted — design call:
    // events resolve from the first one rather than racing the first
    // event. Failures are non-fatal; events become {unresolved: true}.
    if (this._resolver) this._resolver.ensureLoaded().catch(() => {})
    // Eagerly open the SSE when keepAlive is on so the [sub, client_id]
    // plug session lands BEFORE the first user watch races to use it.
    if (this._keepAlive) this._ensureSseOpen()
  }

  /** Internal — the SchemaResolver feeding event name resolution. */
  get resolver() { return this._resolver }

  register(watch) {
    this._watches.add(watch)
    this._ensureSseOpen()
    // If the SSE has been opened at least once, the server already has a
    // bound session and it's safe to POST the new union immediately.
    // For the very first register (SSE not yet open), the flush is
    // deferred to the sse/open sentinel branch in _runSse — that avoids
    // racing the fetch handshake and having the subscription dropped.
    if (this._sseEverOpened) this._scheduleFlush()
  }

  unregister(watch) {
    if (!this._watches.delete(watch)) return
    this._scheduleFlush()
    // keepAlive holds the SSE open across empty-watch windows so the
    // server-side plug session (keyed by [sub, client_id]) isn't
    // torn down between user watches. Release explicitly via client.close().
    if (this._watches.size === 0 && !this._keepAlive) this._closeSse()
  }

  /**
   * Explicit teardown. Closes every live watch, releases the keepAlive
   * hold, and tears the SSE down. Called by `client.close()`.
   */
  close() {
    this._keepAlive = false
    for (const w of [...this._watches]) {
      try { w.close() } catch { /* ignore */ }
    }
    this._closeSse()
  }

  /** Called by a Watch when its interest changes (add/remove/setInterest). */
  notifyInterestChanged() { this._scheduleFlush() }

  _scheduleFlush() {
    if (this._flushScheduled) return
    this._flushScheduled = true
    queueMicrotask(() => {
      this._flushScheduled = false
      // Serialize: chain the next flush after any in-flight POST so the
      // server always observes the LATEST union last. Without this, two
      // POSTs can race and the smaller (older) union can land last.
      const next = (this._flushInflight ?? Promise.resolve()).then(
        () => this._flush(),
        () => this._flush(),
      )
      this._flushInflight = next
      next.catch((e) => {
        for (const w of this._watches) w._pushSentinel({
          type: 'subscription/rejected',
          reason: e?.message ?? 'set-subscriptions failed',
          records: [],
        })
      }).finally(() => {
        if (this._flushInflight === next) this._flushInflight = null
      })
    })
  }

  async _flush() {
    if (!this._watches.size) {
      // empty union: still POST so server drops what we held
      const items = []
      const sig = JSON.stringify(items)
      if (sig === this._lastUnion) return
      this._lastUnion = sig
      await this._client.setSubscriptions(items)
      return
    }
    // Compute the union across all live Watches. Two distinct things
    // share unfortunate naming:
    //   - i.relationXids — relation-xid Set used LOCALLY by watchQuery
    //     to fan-out per-record relation events (NOT on the wire — the
    //     data track narrows by `records`/`endpoint-xids` server-side).
    //   - i.relations — relation NAME Set ("Movie.actors") for the
    //     new relation track on the wire.
    const records = new Set()
    const entities = new Set()
    const namedRelations = new Set()
    const ops = new Set()
    let anyOps = false
    for (const w of this._watches) {
      const i = w.interest
      if (i.records)   for (const x of i.records)   records.add(x)
      if (i.entities)  for (const e of i.entities)  entities.add(e)
      if (i.relations) for (const r of i.relations) namedRelations.add(r)
      if (i.ops) { anyOps = true; for (const o of i.ops) ops.add(o) }
    }
    // Wire items: one per track that has interest.
    const items = []
    if (records.size) {
      const item = { type: 'data', records: [...records].sort() }
      if (anyOps) item.operations = [...ops].sort()
      items.push(item)
    }
    if (entities.size) {
      items.push({ type: 'entity', entities: [...entities].sort() })
    }
    if (namedRelations.size) {
      items.push({ type: 'relation', relations: [...namedRelations].sort() })
    }
    if (this._wantSchema) items.push({ type: 'runtime-model' })

    const sig = JSON.stringify(items)
    if (sig === this._lastUnion) return
    this._lastUnion = sig
    await this._client.setSubscriptions(items)
  }

  _ensureSseOpen() {
    if (this._ssePromise) return
    const ac = new AbortController()
    this._sseAbort = ac
    this._ssePromise = this._runSse(ac.signal).catch(() => null)
  }

  _closeSse() {
    if (this._sseAbort) {
      // Defer abort() to a microtask so any sync rejections from the
      // signal's listeners (Node 25's AbortController.abort() can
      // surface AbortError through its listener chain) don't escape
      // our caller's stack.
      const ac = this._sseAbort
      queueMicrotask(() => { try { ac.abort() } catch { /* ignore */ } })
    }
    this._sseAbort = null
    this._ssePromise = null
    this._lastUnion = null
  }

  /**
   * Long-lived SSE reader. Uses the client's existing `listen()` to keep
   * one shared reconnect/backoff implementation. On each reconnect we
   * re-flush so server-side state matches our union.
   */
  async _runSse(signal) {
    let firstSession = true
    const debug = typeof process !== 'undefined' && process.env?.SDK_DEBUG
    for (;;) {
      if (signal.aborted) return
      try {
        // No pre-fetch flush — flushing here would POST /subscription/set
        // before the SSE fetch handshake, which is exactly the race we're
        // trying to avoid. Both first session and reconnects flush from
        // the `sse/open` sentinel branch below.
        if (debug) console.log('[sdk-sse] OPEN', { watches: this._watches.size })
        // Use the client's listen() which handles SSE framing + backoff.
        for await (const ev of this._client.listen({ signal })) {
          if (debug) {
            console.log('[sdk-sse] RAW', {
              type: ev?.type,
              recordXid: ev?.['record-xid'],
              data: ev?.data,                  // relation tuple [subscribed, other]
              entity: ev?.entity,              // present on entity/touched poke only
              relation: ev?.relation,          // present on relation/touched poke only
              actor: ev?.actor,
            })
          }
          // SSE handshake landed — NOW it's safe to POST the subscription
          // union (server has created the event stream session). Mark
          // the mux as "SSE-opened-at-least-once" so subsequent
          // register/interest-change can flush directly without racing.
          if (ev?.type === 'sse/open') {
            this._sseEverOpened = true
            this._flush().catch((e) => {
              for (const w of this._watches) w._pushSentinel({
                type: 'subscription/rejected',
                reason: e?.message ?? 'set-subscriptions failed',
                records: [],
              })
            })
            continue
          }
          // Schema deploy notification?
          if (ev?.type === 'runtime-model' || ev?._sseEvent === 'runtime-model') {
            if (this._resolver) {
              this._resolver.refresh()
                .then(() => this._fanOutSentinel({ type: 'schema/changed' }))
                .catch(() => {})
            }
            continue
          }
          if (debug) {
            const matchedWatches = [...this._watches].filter((w) => w._matches(ev))
            console.log('[sdk-sse] DISPATCH', { matched: matchedWatches.length, of: this._watches.size })
          }
          await this._dispatch(ev, firstSession)
        }
      } catch (e) {
        if (signal.aborted) return
        // listen() already retries; if it throws here something is fatal.
        for (const w of this._watches) w._pushSentinel({
          type: 'subscription/rejected',
          reason: e?.message ?? 'sse failed',
          records: [],
        })
        return
      } finally {
        if (!firstSession) this._fanOutSentinel({
          type: 'connection/resumed',
          gap: [null, null],
        })
        firstSession = false
      }
    }
  }

  _fanOutSentinel(sentinel) {
    for (const w of this._watches) w._pushSentinel(sentinel)
  }

  async _dispatch(envelope, _firstSession) {
    const type = envelope?.type
    if (typeof type !== 'string' || !type.includes('/')) return
    const event = await this._shape(envelope)
    if (!event) return
    for (const w of this._watches) {
      if (w._matches(envelope)) w._pushEvent(event)
    }
  }

  /**
   * Translate a raw channel envelope into the user-facing event shape.
   * Resolves attribute xids and (defensively) entity name via the schema
   * resolver. Falls back to {unresolved: true} when the resolver is cold.
   */
  async _shape(env) {
    const [track, op] = env.type.split('/')
    // Coalesced cache-invalidation pokes — entity/touched and
    // relation/touched. Server has stripped everything except the
    // client-supplied original entity (or relation) name + ts; we
    // pass through verbatim so the consumer's literal string round-trips.
    if (env.type === 'entity/touched') {
      return { type: env.type, entity: env.entity, ts: env.ts }
    }
    if (env.type === 'relation/touched') {
      return { type: env.type, relation: env.relation, ts: env.ts }
    }
    // Record-shaped envelopes on the data track (record/insert | update |
    // delete and relation/link | unlink). The server drops modeling-internal
    // decoration (element, entity name, entity-xid, relation label,
    // from-eid/to-eid). before/after keys are already
    // attribute-key keyed; data tuple `[subscribed, other]` carries
    // relation endpoints from the observer's perspective.
    const base = {
      type: env.type,
      ts: env.ts,
      txid: env.txid,
      actor: env.actor,
      request: env.request,
      tenant: env.tenant,
      scope: env.scope,
    }
    if (track === 'record') {
      const before = env.before
      const after = env.after
      const changed = computeChanged(before, after, op)
      const out = { ...base, record: env['record-xid'] }
      if (before) out.before = before
      if (after) out.after = after
      if (changed) out.changed = changed
      return out
    }
    if (track === 'relation') {
      return { ...base, data: env.data }
    }
    return null
  }

  _resolveAttrMap(m) {
    if (!this._resolver) return { ...m }
    const out = {}
    for (const [k, v] of Object.entries(m)) {
      out[this._resolver.attrName(k)] = v
    }
    return out
  }
}

function computeChanged(before, after, op) {
  if (op === 'insert') return after ? Object.keys(after) : null
  if (op === 'delete') return before ? Object.keys(before) : null
  if (!before || !after) return null
  const out = []
  for (const k of Object.keys(after)) {
    if (!shallowEq(before[k], after[k])) out.push(k)
  }
  return out
}

function shallowEq(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  // Strings + numbers + booleans handled by ===; anything else: JSON compare,
  // good enough for change detection on attribute scalars.
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

// ============================================================================
// Watch — public surface
// ============================================================================

/**
 * Live subscription handle. Returned by `client.watch()`.
 *
 * Iterate `watch.events` as many times as you like — each `for await`
 * gets a fresh iterator with its own coalescing buffer, so two
 * consumers (e.g. sibling React components) see the full stream
 * independently. `close()` drops the watch from the multiplex union
 * and closes every iterator.
 */
export class Watch {
  constructor(mux, interest, { backpressure = 'coalesce', bufferSize = 100, signal } = {}) {
    this._mux = mux
    this._interest = normalizeInterest(interest)
    this._iterators = new Set()
    this._closed = false
    this._mutedRequests = new Map()  // request-id → timeoutId
    this._opts = { backpressure, bufferSize }
    this._signal = signal
    if (signal) {
      if (signal.aborted) { this._closed = true; return }
      signal.addEventListener('abort', () => this.close(), { once: true })
    }
    mux.register(this)
  }

  get interest() { return this._interest }
  get closed() { return this._closed }

  add(xids) {
    if (this._closed) return
    if (!xids || !xids.length) return
    const next = new Set(this._interest.records ?? [])
    for (const x of xids) next.add(x)
    this._interest = { ...this._interest, records: [...next] }
    this._mux.notifyInterestChanged()
  }

  remove(xids) {
    if (this._closed) return
    if (!this._interest.records) return
    const set = new Set(this._interest.records)
    for (const x of xids) set.delete(x)
    this._interest = { ...this._interest, records: [...set] }
    this._mux.notifyInterestChanged()
  }

  setInterest(interest) {
    if (this._closed) return
    this._interest = normalizeInterest(interest)
    this._mux.notifyInterestChanged()
  }

  /**
   * Tell the watch to drop the next event carrying this request-id.
   * Used to suppress events caused by writes this client already
   * applied optimistically. Auto-expires after `ttlMs` (default 30s).
   */
  muteRequest(requestId, { ttlMs = 30000 } = {}) {
    if (!requestId) return
    const prior = this._mutedRequests.get(requestId)
    if (prior) clearTimeout(prior)
    const t = setTimeout(() => this._mutedRequests.delete(requestId), ttlMs)
    this._mutedRequests.set(requestId, t)
  }

  close() {
    if (this._closed) return
    this._closed = true
    for (const it of this._iterators) it.buf.close()
    this._iterators.clear()
    for (const t of this._mutedRequests.values()) clearTimeout(t)
    this._mutedRequests.clear()
    this._mux.unregister(this)
  }

  get events() {
    const w = this
    return {
      [Symbol.asyncIterator]() {
        if (w._closed) return { next: async () => ({ done: true }) }
        const buf = new CoalesceBuffer({
          mode: w._opts.backpressure,
          size: w._opts.bufferSize,
        })
        const handle = { buf }
        w._iterators.add(handle)
        return {
          async next() { return buf.next() },
          async return() {
            buf.close()
            w._iterators.delete(handle)
            return { done: true }
          },
        }
      },
    }
  }

  // ── Internal — called by multiplexer ──────────────────────────────────────

  _matches(envelope) {
    const i = this._interest
    // Data-track record events (record/insert | record/update | record/delete):
    if (envelope.type === 'record/insert'
        || envelope.type === 'record/update'
        || envelope.type === 'record/delete') {
      const xid = envelope['record-xid']
      if (i.records?.length && i.records.includes(xid)) return _opMatch(i.ops, envelope.type)
      return false
    }
    // Data-track relation events (relation/link | relation/unlink):
    // Server has rotated so envelope.data = [subscribed-xid, other-xid].
    // Per-watcher we only emit if data[0] is in this watcher's records
    // (when both endpoints are in the identity's union the server sends
    // two events — one per perspective — so each watcher gets the
    // correctly-rotated copy).
    if (envelope.type === 'relation/link' || envelope.type === 'relation/unlink') {
      if (i.records?.length && Array.isArray(envelope.data) && envelope.data.length >= 2) {
        if (i.records.includes(envelope.data[0])) {
          return _opMatch(i.ops, envelope.type)
        }
      }
      return false
    }
    // Entity track — coalesced cache-invalidation poke. The server echoes
    // back the client's original string verbatim, so a literal string
    // match is sufficient — no kebab() normalization needed.
    if (envelope.type === 'entity/touched') {
      if (i.entities?.length) {
        return i.entities.includes(envelope.entity)
      }
      return false
    }
    // Relation track — same echo-back contract as entity/touched. The
    // server preserves the client's original `entity<sep>label` form;
    // literal-string match is sufficient.
    if (envelope.type === 'relation/touched') {
      if (i.relations?.length) {
        return i.relations.includes(envelope.relation)
      }
      return false
    }
    return false
  }

  _pushEvent(event) {
    if (this._closed) return
    if (event.request && this._mutedRequests.has(event.request)) {
      // Consumed: drop the muted record entry so a second event with
      // the same request-id (rare) is not silently dropped.
      const t = this._mutedRequests.get(event.request)
      if (t) clearTimeout(t)
      this._mutedRequests.delete(event.request)
      return
    }
    for (const it of this._iterators) it.buf.push(event)
  }

  _pushSentinel(sentinel) {
    if (this._closed) return
    for (const it of this._iterators) it.buf.push(sentinel)
  }
}

function _opMatch(ops, type) {
  if (!ops || !ops.length) return true
  const op = type.split('/')[1]
  return ops.includes(op)
}

function normalizeInterest(interest) {
  const out = {}
  if (interest?.records) {
    if (!Array.isArray(interest.records)) {
      throw new WatchError('interest.records must be an array', 'INVALID_INTEREST')
    }
    out.records = [...new Set(interest.records)]
  }
  // relations: relation NAMES ("Movie.actors") for the relation track.
  // Goes on the wire as {type:"relation", relations:[...]} and matches
  // server-emitted relation/touched events.
  if (interest?.relations) {
    if (!Array.isArray(interest.relations)) {
      throw new WatchError('interest.relations must be an array', 'INVALID_INTEREST')
    }
    out.relations = [...new Set(interest.relations)]
  }
  // relationXids: relation XIDS used LOCALLY by the data-track matcher
  // for relation/link / relation/unlink envelopes. NOT on the wire —
  // those events fan out per record xid via i.records server-side, and
  // i.relationXids gates the local match.
  if (interest?.relationXids) {
    if (!Array.isArray(interest.relationXids)) {
      throw new WatchError('interest.relationXids must be an array', 'INVALID_INTEREST')
    }
    out.relationXids = [...new Set(interest.relationXids)]
  }
  if (interest?.ops) {
    if (!Array.isArray(interest.ops)) {
      throw new WatchError('interest.ops must be an array', 'INVALID_INTEREST')
    }
    out.ops = [...new Set(interest.ops)]
  }
  if (interest?.entities) {
    if (!Array.isArray(interest.entities)) {
      throw new WatchError('interest.entities must be an array', 'INVALID_INTEREST')
    }
    out.entities = [...new Set(interest.entities)]
  }
  if (!out.records?.length
      && !out.relations?.length
      && !out.relationXids?.length
      && !out.entities?.length) {
    throw new WatchError(
      'watch() requires at least one of: interest.records, interest.entities, interest.relations, interest.relationXids',
      'EMPTY_INTEREST'
    )
  }
  return out
}

// ============================================================================
// SchemaWatch — separate stream of deploy events
// ============================================================================

/**
 * Explicit schema-deploy stream. Yields `{ type: 'schema/changed', schema }`
 * each time a deploy lands. Most apps don't need this — events from
 * `watch()` are already resolved against the live schema.
 */
export class SchemaWatch {
  constructor(mux) {
    this._mux = mux
    this._closed = false
    this._buf = new CoalesceBuffer({ mode: 'lossless', size: 32 })
    this._unsub = (sentinel) => {
      if (sentinel.type === 'schema/changed') this._buf.push(sentinel)
    }
    mux._fanOutSinks = mux._fanOutSinks ?? new Set()
    mux._fanOutSinks.add(this._unsub)
  }

  close() {
    if (this._closed) return
    this._closed = true
    this._buf.close()
    const sinks = this._mux._fanOutSinks
    if (sinks) sinks.delete(this._unsub)
  }

  get events() {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return { async next() { return self._buf.next() } }
      },
    }
  }
}

// ============================================================================
// Public factory — wired onto the client in index.js
// ============================================================================

/**
 * Get (or lazily create) the shared multiplexer for a client.
 * @private
 */
export function getMultiplexer(client) {
  if (!client.__watchMux) {
    client.__watchMux = new WatchMultiplexer(client, {
      schema: client._schemaEnabled !== false,
      // Honor the client-level keepAlive flag set in createClient. Eager
      // SSE open + no teardown on empty-watch windows.
      keepAlive: client._keepAlive === true,
    })
  }
  return client.__watchMux
}

/** Create a new Watch on this client. */
export function watch(client, interest, opts) {
  const mux = getMultiplexer(client)
  return new Watch(mux, interest, opts)
}

/** Create a new SchemaWatch on this client. */
export function watchSchema(client) {
  const mux = getMultiplexer(client)
  return new SchemaWatch(mux)
}
