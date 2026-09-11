import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { WatchMultiplexer, Watch, WatchError, CoalesceBuffer } from '../src/watch.js'

const rec = (record, after, changed) => ({ type: 'record/update', record, after, changed })

// These frames are the EXACT shapes the live server emits on /data/events
// (captured from a running server). Records are FAT (record-xid + before/after,
// snake_case attr names); relations are THIN (data:[subscribed, other]); the
// coalesced pokes are entity/touched + relation/touched. This suite covers the
// _shape transform, the _dispatch guards, and the Watch._matches filter — ~1.4k
// lines of the SDK's hardest code that previously had no dedicated unit test.

// A multiplexer with schema:false uses no client and opens no SSE — so _shape
// runs in isolation. resolver is null → before/after pass through verbatim.
const mux = () => new WatchMultiplexer({}, { schema: false })

describe('WatchMultiplexer._shape', () => {
  test('record/insert → record + after + changed, no before', async () => {
    const ev = await mux()._shape({
      type: 'record/insert', 'record-xid': 'u-1',
      after: { name: 'Alice', release_year: 1995 },
      ts: 't', txid: 1, actor: 'a-1', request: null, tenant: 'T', scope: null,
    })
    assert.equal(ev.type, 'record/insert')
    assert.equal(ev.record, 'u-1')
    assert.deepEqual(ev.after, { name: 'Alice', release_year: 1995 })
    assert.equal(ev.before, undefined)
    assert.deepEqual(ev.changed, ['name', 'release_year'])
    // provenance carried through
    assert.deepEqual(
      { ts: ev.ts, txid: ev.txid, actor: ev.actor, tenant: ev.tenant, scope: ev.scope },
      { ts: 't', txid: 1, actor: 'a-1', tenant: 'T', scope: null },
    )
    // server never sends an entity name / element on record deltas
    assert.equal(ev.entity, undefined)
    assert.equal(ev.element, undefined)
  })

  test('record/update → changed lists ONLY the keys that differ', async () => {
    const ev = await mux()._shape({
      type: 'record/update', 'record-xid': 'u-1',
      before: { name: 'Jumanji', release_year: 1995 },
      after: { name: 'Jumanji *', release_year: 1995 },
      ts: 't', txid: 2,
    })
    assert.equal(ev.record, 'u-1')
    assert.deepEqual(ev.changed, ['name'], 'release_year unchanged → excluded')
    assert.deepEqual(ev.before, { name: 'Jumanji', release_year: 1995 })
    assert.deepEqual(ev.after, { name: 'Jumanji *', release_year: 1995 })
  })

  test('record/delete → before only, changed = keys of before', async () => {
    const ev = await mux()._shape({
      type: 'record/delete', 'record-xid': 'r-1', before: { name: 'Admin' }, ts: 't',
    })
    assert.equal(ev.record, 'r-1')
    assert.deepEqual(ev.before, { name: 'Admin' })
    assert.equal(ev.after, undefined)
    assert.deepEqual(ev.changed, ['name'])
  })

  test('before/after keys pass through VERBATIM (snake_case leak — keyFormat is not applied)', async () => {
    const ev = await mux()._shape({
      type: 'record/insert', 'record-xid': 'm-1', after: { release_year: 2001 }, ts: 't',
    })
    // Documents the current contract: _shape does NOT kebab/camel delta keys,
    // so `release_year` leaks even though /data returns `release-year`.
    assert.deepEqual(Object.keys(ev.after), ['release_year'])
  })

  test('relation/link → data tuple, no record field', async () => {
    const ev = await mux()._shape({
      type: 'relation/link', data: ['u-1', 'm-9'], ts: 't', txid: 3, actor: 'a-1',
    })
    assert.equal(ev.type, 'relation/link')
    assert.deepEqual(ev.data, ['u-1', 'm-9'])
    assert.equal(ev.record, undefined)
    assert.equal(ev.txid, 3)
  })

  test('relation/unlink → data tuple', async () => {
    const ev = await mux()._shape({ type: 'relation/unlink', data: ['u-1', 'm-9'], ts: 't' })
    assert.equal(ev.type, 'relation/unlink')
    assert.deepEqual(ev.data, ['u-1', 'm-9'])
  })

  test('entity/touched → {type, entity, ts} only (coalesced poke, no provenance)', async () => {
    const ev = await mux()._shape({ type: 'entity/touched', entity: 'Movie', ts: 't', txid: 9 })
    assert.deepEqual(ev, { type: 'entity/touched', entity: 'Movie', ts: 't' })
  })

  test('relation/touched → {type, relation, ts} only', async () => {
    const ev = await mux()._shape({ type: 'relation/touched', relation: 'Movie.actors', ts: 't' })
    assert.deepEqual(ev, { type: 'relation/touched', relation: 'Movie.actors', ts: 't' })
  })
})

describe('WatchMultiplexer._dispatch guards', () => {
  test('drops envelopes whose type is missing or not track/op shaped', async () => {
    const m = mux()
    const seen = []
    m._watches.add({ _matches: () => true, _pushEvent: (e) => seen.push(e) })
    await m._dispatch({ type: 'garbage' })      // no '/'
    await m._dispatch({ nope: true })           // no type
    await m._dispatch({ type: 42 })             // non-string
    assert.equal(seen.length, 0)
  })

  test('shapes then delivers only to watches whose _matches returns true', async () => {
    const m = mux()
    const yes = []
    const no = []
    m._watches.add({ _matches: () => true, _pushEvent: (e) => yes.push(e) })
    m._watches.add({ _matches: () => false, _pushEvent: (e) => no.push(e) })
    await m._dispatch({ type: 'record/insert', 'record-xid': 'u-1', after: { a: 1 }, ts: 't' })
    assert.equal(yes.length, 1)
    assert.equal(yes[0].record, 'u-1')
    assert.equal(no.length, 0)
  })
})

// Fake mux so a Watch constructs without registering against a live multiplexer
// (no SSE, no client). _matches is a pure function of the interest.
const fakeMux = () => ({ register() {}, unregister() {}, notifyInterestChanged() {} })

describe('Watch._matches (per-watch filter)', () => {
  test('record events match by record-xid membership', () => {
    const w = new Watch(fakeMux(), { records: ['u-1', 'u-2'] })
    assert.equal(w._matches({ type: 'record/update', 'record-xid': 'u-1' }), true)
    assert.equal(w._matches({ type: 'record/delete', 'record-xid': 'u-9' }), false)
  })

  test('relation events match on data[0] (the subscribed endpoint) only', () => {
    const w = new Watch(fakeMux(), { records: ['u-1'] })
    assert.equal(w._matches({ type: 'relation/link', data: ['u-1', 'x'] }), true)
    assert.equal(w._matches({ type: 'relation/link', data: ['x', 'u-1'] }), false, 'position 1 does not count')
    assert.equal(w._matches({ type: 'relation/link', data: ['y', 'z'] }), false)
  })

  test('ops filter narrows record events by operation', () => {
    const w = new Watch(fakeMux(), { records: ['u-1'], ops: ['update'] })
    assert.equal(w._matches({ type: 'record/update', 'record-xid': 'u-1' }), true)
    assert.equal(w._matches({ type: 'record/insert', 'record-xid': 'u-1' }), false)
  })

  test('entity/touched matches the entity track by literal name', () => {
    const w = new Watch(fakeMux(), { entities: ['Movie'] })
    assert.equal(w._matches({ type: 'entity/touched', entity: 'Movie' }), true)
    assert.equal(w._matches({ type: 'entity/touched', entity: 'User' }), false)
  })

  test('an empty interest throws EMPTY_INTEREST', () => {
    assert.throws(() => new Watch(fakeMux(), {}), (e) => e instanceof WatchError && e.code === 'EMPTY_INTEREST')
  })
})

describe('CoalesceBuffer — backpressure modes', () => {
  test('coalesce merges repeated record/* for the same record into one entry', async () => {
    const buf = new CoalesceBuffer({ mode: 'coalesce', size: 100 })
    buf.push(rec('u-1', { n: 1 }, ['n']))
    buf.push(rec('u-1', { n: 2 }, ['n']))
    const first = await buf.next()
    assert.equal(first.value.after.n, 2, 'latest after wins')
    // Only ONE entry should remain — a second read must block (nothing queued).
    const race = await Promise.race([
      buf.next().then((v) => ({ got: v })),
      new Promise((r) => setTimeout(() => r('EMPTY'), 30)),
    ])
    assert.equal(race, 'EMPTY', 'the two updates coalesced into a single queued event')
  })

  test('coalesce merges before(earliest)+after(latest)+union(changed)', async () => {
    const buf = new CoalesceBuffer({ mode: 'coalesce' })
    buf.push({ type: 'record/update', record: 'u-1', before: { a: 0, b: 0 }, after: { a: 1, b: 0 }, changed: ['a'] })
    buf.push({ type: 'record/update', record: 'u-1', before: { a: 1, b: 0 }, after: { a: 1, b: 9 }, changed: ['b'] })
    const { value } = await buf.next()
    assert.deepEqual(value.before, { a: 0, b: 0 }, 'earliest before preserved')
    assert.deepEqual(value.after, { a: 1, b: 9 }, 'latest after wins')
    assert.deepEqual([...value.changed].sort(), ['a', 'b'], 'changed unioned')
  })

  test('coalesce: record/delete supersedes a pending update', async () => {
    const buf = new CoalesceBuffer({ mode: 'coalesce' })
    buf.push({ type: 'record/update', record: 'u-1', after: { n: 1 } })
    buf.push({ type: 'record/delete', record: 'u-1', before: { n: 1 } })
    const { value } = await buf.next()
    assert.equal(value.type, 'record/delete')
  })

  test('coalesce keeps distinct records in FIFO order', async () => {
    const buf = new CoalesceBuffer({ mode: 'coalesce' })
    buf.push(rec('u-1', { n: 1 }))
    buf.push(rec('u-2', { n: 1 }))
    assert.equal((await buf.next()).value.record, 'u-1')
    assert.equal((await buf.next()).value.record, 'u-2')
  })

  test('coalesce stays consistent after consuming from the head', async () => {
    // Regression guard for index bookkeeping: consume u-1, then a later u-2
    // update must still coalesce onto the queued u-2 (not land at a stale slot).
    const buf = new CoalesceBuffer({ mode: 'coalesce' })
    buf.push(rec('u-1', { n: 1 }))
    buf.push(rec('u-2', { n: 1 }))
    assert.equal((await buf.next()).value.record, 'u-1')   // shift the head
    buf.push(rec('u-2', { n: 2 }))                          // must merge onto queued u-2
    const { value } = await buf.next()
    assert.equal(value.record, 'u-2')
    assert.equal(value.after.n, 2)
    const race = await Promise.race([
      buf.next().then(() => 'GOT'),
      new Promise((r) => setTimeout(() => r('EMPTY'), 30)),
    ])
    assert.equal(race, 'EMPTY', 'u-2 coalesced — no stale duplicate left behind')
  })

  test('lossless: overflow emits a single paused sentinel then drops', async () => {
    const buf = new CoalesceBuffer({ mode: 'lossless', size: 2 })
    // distinct records so nothing coalesces
    buf.push(rec('a', { n: 1 }))
    buf.push(rec('b', { n: 1 }))
    buf.push(rec('c', { n: 1 }))   // overflow → paused
    buf.push(rec('d', { n: 1 }))   // already paused → dropped silently
    const types = [(await buf.next()).value, (await buf.next()).value, (await buf.next()).value]
    assert.deepEqual(types.map((e) => e.record ?? e.type), ['a', 'b', 'paused'])
  })

  test('sliding: overflow drops the oldest, keeps newest', async () => {
    const buf = new CoalesceBuffer({ mode: 'sliding', size: 2 })
    buf.push(rec('a', { n: 1 }))
    buf.push(rec('b', { n: 1 }))
    buf.push(rec('c', { n: 1 }))   // drops 'a'
    assert.equal((await buf.next()).value.record, 'b')
    assert.equal((await buf.next()).value.record, 'c')
  })
})

// Fake client: the multiplexer consumes client.listen() (async generator) and
// POSTs client.setSubscriptions(items). We stub both so fusion can be observed
// with no network.
function fakeClient() {
  const calls = []
  let abort
  return {
    calls,
    async setSubscriptions(items) { calls.push(items) },
    async *listen({ signal }) {
      yield { type: 'sse/open' }   // handshake — unblocks the mux's first flush
      await new Promise((res) => {
        if (signal.aborted) return res()
        abort = res
        signal.addEventListener('abort', res, { once: true })
      })
    },
    _stop() { abort?.() },
  }
}

// Drain queued microtasks + timers so the debounced/serialized flush settles.
const settle = () => new Promise((r) => setTimeout(r, 10))

describe('WatchMultiplexer — fusion (N watches → 1 SSE + 1 consolidated POST)', () => {
  test('two watches fuse into one setSubscriptions carrying the union', async () => {
    const client = fakeClient()
    const mux = new WatchMultiplexer(client, { schema: false })
    const w1 = new Watch(mux, { records: ['u-1'] })
    const w2 = new Watch(mux, { records: ['u-2'] })
    await settle()
    assert.equal(client.calls.length, 1, 'exactly one consolidated POST for both watches')
    assert.deepEqual(client.calls[0], [{ type: 'data', records: ['u-1', 'u-2'] }])
    w1.close(); w2.close(); mux.close()
  })

  test('add() re-flushes the grown union', async () => {
    const client = fakeClient()
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle()
    assert.deepEqual(client.calls.at(-1), [{ type: 'data', records: ['u-1'] }])
    w.add(['u-9'])
    await settle()
    assert.deepEqual(client.calls.at(-1), [{ type: 'data', records: ['u-1', 'u-9'] }])
    w.close(); mux.close()
  })

  test('closing the last watch POSTs an empty subscription set', async () => {
    const client = fakeClient()
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle()
    w.close()
    await settle()
    assert.deepEqual(client.calls.at(-1), [], 'server told to drop everything we held')
    mux.close()
  })
})
