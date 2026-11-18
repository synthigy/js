import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { WatchMultiplexer, Watch, WatchError, CoalesceBuffer } from '../src/watch.js'
import { SynthigyError } from '../src/index.js'

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
// POSTs client._setSubscriptions(items). We stub both so fusion can be observed
// with no network.
function fakeClient() {
  const calls = []
  let abort
  return {
    calls,
    async _setSubscriptions(items) { calls.push(items) },
    async *listen({ signal }) {
      yield { type: 'sse/open', stream: 's-test-1' }   // handshake — unblocks the mux's first flush
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

  test('a reconnect posts the same union again (the engine dropped it with the stream)', async () => {
    const client = fakeClient()
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-test-1' }
      while (!client.calls.length) await settle()
      yield { type: 'sse/open', stream: 's-test-1' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle(); await settle()
    assert.equal(client.calls.length, 2, 'one POST per stream session')
    assert.deepEqual(client.calls[1], client.calls[0])
    w.close(); mux.close()
  })

  test('a reconnect flush waits for the one in flight', async () => {
    const client = fakeClient()
    let inflight = 0, most = 0
    client._setSubscriptions = async (items) => {
      most = Math.max(most, ++inflight)
      await new Promise((r) => setTimeout(r, 20))
      inflight--
      client.calls.push(items)
    }
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-test-1' }
      yield { type: 'sse/open', stream: 's-test-1' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w1 = new Watch(mux, { records: ['u-1'] })
    const w2 = new Watch(mux, { records: ['u-2'] })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(most, 1, 'never two subscription POSTs at once')
    const last = JSON.stringify(client.calls.at(-1))
    assert.ok(last.includes('u-1') && last.includes('u-2'), `the latest union lands last: ${last}`)
    w1.close(); w2.close(); mux.close()
  })

  test('a watch after a refused stream opens a new one', async () => {
    const client = fakeClient()
    let streams = 0
    client.listen = async function* () {
      streams++
      throw new SynthigyError('no', 'ENTITY_FORBIDDEN', undefined, { status: 403 })
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const first = new Watch(mux, { records: ['u-1'] })
    await settle()
    const second = new Watch(mux, { records: ['u-2'] })
    await settle()
    assert.equal(streams, 2, 'the second watch reopened the stream')
    first.close(); second.close(); mux.close()
  })

  test('a watch on every op keeps the op filter off for all', async () => {
    const client = fakeClient()
    const mux = new WatchMultiplexer(client, { schema: false })
    const w1 = new Watch(mux, { records: ['u-1'], ops: ['insert'] })
    await settle()
    assert.deepEqual(client.calls.at(-1)[0].operations, ['insert'])
    const w2 = new Watch(mux, { records: ['u-2'] })
    await settle()
    assert.equal(client.calls.at(-1)[0].operations, undefined, 'u-2 must still get updates and deletes')
    w1.close(); w2.close(); mux.close()
  })

  test('a reconnect tells the watch it resumed', async () => {
    const client = fakeClient()
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-test-1' }
      yield { type: 'sse/open', stream: 's-test-1' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    const it = w.events[Symbol.asyncIterator]()
    const first = await Promise.race([it.next(), new Promise((r) => setTimeout(() => r(null), 1000))])
    assert.equal(first?.value?.type, 'connection/resumed')
    w.close(); mux.close()
  })

  test('backfill asks history about each watched record, so a busy gap cannot crowd them out', async () => {
    const client = fakeClient()
    let reconnect
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-1' }
      yield { type: 'record/update', 'record-xid': 'u-1', ts: '2026-11-18T10:00:00Z', after: { name: 'A' } }
      await new Promise((r) => { reconnect = r })
      yield { type: 'sse/open', stream: 's-2' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const noise = Array.from({ length: 1000 }, (_, i) =>
      ({ 'record-xid': `other-${i}`, op: 'change', ts: '2026-11-18T10:01:00Z', 'attribute-xid': 'name', value: 'x' }))
    client.history = {
      events: async ({ recordXid }) => recordXid
        ? [{ 'record-xid': recordXid, op: 'change', ts: '2026-11-18T10:05:00Z', 'attribute-xid': 'name', value: `${recordXid}!` }]
        : noise,
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1', 'u-2'] }, { backfill: true, backpressure: 'lossless' })
    const it = w.events[Symbol.asyncIterator]()
    const next = () => Promise.race([it.next(), new Promise((r) => setTimeout(() => r({ value: null }), 1000))])
    await next()
    reconnect()
    const replayed = [(await next()).value, (await next()).value].map((e) => [e?.record, e?.after?.name])
    assert.deepEqual(replayed.sort(), [['u-1', 'u-1!'], ['u-2', 'u-2!']])
    w.close(); mux.close()
  })

  test('backfill replays the gap from history before the resumed sentinel', async () => {
    const client = fakeClient()
    let reconnect
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-test-1' }
      yield { type: 'record/update', 'record-xid': 'u-1', ts: '2026-11-18T10:00:00Z', after: { name: 'A' } }
      await new Promise((r) => { reconnect = r })
      yield { type: 'sse/open', stream: 's-test-1' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    let asked
    client.history = {
      events: async (q) => {
        asked = q
        return [
          { 'record-xid': 'u-1', op: 'change', ts: '2026-11-18T09:00:00Z', 'attribute-xid': 'name', value: 'old' },
          { 'record-xid': 'u-1', op: 'change', ts: '2026-11-18T10:05:00Z', 'attribute-xid': 'name', value: 'B' },
          { 'record-xid': 'r-9', op: 'change', ts: '2026-11-18T10:06:00Z', 'attribute-xid': 'name', value: 'X' },
        ]
      },
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] }, { backfill: true, backpressure: 'lossless' })
    const it = w.events[Symbol.asyncIterator]()
    const next = () => Promise.race([it.next(), new Promise((r) => setTimeout(() => r({ value: null }), 1000))])
    assert.equal((await next()).value?.after?.name, 'A')
    reconnect()
    const replayed = (await next()).value
    assert.deepEqual([replayed?.type, replayed?.record, replayed?.after, replayed?.fromBackfill],
      ['record/update', 'u-1', { name: 'B' }, true])
    assert.equal(asked.between[0], '2026-11-18T10:00:00Z', 'the gap starts at the last event seen')
    assert.equal((await next()).value?.type, 'connection/resumed')
    w.close(); mux.close()
  })

  test('live events that arrive during a backfill come after the replay and the resumed sentinel', async () => {
    const client = fakeClient()
    let reconnect
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-test-1' }
      yield { type: 'record/update', 'record-xid': 'u-1', ts: '2026-11-18T10:00:00Z', after: { name: 'A' } }
      await new Promise((r) => { reconnect = r })
      yield { type: 'sse/open', stream: 's-test-1' }
      yield { type: 'record/update', 'record-xid': 'u-1', ts: '2026-11-18T10:10:00Z', after: { name: 'C' } }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    let release
    client.history = {
      events: async () => {
        await new Promise((r) => { release = r })
        return [{ 'record-xid': 'u-1', op: 'change', ts: '2026-11-18T10:05:00Z', 'attribute-xid': 'name', value: 'B' }]
      },
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] }, { backfill: true, backpressure: 'lossless' })
    const it = w.events[Symbol.asyncIterator]()
    const next = () => Promise.race([it.next(), new Promise((r) => setTimeout(() => r({ value: null }), 1000))])
    assert.equal((await next()).value?.after?.name, 'A')
    reconnect()
    while (!release) await settle()
    await settle(); await settle()
    release()
    const got = []
    for (let i = 0; i < 3; i++) { const v = (await next()).value; got.push(v?.type === 'connection/resumed' ? 'resumed' : v?.after?.name) }
    assert.deepEqual(got, ['B', 'resumed', 'C'])
    assert.equal((await Promise.race([it.next(), new Promise((r) => setTimeout(() => r({ value: null }), 100))])).value, null, 'nothing duplicated')
    w.close(); mux.close()
  })

  test('a failed backfill still delivers the live events held during it, after the sentinel', async () => {
    const client = fakeClient()
    let reconnect
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-test-1' }
      yield { type: 'record/update', 'record-xid': 'u-1', ts: '2026-11-18T10:00:00Z', after: { name: 'A' } }
      await new Promise((r) => { reconnect = r })
      yield { type: 'sse/open', stream: 's-test-1' }
      yield { type: 'record/update', 'record-xid': 'u-1', ts: '2026-11-18T10:10:00Z', after: { name: 'C' } }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    let release
    client.history = {
      events: async () => { await new Promise((r) => { release = r }); throw new Error('history down') },
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] }, { backfill: true, backpressure: 'lossless' })
    const it = w.events[Symbol.asyncIterator]()
    const next = () => Promise.race([it.next(), new Promise((r) => setTimeout(() => r({ value: null }), 1000))])
    assert.equal((await next()).value?.after?.name, 'A')
    reconnect()
    while (!release) await settle()
    await settle(); await settle()
    release()
    assert.equal((await next()).value?.type, 'connection/resumed')
    assert.equal((await next()).value?.after?.name, 'C')
    w.close(); mux.close()
  })

  test('every subscription POST names the stream it is for', async () => {
    const client = fakeClient()
    const streams = []
    client._setSubscriptions = async (_items, opts) => { streams.push(opts?.stream) }
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-first' }
      while (!streams.length) await settle()
      yield { type: 'sse/open', stream: 's-second' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle(); await settle()
    assert.deepEqual(streams, ['s-first', 's-second'])
    w.close(); mux.close()
  })

  test('with keepAlive, closing the last watch POSTs an empty subscription set', async () => {
    const client = fakeClient()
    const mux = new WatchMultiplexer(client, { schema: false, keepAlive: true })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle()
    w.close()
    await settle()
    assert.deepEqual(client.calls.at(-1), [], 'server told to drop everything we held')
    mux.close()
  })

  test('without keepAlive, closing the last watch closes the stream instead of posting', async () => {
    const client = fakeClient()
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle()
    const before = client.calls.length
    w.close()
    await settle()
    assert.equal(client.calls.length, before, 'the engine drops a stream\'s set when the stream closes')
    mux.close()
  })

  test('a watch opened after the stream closed waits for the new stream before posting', async () => {
    const client = fakeClient()
    let n = 0
    const streams = []
    client._setSubscriptions = async (_items, opts) => { streams.push(opts?.stream) }
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: `s-${++n}` }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const first = new Watch(mux, { records: ['u-1'] })
    await settle()
    first.close()
    await settle()
    const second = new Watch(mux, { records: ['u-2'] })
    await settle(); await settle()
    assert.deepEqual(streams, ['s-1', 's-2'], 'no POST went out with the closed stream\'s id')
    second.close(); mux.close()
  })

  test('a dead stream refusing an old POST leaves the new stream in charge', async () => {
    const client = fakeClient()
    const posts = []
    let reconnect, release
    client._setSubscriptions = async (items, opts) => {
      posts.push(opts?.stream)
      if (opts?.stream === 's-old' && posts.length > 1) {
        await new Promise((r) => { release = r })
        throw new SynthigyError('gone', 'STREAM_NOT_FOUND', undefined, { status: 400 })
      }
    }
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-old' }
      await new Promise((r) => { reconnect = r })
      yield { type: 'sse/open', stream: 's-new' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle()
    w.add(['u-2'])
    await settle()
    reconnect()
    await settle()
    release()
    await settle(); await settle()
    assert.equal(mux._streamId, 's-new', 'the old refusal did not clear the new id')
    assert.equal(posts.at(-1), 's-new', 'the union went to the new stream')
    w.close(); mux.close()
  })

  test('a union that could not be posted is posted on the next stream', async () => {
    const client = fakeClient()
    const posts = []
    let reconnect
    client._setSubscriptions = async (items, opts) => {
      posts.push([opts?.stream, JSON.stringify(items)])
      if (opts?.stream === 's-1' && posts.length > 1) throw new SynthigyError('gone', 'STREAM_NOT_FOUND', undefined, { status: 400 })
    }
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-1' }
      await new Promise((r) => { reconnect = r })
      yield { type: 'sse/open', stream: 's-2' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle()
    w.add(['u-2'])
    await settle()
    w.add(['u-3'])
    await settle()
    const w2 = new Watch(mux, { records: ['u-3'] })
    let early = false
    w2.subscribed().then(() => { early = true })
    await settle(); await settle()
    assert.equal(early, false, 'nothing reached the engine yet, so the new watch is not subscribed')
    reconnect()
    await settle(); await settle()
    assert.equal(early, true, 'the new stream\'s POST covers it')
    w2.close()
    const last = posts.at(-1)
    assert.equal(last[0], 's-2')
    assert.ok(last[1].includes('u-2') && last[1].includes('u-3'), `the whole union reached the new stream: ${last[1]}`)
    w.close(); mux.close()
  })

  test('after a session ends, a covered new watch waits for the next open', async () => {
    const client = fakeClient()
    const posts = []
    let end, reconnect
    client._setSubscriptions = async (items, opts) => { posts.push(opts?.stream) }
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-1' }
      await new Promise((r) => { end = r })
      yield { type: 'sse/close', stream: 's-1' }
      await new Promise((r) => { reconnect = r })
      yield { type: 'sse/open', stream: 's-2' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const seen = []
    const w = new Watch(mux, { records: ['u-1'] })
    ;(async () => { for await (const ev of w.events) seen.push(ev.type) })()
    await settle()
    end()
    await settle()
    assert.equal(mux._streamId, null, 'the ended stream id is dropped')
    const w2 = new Watch(mux, { records: ['u-1'] })
    let early = false
    w2.subscribed().then(() => { early = true })
    await settle(); await settle()
    assert.equal(early, false, 'the engine holds nothing for the ended stream')
    reconnect()
    await settle(); await settle()
    assert.equal(early, true, 'the next open\'s POST covers it')
    assert.deepEqual(posts, ['s-1', 's-2'])
    assert.ok(!seen.some((t) => t.startsWith('sse/')), `no close sentinel reaches watches: ${seen}`)
    w2.close(); w.close(); mux.close()
  })

  test('a stale close for an older stream keeps the current id', async () => {
    const client = fakeClient()
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-2' }
      yield { type: 'sse/close', stream: 's-1' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle(); await settle()
    assert.equal(mux._streamId, 's-2')
    assert.notEqual(mux._lastUnion, null, 'the posted union is still recorded')
    w.close(); mux.close()
  })

  test('a POST that outlives its stream subscribes nothing until the next open', async () => {
    const client = fakeClient()
    let releasePost, endSession, reopen
    let posts = 0
    client._setSubscriptions = async () => {
      if (++posts === 1) await new Promise((r) => { releasePost = r })
    }
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-1' }
      await new Promise((r) => { endSession = r })
      yield { type: 'sse/close', stream: 's-1' }
      await new Promise((r) => { reopen = r })
      yield { type: 'sse/open', stream: 's-2' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    let subscribed = false
    w.subscribed().then(() => { subscribed = true })
    await settle()
    endSession()
    await settle()
    releasePost()
    await settle()
    assert.equal(subscribed, false, 'the engine dropped s-1 with its set')
    reopen()
    await settle(); await settle()
    assert.equal(subscribed, true, "s-2's POST subscribes it")
    w.close(); mux.close()
  })

  test('a stream the engine no longer has is not reported as a rejected subscription', async () => {
    const client = fakeClient()
    let calls = 0
    client._setSubscriptions = async () => {
      if (++calls === 2) throw new SynthigyError('gone', 'STREAM_NOT_FOUND', undefined, { status: 400 })
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    const seen = []
    ;(async () => { for await (const ev of w.events) seen.push(ev.type) })()
    await settle()
    w.add(['u-2'])
    await settle(); await settle()
    assert.ok(!seen.includes('subscription/rejected'), `no false rejection: ${seen}`)
    assert.equal(mux._streamId, null, 'the dead id is dropped until the next sse/open')
    w.close(); mux.close()
  })

  test('a union equal to the last posted one does not subscribe a watch while no stream is open', async () => {
    const client = fakeClient()
    let reconnect
    let calls = 0
    client._setSubscriptions = async () => {
      if (++calls === 2) throw new SynthigyError('gone', 'STREAM_NOT_FOUND', undefined, { status: 400 })
    }
    client.listen = async function* ({ signal }) {
      yield { type: 'sse/open', stream: 's-1' }
      await new Promise((r) => { reconnect = r })
      yield { type: 'sse/open', stream: 's-2' }
      await new Promise((res) => signal.addEventListener('abort', res, { once: true }))
    }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    await settle()
    w.add(['u-2'])
    await settle()
    assert.equal(mux._streamId, null)
    w.remove(['u-2'])
    const w2 = new Watch(mux, { records: ['u-1'] })
    let early = false
    w2.subscribed().then(() => { early = true })
    await settle(); await settle()
    assert.equal(early, false, 'the engine holds nothing for the new watch')
    reconnect()
    await settle(); await settle()
    assert.equal(early, true, 'the next stream\'s POST covers it')
    w2.close(); w.close(); mux.close()
  })
})

describe('watchQuery.xsql — query options', () => {
  test('searchOpts reach client.query top level with op + entity', async () => {
    const { watchQuery } = await import('../src/watch-query.js')
    let seen
    const client = { query: async (_x, _p, opts) => { seen = opts; return [] } }
    const w = watchQuery.xsql(client, '@search Center\nname', {}, {
      entity: 'center', op: 'search', searchOpts: { actingAs: 'petar' },
    })
    await w._runQuery()
    assert.deepEqual(seen, { actingAs: 'petar', op: 'search', entity: 'center' })
  })
})

describe('QueryWatch refresh triggers', () => {
  test('record/* events on the watched rows re-run the query', async () => {
    const { watchQuery } = await import('../src/watch-query.js')
    const queue = []
    let wake
    const events = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()
          await new Promise((r) => { wake = r })
        }
      },
    }
    let runs = 0
    const client = {
      __watchMux: { resolver: null },
      query: async () => { runs++; return [{ xid: 'A', name: `v${runs}` }] },
      watch: () => ({ events, close() {}, subscribed: async () => {}, interest: {}, setInterest() {} }),
    }
    const w = watchQuery.xsql(client, '@search list\nproject\n  name', {}, { entity: 'project', op: 'search' })
    await w.ready()
    assert.equal(runs, 2, 'snapshot, then one refetch once the subscription holds')
    for (const type of ['record/update', 'entity/touched', 'relation/link', 'connection/resumed']) {
      const before = runs
      queue.push({ type, record: 'A' }); wake?.()
      for (let t = Date.now(); runs === before && Date.now() - t < 2000;) await new Promise((r) => setTimeout(r, 20))
      assert.equal(runs, before + 1, `${type} refreshes`)
    }
    w.close()
  })
})

describe('SqlTemplateWatch refresh triggers', () => {
  test('entity pokes and a reconnect re-run the SQL, and the sentinel passes through', async () => {
    const { watchSqlTemplate } = await import('../src/watch-query.js')
    const queue = []
    let wake
    const events = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()
          await new Promise((r) => { wake = r })
        }
      },
    }
    let runs = 0
    const client = {
      sqlTemplate: async () => { runs++; return [{ n: runs }] },
      watch: () => ({ events, close() {}, subscribed: async () => {}, interest: {}, setInterest() {} }),
    }
    const w = watchSqlTemplate(client, 'SELECT 1', {}, { entities: ['Movie'] })
    await w.ready()
    const passed = []
    ;(async () => { for await (const ev of w.events) passed.push(ev.type) })()
    for (const type of ['entity/touched', 'connection/resumed']) {
      const before = runs
      queue.push({ type, entity: 'Movie' }); wake?.()
      for (let t = Date.now(); runs === before && Date.now() - t < 2000;) await new Promise((r) => setTimeout(r, 20))
      assert.equal(runs, before + 1, `${type} refreshes`)
    }
    assert.ok(passed.includes('connection/resumed'), `sentinel passes through: ${passed}`)
    w.close()
  })
})

describe('QueryWatch subscription gap', () => {
  test('a write between the snapshot and the subscription is in the list at ready()', async () => {
    const { watchQuery } = await import('../src/watch-query.js')
    let subscribe
    const held = new Promise((r) => { subscribe = r })
    let name = 'before'
    const client = {
      __watchMux: { resolver: null },
      query: async () => [{ xid: 'A', name }],
      watch: () => ({ events: { async *[Symbol.asyncIterator]() { await new Promise(() => {}) } }, close() {}, subscribed: () => held, interest: {}, setInterest() {} }),
    }
    const w = watchQuery.xsql(client, '@search list\nproject\n  name', {}, { entity: 'project', op: 'search' })
    let ready = false
    w.ready().then(() => { ready = true })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(ready, false, 'ready waits for the subscription')
    name = 'after'
    subscribe()
    await w.ready()
    assert.equal(w.records.get('A').name, 'after')
    w.close()
  })
})

describe('subscription/rejected carries the error', () => {
  const refusal = () => new SynthigyError('no', 'FORBIDDEN', undefined,
    { hint: 'h', rule: 'stamp', doc: 'errors/stamp' })

  async function nextRejected(it) {
    const deadline = Date.now() + 2000
    for (;;) {
      const left = deadline - Date.now()
      const r = left > 0 && await Promise.race([it.next(), new Promise((res) => setTimeout(() => res(null), left))])
      if (!r || r.done) throw new Error('no subscription/rejected event')
      if (r.value?.type === 'subscription/rejected') return r.value
    }
  }

  function assertCarries(ev) {
    assert.ok(ev.error instanceof SynthigyError)
    assert.equal(ev.reason, ev.error.message)
    assert.deepEqual([ev.error.code, ev.error.hint, ev.error.rule, ev.error.doc],
      ['FORBIDDEN', 'h', 'stamp', 'errors/stamp'])
  }

  test('a refused subscribe', async () => {
    const client = fakeClient()
    client._setSubscriptions = async () => { throw refusal() }
    const mux = new WatchMultiplexer(client, { schema: false })
    const w = new Watch(mux, { records: ['u-1'] })
    assertCarries(await nextRejected(w.events[Symbol.asyncIterator]()))
    w.close(); mux.close()
  })

  test('a refused refresh', async () => {
    const { watchQuery } = await import('../src/watch-query.js')
    const queue = []
    let wake
    const events = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()
          await new Promise((r) => { wake = r })
        }
      },
    }
    let refuse = false
    const client = {
      __watchMux: { resolver: null },
      query: async () => { if (refuse) throw refusal(); return [{ xid: 'A', name: 'v' }] },
      watch: () => ({ events, close() {}, subscribed: async () => {}, interest: {}, setInterest() {} }),
    }
    const w = watchQuery.xsql(client, '@search list\nproject\n  name', {}, { entity: 'project', op: 'search' })
    await w.ready()
    refuse = true
    queue.push({ type: 'record/update', record: 'A' }); wake?.()
    assertCarries(await nextRejected(w.events[Symbol.asyncIterator]()))
    w.close()
  })
})
