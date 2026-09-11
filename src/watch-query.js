/**
 * Live query + aggregate primitives — pure compositions on `client.watch()`.
 *
 * Architecture:
 *
 *   1. Run the query / aggregate once to snapshot.
 *   2. Derive interest:
 *        - record-xids from the snapshot — top-level row xids AND xids of
 *          any nested records reached via the selection (so a record/update
 *          on a nested row, e.g. `movie.movie_ratings[i].value`, triggers
 *          a refresh of the parent query).
 *        - relation-xids that could expand the result set (all relations
 *          on the queried entity).
 *   3. Open a single `client.watch({records, relations})` covering both.
 *      This fuses onto the client's shared SSE + setSubscriptions POST.
 *   4. On any event in the watch set, coalesced re-run of the query
 *      (or aggregate). Diff against last result, emit added/removed/
 *      changed (or 'aggregate/changed' with new value).
 *   5. After each refresh, sync the watch's record set so newly-added
 *      members are watched and dropped members stop being watched.
 *
 * Zero new wire ops. Zero server-side state. SDK is in full control.
 *
 * Trade-off — re-runs the query on each event window: simplest and
 * always correct. (A local predicate check against the event's `after`
 * map could skip the HTTP for entity-scalar predicates; not currently
 * done.)
 *
 * Cost coalescing — events arriving within REFRESH_COALESCE_MS collapse
 * to one refresh. A burst of 100 events still produces at most a few
 * refreshes (each takes one /data round-trip).
 */

import { getMultiplexer, WatchError } from './watch.js'

const REFRESH_COALESCE_MS = 50

// ============================================================================
// EventBuffer — unbounded async queue feeding the public iterator
// ============================================================================

class EventBuffer {
  constructor() {
    this._queue = []
    this._waiters = []
    this._closed = false
  }
  push(ev) {
    if (this._closed) return
    if (this._waiters.length) {
      this._waiters.shift()({ value: ev, done: false })
    } else {
      this._queue.push(ev)
    }
  }
  close() {
    this._closed = true
    while (this._waiters.length) this._waiters.shift()({ done: true })
  }
  iterator() {
    const buf = this
    return {
      next() {
        if (buf._queue.length) {
          return Promise.resolve({ value: buf._queue.shift(), done: false })
        }
        if (buf._closed) return Promise.resolve({ done: true })
        return new Promise((resolve) => buf._waiters.push(resolve))
      },
      return() {
        return Promise.resolve({ done: true })
      },
    }
  }
}

// ============================================================================
// Row utilities — diff + equality (JSON-based)
// ============================================================================

function rowKey(r) { return r?.xid ?? r?.euuid ?? null }

// Walk the result tree and collect every xid found — top-level + nested.
// Used to widen the watch's records interest so record/update events on
// nested records (e.g. a rating's value) reach the parent QueryWatch and
// trigger a refresh. Plug gates by record set on its end, so a
// wider local interest doesn't widen the wire union beyond what we ask.
function collectAllXids(rows) {
  const out = new Set()
  const visit = (v) => {
    if (v == null) return
    if (Array.isArray(v)) { for (const e of v) visit(e); return }
    if (typeof v !== 'object') return
    if (typeof v.xid === 'string') out.add(v.xid)
    for (const k of Object.keys(v)) {
      if (k === 'xid') continue
      visit(v[k])
    }
  }
  for (const r of rows) visit(r)
  return out
}

function shallowEq(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

function rowsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!shallowEq(a[k], b[k])) return false
  return true
}

function diffRow(before, after) {
  const changed = []
  const beforeMap = {}
  const afterMap = {}
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const k of keys) {
    if (!shallowEq(before?.[k], after?.[k])) {
      changed.push(k)
      beforeMap[k] = before?.[k]
      afterMap[k] = after?.[k]
    }
  }
  return { changed, beforeMap, afterMap }
}

// ============================================================================
// QueryWatch — live result-set
// ============================================================================

export class QueryWatch {
  constructor(client, kind, queryArgs, opts = {}) {
    this._client = client
    this._kind = kind                  // 'search' | 'xsql'
    this._query = queryArgs            // { entity, args, selection } or { xsql, params, opts }
    this._opts = opts
    this._records = new Map()          // xid → record
    this._initial = null
    this._watch = null
    this._buf = new EventBuffer()
    this._closed = false
    this._coalesceTimer = null
    this._refreshInflight = false
    this._refreshAgain = false
    // Capture bootstrap failure without re-throwing — un-awaited _readyPromise
    // used to surface as an unhandled rejection, forcing BFFs to install a
    // process-wide AbortError swallow. ready() throws on demand instead.
    this._readyError = null
    this._readyPromise = this._bootstrap().catch((e) => {
      this._readyError = e
      this._buf.push({ type: 'subscription/rejected',
        reason: e?.message ?? 'bootstrap failed', records: [] })
    })
    // Honor opts.signal so callers can cancel the watch via AbortController.
    if (opts.signal) {
      if (opts.signal.aborted) { this.close(); return }
      opts.signal.addEventListener('abort', () => this.close(), { once: true })
    }
  }

  async _bootstrap() {
    // 1. Warm the schema resolver — we need entity + relation xids.
    const mux = getMultiplexer(this._client)
    if (mux.resolver) await mux.resolver.ensureLoaded()

    // 2. Compute relation interest from the entity name.
    const entityXid = mux.resolver?.entityXidByName(this._query.entity) ?? null
    const relationXids = entityXid
      ? mux.resolver.relationsForEntity(entityXid)
      : []

    // 3. Snapshot.
    const rows = await this._runQuery()
    for (const r of rows) {
      const xid = rowKey(r)
      if (xid) this._records.set(xid, r)
    }
    this._initial = rows

    // 4. Open the underlying watch. Relations first so we don't miss
    //    link events for new members between snapshot and watch.add.
    //    (The set-replace contract makes this two POSTs; we accept the
    //    minor cost in exchange for the simpler ordering.)
    //    Interest covers top-level + nested xids so updates on either
    //    layer fire a refresh.
    // relationXids gates local matching for relation/link / relation/unlink
    // envelopes; it does NOT add anything to the wire (the data track
    // narrows server-side by record xids and OR-matches relation endpoints).
    const interest = { records: [...collectAllXids(rows)] }
    if (relationXids.length) interest.relationXids = relationXids
    this._watch = this._client.watch(interest)

    // 5. Drain underlying watch events → trigger refresh.
    this._drain()
  }

  async _runQuery() {
    if (this._kind === 'search') {
      const { entity, args, selection } = this._query
      return this._client.search(entity, args, selection, this._opts.searchOpts)
    }
    if (this._kind === 'xsql') {
      const { xsql, params, queryOpts } = this._query
      const r = await this._client.query(xsql, params, queryOpts)
      // get ops return a single record or null; search ops return an array
      return Array.isArray(r) ? r : r ? [r] : []
    }
    return []
  }

  async _drain() {
    try {
      for await (const ev of this._watch.events) {
        if (this._closed) break
        if (typeof ev.type === 'string'
            && (ev.type.startsWith('entity/') || ev.type.startsWith('relation/'))) {
          this._scheduleRefresh(ev)
        } else {
          // sentinels pass through to the QueryWatch consumer
          this._buf.push(ev)
        }
      }
    } catch (e) {
      this._buf.push({ type: 'subscription/rejected',
        reason: e?.message ?? 'underlying watch failed', records: [] })
    }
  }

  _scheduleRefresh(triggeringEvent) {
    if (this._coalesceTimer) return
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = null
      this._refresh(triggeringEvent).catch((e) => {
        this._buf.push({ type: 'subscription/rejected',
          reason: e?.message ?? 'refresh failed', records: [] })
      })
    }, REFRESH_COALESCE_MS)
  }

  async _refresh(triggeringEvent) {
    if (this._refreshInflight) { this._refreshAgain = true; return }
    this._refreshInflight = true
    try {
      const rows = await this._runQuery()
      const prev = this._records
      const next = new Map()
      for (const r of rows) {
        const xid = rowKey(r)
        if (xid) next.set(xid, r)
      }

      const prov = {
        ts: triggeringEvent?.ts,
        txid: triggeringEvent?.txid,
        actor: triggeringEvent?.actor,
        request: triggeringEvent?.request,
      }

      // Added + changed.
      for (const [xid, r] of next) {
        const before = prev.get(xid)
        if (!before) {
          this._buf.push({ type: 'query/added', record: r, ...prov })
        } else if (!rowsEqual(before, r)) {
          const { changed, beforeMap, afterMap } = diffRow(before, r)
          this._buf.push({
            type: 'query/changed', record: r,
            before: beforeMap, after: afterMap, changed,
            ...prov,
          })
        }
      }
      // Removed.
      for (const xid of prev.keys()) {
        if (!next.has(xid)) {
          this._buf.push({ type: 'query/removed', recordXid: xid, ...prov })
        }
      }

      // Update record set + sync the underlying watch interest so new
      // members get entity events and dropped ones stop firing. Sync the
      // full xid tree (top-level + nested) so updates on freshly-arrived
      // nested rows are picked up on the next event window.
      this._records = next
      if (this._watch) {
        this._watch.setInterest({
          records: [...collectAllXids(rows)],
          relationXids: this._watch.interest.relationXids,
        })
      }
    } finally {
      this._refreshInflight = false
      if (this._refreshAgain) {
        this._refreshAgain = false
        this._scheduleRefresh()
      }
    }
  }

  /** First page of rows, ordered as the server returned. Null until ready. */
  get initial() { return this._initial }

  /** Live record map; mutated in place by SDK as events arrive. */
  get records() { return this._records }

  /** Snapshot the current records as an array. */
  list() { return [...this._records.values()] }

  /** Resolves when the initial snapshot + watch are wired. Throws if bootstrap failed. */
  ready() {
    return this._readyPromise.then(() => {
      if (this._readyError) throw this._readyError
    })
  }

  /** Force a fresh server-side re-evaluation. */
  async refresh() { return this._refresh() }

  get events() {
    const self = this
    return {
      [Symbol.asyncIterator]() { return self._buf.iterator() },
    }
  }

  close() {
    if (this._closed) return
    this._closed = true
    if (this._coalesceTimer) clearTimeout(this._coalesceTimer)
    if (this._watch) this._watch.close()
    this._buf.close()
  }
}

// ============================================================================
// Public factories — wired onto the client in index.js
// ============================================================================

/** `client.watchQuery(entity, args, selection, opts?)` */
export function watchQuery(client, entity, args, selection, opts) {
  return new QueryWatch(client, 'search',
    { entity, args, selection }, opts)
}

/** `client.watchQuery.xsql(xsql, params?, opts?)` — XSQL variant. */
watchQuery.xsql = function watchQueryXsql(client, xsql, params, opts) {
  // The xsql path runs `client.query(xsql, params, queryOpts)`. To know
  // which relations to watch we still need the entity name — pass it via
  // `opts.entity`. The server does not infer it from the XSQL.
  const entity = opts?.entity
  if (!entity) {
    throw new Error('watchQuery.xsql requires opts.entity (kebab-case root)')
  }
  return new QueryWatch(client, 'xsql',
    { xsql, params, queryOpts: { ...opts, entity }, entity }, opts)
}

// ============================================================================
// SqlTemplateWatch — live raw-SQL result
//
// Compose `client.sqlTemplate(template, params)` with `client.watch()` so a
// dashboard tile (counts, averages, anything sql-expressible) updates as
// the underlying data changes.
//
// The plug can only subscribe by record-xid or relation-xid — there's
// no entity-firehose. Since raw SQL is opaque to us, the caller must
// declare which entities the SQL reads from via `opts.entities: [...]`.
// We then watch each entity's relation xids (relation/link + /unlink
// cover inserts/deletes). For per-row updates on existing records to
// trigger refresh, pass `opts.records: [...]` explicitly.
// ============================================================================

export class SqlTemplateWatch {
  constructor(client, template, params, opts = {}) {
    this._client = client
    this._template = template
    this._params = params ?? {}
    this._opts = opts
    this._entities  = Array.isArray(opts.entities)  ? opts.entities  : []
    this._relations = Array.isArray(opts.relations) ? opts.relations : []
    if (!this._entities.length && !this._relations.length) {
      throw new WatchError(
        "watchSqlTemplate requires opts.entities and/or opts.relations — " +
        "list the entity names and/or relation names ('Entity.label') " +
        "the SQL reads from (e.g. { entities: ['Movie'], relations: ['Movie.actors'] }).",
        'INVALID_INTEREST',
      )
    }
    this._value = null
    this._buf = new EventBuffer()
    this._watch = null
    this._closed = false
    this._coalesceTimer = null
    this._refreshInflight = false
    this._refreshAgain = false
    this._readyError = null
    this._readyPromise = this._bootstrap().catch((e) => {
      this._readyError = e
      this._buf.push({ type: 'subscription/rejected',
        reason: e?.message ?? 'bootstrap failed', records: [] })
    })
    if (opts.signal) {
      if (opts.signal.aborted) { this.close(); return }
      opts.signal.addEventListener('abort', () => this.close(), { once: true })
    }
  }

  async _bootstrap() {
    // 1. Snapshot the SQL result.
    this._value = await this._client.sqlTemplate(
      this._template, this._params, this._opts.searchOpts,
    )

    // 2. Subscribe via the entity + relation tracks — server matches by
    //    entity-xid / relation-xid and delivers coalesced
    //    `entity/touched` / `relation/touched` pokes (one per name per
    //    100ms window). For per-row update refresh on specific rows
    //    the caller passes `opts.records: [...]`, which adds a data-
    //    track sub running in addition.
    const interest = {}
    if (this._entities.length)  interest.entities  = [...this._entities]
    if (this._relations.length) interest.relations = [...this._relations]
    if (Array.isArray(this._opts.records) && this._opts.records.length) {
      interest.records = [...this._opts.records]
    }
    this._watch = this._client.watch(interest)
    this._drain()
  }

  async _drain() {
    try {
      for await (const ev of this._watch.events) {
        if (this._closed) break
        // Cache-invalidation pokes from the entity / relation tracks
        // (entities / relations interest) — server has coalesced these
        // per name per 100ms window. Plus record-shaped data-track
        // envelopes (record/insert etc., relation/link etc.) when the
        // caller passed opts.records explicitly.
        if (typeof ev.type === 'string'
            && (ev.type === 'entity/touched'
                || ev.type === 'relation/touched'
                || ev.type.startsWith('record/')
                || ev.type.startsWith('relation/'))) {
          this._scheduleRefresh(ev)
        } else {
          this._buf.push(ev)
        }
      }
    } catch (e) {
      this._buf.push({ type: 'subscription/rejected',
        reason: e?.message ?? 'underlying watch failed', records: [] })
    }
  }

  _scheduleRefresh(triggeringEvent) {
    if (this._coalesceTimer) return
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = null
      this._refresh(triggeringEvent).catch((e) => {
        this._buf.push({ type: 'subscription/rejected',
          reason: e?.message ?? 'refresh failed', records: [] })
      })
    }, REFRESH_COALESCE_MS)
  }

  async _refresh(triggeringEvent) {
    if (this._refreshInflight) { this._refreshAgain = true; return }
    this._refreshInflight = true
    try {
      const before = this._value
      const after = await this._client.sqlTemplate(
        this._template, this._params, this._opts.searchOpts,
      )
      this._value = after
      // Result is typically an array of rows; deep-compare via JSON.
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        this._buf.push({
          type: 'result/changed',
          before, after,
          ts: triggeringEvent?.ts,
          txid: triggeringEvent?.txid,
          actor: triggeringEvent?.actor,
          request: triggeringEvent?.request,
        })
      }
    } finally {
      this._refreshInflight = false
      if (this._refreshAgain) {
        this._refreshAgain = false
        this._scheduleRefresh()
      }
    }
  }

  /** Current SQL result (array of rows). */
  get value() { return this._value }
  /** Convenience: first row of the result, or null. */
  get first() { return Array.isArray(this._value) ? this._value[0] ?? null : null }
  ready() {
    return this._readyPromise.then(() => {
      if (this._readyError) throw this._readyError
    })
  }
  async refresh() { return this._refresh() }

  get events() {
    const self = this
    return {
      [Symbol.asyncIterator]() { return self._buf.iterator() },
    }
  }

  close() {
    if (this._closed) return
    this._closed = true
    if (this._coalesceTimer) clearTimeout(this._coalesceTimer)
    if (this._watch) this._watch.close()
    this._buf.close()
  }
}

/** `client.watchSqlTemplate(template, params?, opts?)` */
export function watchSqlTemplate(client, template, params, opts) {
  return new SqlTemplateWatch(client, template, params, opts)
}
