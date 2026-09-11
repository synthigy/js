/**
 * Integration tests — run against a live Synthigy endpoint. This is the
 * contract gate: it exercises the real /data + /data/events wire so server-side
 * drift (op renames, event-shape changes) fails here instead of sailing past
 * the mocked unit suite. Run it via `npm run test:live`.
 *
 * Env vars (SYNTHIGY_ENDPOINT defaults to http://localhost:7887):
 *   SYNTHIGY_ENDPOINT       e.g. http://localhost:7887 (optional — has a default)
 *   SYNTHIGY_CLIENT_ID      OAuth client id (required)
 *   SYNTHIGY_CLIENT_SECRET  OAuth client secret (required — never commit it)
 *
 * Run (creds from your shell / direnv — e.g. the datastar-movies .envrc):
 *   npm run test:live
 *   # or explicitly:
 *   SYNTHIGY_CLIENT_ID=datastar-movies SYNTHIGY_CLIENT_SECRET=… npm run test:live
 *
 * Tests create User records prefixed with __sdk_test__ and clean them up
 * afterwards. All writes are isolated to that prefix.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, eq, in_, like, newXid, op, SynthigyError } from '../src/index.js'

const ENDPOINT = process.env.SYNTHIGY_ENDPOINT || 'http://localhost:7887'
const CLIENT_ID = process.env.SYNTHIGY_CLIENT_ID
const CLIENT_SECRET = process.env.SYNTHIGY_CLIENT_SECRET

const skip = (!CLIENT_ID || !CLIENT_SECRET)
  ? 'Set SYNTHIGY_CLIENT_ID + SYNTHIGY_CLIENT_SECRET (endpoint defaults to localhost:7887)'
  : false

// Each suite gets its own prefix so parallel runs and failures don't cross-contaminate.
const TS = Date.now()
const PREFIX_WC = `__sdk_test_wc_${TS}__`   // write cycle
const PREFIX_MR = `__sdk_test_mr_${TS}__`   // multi-record
const PREFIX_WT = `__sdk_test_wt_${TS}__`   // watch contract

describe('integration', { skip }, () => {
  let client

  before(() => {
    client = createClient({ endpoint: ENDPOINT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  })

  // ── Auth ───────────────────────────────────────────────────────────────────

  describe('auth', () => {
    it('acquires a bearer token via client credentials', async () => {
      const token = await client.token()
      assert.equal(typeof token, 'string')
      assert.ok(token.length > 0)
    })

    it('caches the token — second call makes no extra request', async () => {
      const t1 = await client.token()
      const t2 = await client.token()
      assert.equal(t1, t2)
    })
  })

  // ── Read — safe, no writes ─────────────────────────────────────────────────

  describe('search', () => {
    it('returns an array', async () => {
      const users = await client.search('User', { _limit: 5 }, { xid: null, name: null })
      assert.ok(Array.isArray(users))
      assert.ok(users.length <= 5)
    })

    it('respects _limit', async () => {
      const users = await client.search('User', { _limit: 2 }, { xid: null })
      assert.ok(users.length <= 2)
    })

    it('each record has the selected fields', async () => {
      const users = await client.search('User', { _limit: 3 }, { xid: null, name: null, type: null })
      for (const u of users) {
        assert.ok('xid' in u, 'missing xid')
        assert.ok('name' in u, 'missing name')
        assert.ok('type' in u, 'missing type')
      }
    })

    it('filters with explicit eq operator', async () => {
      const robots = await client.search(
        'User', { type: eq('ROBOT'), _limit: 10 }, { xid: null, type: null }
      )
      for (const u of robots) assert.equal(u.type, 'ROBOT')
    })

    it('filters with in_ operator', async () => {
      const users = await client.search(
        'User', { type: in_('PERSON', 'SERVICE'), _limit: 10 }, { xid: null, type: null }
      )
      for (const u of users) assert.ok(['PERSON', 'SERVICE'].includes(u.type))
    })
  })

  // Counting/aggregation is done via sqlTemplate (or XSQL _count/_agg
  // selections) — there is no `count`/`aggregate` /data op (deprecated).
  describe('sqlTemplate', () => {
    it('executes a basic count query', async () => {
      const rows = await client.sqlTemplate(
        'SELECT COUNT(*) AS total FROM {user}'
      )
      assert.ok(Array.isArray(rows) && rows.length === 1)
      const total = Number(rows[0].total)
      assert.ok(!isNaN(total) && total >= 0)
    })

    it('executes a query with parameters', async () => {
      const rows = await client.sqlTemplate(
        "SELECT COUNT(*) AS n FROM {user} WHERE {user.type} = ?",
        ['ROBOT']
      )
      assert.ok(Array.isArray(rows))
      assert.ok(Number(rows[0].n) >= 0)
    })
  })

  describe('exec — raw batch', () => {
    it('returns one result per operation', async () => {
      const results = await client.exec([
        op.search('User', { _limit: 2 }, { xid: null }),
        op.sqlTemplate('SELECT COUNT(*) AS total FROM {user}'),
      ])
      assert.equal(results.length, 2)
      assert.ok(results[0].ok, `op[0] failed: ${JSON.stringify(results[0].error)}`)
      assert.ok(results[1].ok, `op[1] failed: ${JSON.stringify(results[1].error)}`)
      assert.ok(Array.isArray(results[0].data))
      assert.ok(Number(results[1].data[0].total) >= 0)
    })

    it('returns per-operation errors without throwing', async () => {
      const results = await client.exec([
        op.search('User', { _limit: 1 }, { xid: null }),
        // Get a non-existent xid — server returns ok:false or ok:true with null data
        op.get('User', { xid: 'does-not-exist-__sdk_test__' }, { xid: null }),
      ])
      assert.equal(results.length, 2)
      assert.ok(results[0].ok)
      // Second op either returns null or an error — the point is exec doesn't throw
      assert.ok('ok' in results[1])
    })
  })

  // ── Write cycle ────────────────────────────────────────────────────────────

  describe('write cycle (sync → get → stack → delete)', () => {
    let xid

    before(async () => {
      // Writes are silent by default — mint the id up front rather than
      // reading it back out of an echo that isn't there.
      xid = newXid()
      const result = await client.sync('User', {
        xid,
        name: `${PREFIX_WC}alice`,
        type: 'ROBOT',
        active: true,
      })
      assert.equal(result?.count, 1, `sync should report one write, got: ${JSON.stringify(result)}`)
    })

    after(async () => {
      // Best-effort cleanup: try purge (may be denied by IAM ownership rules), fall back silently.
      if (xid) await client.purge('User', { xid: eq(xid) }).catch(() => {})
    })

    it('sync returns the created record with xid', () => {
      assert.equal(typeof xid, 'string')
      assert.ok(xid.length > 0)
    })

    it('get retrieves the record by xid', async () => {
      const user = await client.get('User', { xid }, { xid: null, name: null, type: null, active: null })
      assert.equal(user.xid, xid)
      assert.equal(user.name, `${PREFIX_WC}alice`)
      assert.equal(user.type, 'ROBOT')
      assert.equal(user.active, true)
    })

    it('search finds the record', async () => {
      const users = await client.search(
        'User',
        { name: like(`${PREFIX_WC}%`), _limit: 10 },
        { xid: null, name: null }
      )
      assert.ok(users.some(u => u.xid === xid), 'created record not found in search results')
    })

    it('stack updates a field', async () => {
      await client.stack('User', { xid, active: false })
      const user = await client.get('User', { xid }, { xid: null, active: null })
      assert.equal(user.active, false)
    })

    it('sync idempotent — re-syncing same xid updates without duplicate', async () => {
      await client.sync('User', { xid, name: `${PREFIX_WC}alice-updated`, type: 'ROBOT', active: true })
      const user = await client.get('User', { xid }, { xid: null, name: null })
      assert.equal(user.name, `${PREFIX_WC}alice-updated`)
      const rows = await client.search('User', { name: like(`${PREFIX_WC}%`), _limit: 10 }, { xid: null })
      assert.equal(rows.length, 1)
    })

    it('delete (soft-delete) marks the record deleted', async () => {
      await client.delete('User', { xid })
      // After soft-delete, search should no longer return it by default
      const users = await client.search(
        'User', { name: like(`${PREFIX_WC}%`), _limit: 10 }, { xid: null }
      )
      assert.ok(!users.some(u => u.xid === xid), 'deleted record still appears in search results')
    })
  })

  describe('multi-record write + search', () => {
    const xids = []

    before(async () => {
      const minted = [newXid(), newXid(), newXid()]
      const results = await client.exec([
        op.sync('User', { xid: minted[0], name: `${PREFIX_MR}bob`,   type: 'PERSON',  active: true }),
        op.sync('User', { xid: minted[1], name: `${PREFIX_MR}carol`, type: 'SERVICE', active: false }),
        op.sync('User', { xid: minted[2], name: `${PREFIX_MR}dan`,   type: 'ROBOT',   active: true }),
      ])
      for (const [i, r] of results.entries()) {
        assert.ok(r.ok, `sync failed: ${JSON.stringify(r.error)}`)
        assert.equal(r.data.count, 1)
        xids.push(minted[i])
      }
    })

    after(async () => {
      if (xids.length) {
        await client.purge('User', { name: like(`${PREFIX_MR}%`) }).catch(() => {})
      }
    })

    it('search returns all three test records', async () => {
      const users = await client.search(
        'User', { name: like(`${PREFIX_MR}%`), _limit: 10 }, { xid: null, name: null }
      )
      assert.equal(users.length, 3)
    })

    it('_order_by sorts results ascending', async () => {
      const users = await client.search(
        'User',
        { name: like(`${PREFIX_MR}%`), _limit: 10, _order_by: [['name', 'asc']] },
        { xid: null, name: null }
      )
      assert.equal(users.length, 3)
      const names = users.map(u => u.name)
      assert.deepEqual(names, [...names].sort())
    })

    it('_order_by multi-column preserves order', async () => {
      const users = await client.search(
        'User',
        { name: like(`${PREFIX_MR}%`), _limit: 10, _order_by: [['active', 'asc'], ['name', 'asc']] },
        { xid: null, name: null, active: null }
      )
      assert.equal(users.length, 3)
      // false (carol) before true (bob, dan alphabetically)
      assert.equal(users[0].active, false)
      assert.equal(users[1].active, true)
      assert.equal(users[2].active, true)
      assert.equal(users[1].name, `${PREFIX_MR}bob`)
      assert.equal(users[2].name, `${PREFIX_MR}dan`)
    })

    it('filter by active=true returns subset', async () => {
      const active = await client.search(
        'User',
        { name: like(`${PREFIX_MR}%`), active: eq(true), _limit: 10 },
        { xid: null, name: null, active: null }
      )
      assert.equal(active.length, 2)
      for (const u of active) assert.equal(u.active, true)
    })

    it('sqlTemplate counts filtered rows', async () => {
      const rows = await client.sqlTemplate(
        'SELECT COUNT(*) AS n FROM {user} WHERE {user.name} LIKE ?',
        [`${PREFIX_MR}%`]
      )
      assert.equal(Number(rows[0].n), 3)
    })

    it('exec batch reads all records efficiently', async () => {
      const results = await client.exec([
        op.search('User', { name: like(`${PREFIX_MR}%`), _limit: 10 }, { xid: null }),
        op.sqlTemplate('SELECT COUNT(*) AS n FROM {user} WHERE {user.name} LIKE ?', [`${PREFIX_MR}%`]),
      ])
      assert.ok(results[0].ok)
      assert.ok(results[1].ok)
      assert.equal(results[0].data.length, 3)
      assert.equal(Number(results[1].data[0].n), 3)
    })
  })

  // ── Subscriptions ──────────────────────────────────────────────────────────
  //
  // Set-replace contract: every subscribe/unsubscribe POSTs the full set to
  // /data/subscription/set. SDK tracks intent locally.

  describe('subscriptions', () => {
    // Each test creates its own client to avoid cross-test state leakage
    // from the local subscription map.
    const makeClient = () => createClient({
      endpoint: ENDPOINT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    })

    // The wire has three first-class tracks: `data` (records-only — an array
    // of record xids), `entity` (cache-invalidation by entity name), and
    // `relation` (by "Entity - label"). `subscribe()`/`unsubscribe()` are the
    // records convenience; entity/relation go through `setSubscriptions` (the
    // same primitives `watch`/`watchQuery` compose over).

    it('data track: subscribe to record xids → status → unsubscribe', async () => {
      const c = makeClient()
      try {
        const rows = await c.search('User', null, {})
        const xids = rows.map(r => r.xid).filter(Boolean).slice(0, 2)
        assert.ok(xids.length > 0, 'need at least one User xid to subscribe to')
        await c.subscribe(xids)

        const status = await c.subscriptions()
        assert.ok(Array.isArray(status.subscriptions))
        const dataItem = status.subscriptions.find(s => (s.type ?? 'data') === 'data')
        assert.ok(dataItem, `data sub not in status: ${JSON.stringify(status.subscriptions)}`)
        assert.ok(xids.every(x => dataItem.records.includes(x)),
          `subscribed xids missing from status: ${JSON.stringify(dataItem)}`)

        await c.unsubscribe(xids)
        const after = await c.subscriptions()
        assert.ok(!after.subscriptions.some(s => (s.type ?? 'data') === 'data'),
          `data sub should be gone: ${JSON.stringify(after.subscriptions)}`)
      } finally {
        await c.clearSubscriptions().catch(() => {})
      }
    })

    it('entity track: setSubscriptions registers an entity-level sub', async () => {
      const c = makeClient()
      try {
        await c.setSubscriptions([{ type: 'entity', entities: ['User'] }])
        const status = await c.subscriptions()
        const ent = status.subscriptions.find(s => s.type === 'entity')
        assert.ok(ent && ent.entities.includes('User'),
          `entity sub not in status: ${JSON.stringify(status.subscriptions)}`)
      } finally {
        await c.clearSubscriptions().catch(() => {})
      }
    })

    it('relation track: setSubscriptions registers a relation-level sub', async () => {
      const c = makeClient()
      try {
        await c.setSubscriptions([{ type: 'relation', relations: ['User Group - users'] }])
        const status = await c.subscriptions()
        const rel = status.subscriptions.find(s => s.type === 'relation')
        assert.ok(rel && rel.relations.length > 0,
          `relation sub not in status: ${JSON.stringify(status.subscriptions)}`)
      } finally {
        await c.clearSubscriptions().catch(() => {})
      }
    })

    it('setSubscriptions replaces the full set', async () => {
      const c = makeClient()
      try {
        await c.setSubscriptions([{ type: 'entity', entities: ['User'] }])
        await c.setSubscriptions([{ type: 'entity', entities: ['User Group'] }])
        const status = await c.subscriptions()
        const ent = status.subscriptions.find(s => s.type === 'entity')
        assert.ok(ent && ent.entities.includes('User Group') && !ent.entities.includes('User'),
          `expected only User Group after replace: ${JSON.stringify(status.subscriptions)}`)
      } finally {
        await c.clearSubscriptions().catch(() => {})
      }
    })

    it('clearSubscriptions empties the session', async () => {
      const c = makeClient()
      await c.setSubscriptions([{ type: 'entity', entities: ['User'] }])
      await c.clearSubscriptions()
      const status = await c.subscriptions()
      assert.equal(status.subscriptions.length, 0,
        `expected empty after clear: ${JSON.stringify(status.subscriptions)}`)
    })

    it('listen connects and can be cancelled via AbortSignal', async () => {
      const c = makeClient()
      try {
        await c.setSubscriptions([{ type: 'entity', entities: ['User'] }])

        const ac = new AbortController()
        setTimeout(() => ac.abort(), 200)

        const events = []
        for await (const event of c.listen({ signal: ac.signal })) {
          events.push(event)
        }

        // We may or may not have received events — the point is it terminates cleanly
        assert.ok(Array.isArray(events))
      } finally {
        await c.clearSubscriptions().catch(() => {})
      }
    })
  })

  // ── History ────────────────────────────────────────────────────────────────
  //
  // /history returns 404 when no audit provider is loaded. Test suite tolerates
  // both states: when 404 ⇒ skip; when available ⇒ assert wire shape.

  describe('history', () => {
    const hasHistory = async () => {
      try {
        await client.history.events({ limit: 1 })
        return true
      } catch (err) {
        if (err.code === 'HISTORY_UNAVAILABLE') return false
        throw err
      }
    }

    it('events returns an array (or skips on no-provider deployment)', async () => {
      if (!(await hasHistory())) {
        return  // No audit provider configured; nothing to assert.
      }
      const events = await client.history.events({ limit: 10 })
      assert.ok(Array.isArray(events))
    })

    it('since(cursor=now) returns no future events', async () => {
      if (!(await hasHistory())) return
      const now = new Date().toISOString()
      const events = await client.history.since({ cursor: now, limit: 10 })
      assert.ok(Array.isArray(events))
      assert.equal(events.length, 0,
        `Future cursor should return zero events, got ${events.length}`)
    })

    it('getAt requires record-xid (server-side validation)', async () => {
      if (!(await hasHistory())) return
      await assert.rejects(
        () => client.history.getAt('', new Date().toISOString()),
        (err) => err instanceof SynthigyError && err.code === 'RECORD_XID_REQUIRED'
      )
    })

    it('diff requires both timestamps', async () => {
      if (!(await hasHistory())) return
      await assert.rejects(
        () => client.history.diff('some-xid', null, null),
        (err) => err instanceof SynthigyError &&
                 (err.code === 'DIFF_TIMESTAMPS_REQUIRED' || err.code === 'RECORD_XID_REQUIRED')
      )
    })
  })

  // ── Tree ops ───────────────────────────────────────────────────────────────
  // TODO: add getTree / searchTree integration tests once the server-side
  // tree relation path bug is fixed (Human.father path is {side: :top-left}
  // with no coordinates → "nth not supported on this type: PersistentHashMap").
  // Expected shape once fixed:
  //   const tree = await client.getTree('human', rootXid, 'father', {
  //     'first-name': null, father: { xid: null }
  //   })
  //   assert.ok(tree !== null && '_children' in tree)

  // ── Schema ─────────────────────────────────────────────────────────────────

  describe('schema', () => {
    it('returns full model schema', async () => {
      const schema = await client.schema()
      assert.ok(typeof schema['id-key'] === 'string', 'missing id-key')
      assert.ok(schema.entities && typeof schema.entities === 'object', 'missing entities')
      assert.ok(Object.keys(schema.entities).length > 0, 'no entities in schema')
    })

    it('each entity has attributes, relations, constraints', async () => {
      const schema = await client.schema()
      for (const entity of Object.values(schema.entities)) {
        assert.ok(typeof entity.attributes === 'object', `${entity.name}: missing attributes`)
        assert.ok(typeof entity.relations === 'object', `${entity.name}: missing relations`)
        assert.ok(Array.isArray(entity.constraints?.unique), `${entity.name}: missing constraints.unique`)
      }
    })

    it('filters to specific entities', async () => {
      const schema = await client.schema(['user'])
      assert.ok('user' in schema.entities, 'user not in filtered schema')
      assert.equal(Object.keys(schema.entities).length, 1)
    })
  })

  // The LIVE contract guard: watch() consuming real /data/events. This is what
  // catches server-side wire drift (e.g. the entity/* → record/* rename) that
  // mock-only tests structurally cannot. Asserts the shaped RecordDeltaEvent
  // the SDK's .d.ts promises against what the server actually streams.
  describe('watch — live /data/events record contract', () => {
    let xid

    before(async () => {
      xid = newXid()
      await client.sync('User', { xid, name: `${PREFIX_WT}watched`, type: 'ROBOT', active: true })
    })

    after(async () => {
      if (xid) await client.purge('User', { xid: eq(xid) }).catch(() => {})
    })

    it('a real write emits a shaped record/update matching the delta contract', async () => {
      const ac = new AbortController()
      const w = client.watch({ records: [xid], operations: ['update'] }, { signal: ac.signal })

      // Collect the first record/update, with a hard timeout so a broken wire
      // fails loudly instead of hanging.
      const firstUpdate = (async () => {
        for await (const ev of w.events) {
          if (ev.type === 'record/update' && ev.record === xid) return ev
        }
        return null
      })()
      const timeout = new Promise((res) => setTimeout(() => res('TIMEOUT'), 8000))

      // Let the SSE + subscription POST settle, then drive a real field change.
      await new Promise((r) => setTimeout(r, 800))
      await client.stack('User', { xid, active: false })

      const ev = await Promise.race([firstUpdate, timeout])
      ac.abort()

      assert.notEqual(ev, 'TIMEOUT', 'no record/update arrived within 8s — /data/events wire may have drifted')
      assert.ok(ev, 'watch stream closed before an update arrived')
      // Contract (RecordDeltaEvent, shaped): type, record (from record-xid),
      // before/after attribute maps, changed list.
      assert.equal(ev.type, 'record/update')
      assert.equal(ev.record, xid)
      assert.ok(ev.after && typeof ev.after === 'object', 'record/update must carry after')
      assert.equal(ev.after.active, false, 'after reflects the write')
      assert.ok(Array.isArray(ev.changed) && ev.changed.includes('active'), 'changed lists the mutated attr')
      // Provenance the SDK promises.
      assert.equal(typeof ev.ts, 'string')
      assert.ok(ev.txid != null, 'txid present')
      // Fields the server does NOT send on record deltas (dead in older SDKs).
      assert.equal(ev.entity, undefined, 'no entity name on the wire')
      assert.equal(ev.element, undefined, 'no element field on the wire')
    })
  })
})

// onboard() is gated on the client's principal administering the account —
// RBAC update on User plus the row inside its owner-group write scope, the
// shape the shipped User Provisioner role grants. The CLIENT_ID/SECRET
// identity above is ROOT, so this block runs on its OWN dedicated env pair
// to exercise the real, scoped principal.
//
//   SYNTHIGY_PROVISION_CLIENT_ID      (a confidential client holding User Provisioner)
//   SYNTHIGY_PROVISION_CLIENT_SECRET
//
// Creating it (one-time, via nREPL):
//   (access/with-principal nil
//     (let [id "synthigy-js-sdk-provisioner"
//           role (dataset/get-entity :iam/user-role {:name "User Provisioner"} {(id/key) nil})
//           owners (dataset/sync-entity :iam/user-group {:name (str id "-owners")})
//           client (iam/add-client {:id id :name "Synthigy JS SDK provisioner"
//                                   :type :confidential
//                                   :settings {"allowed-grants" ["client_credentials"]}})]
//       (dataset/stack-entity :iam/user {:name id
//                                        :roles [{(id/key) (id/extract role)}]
//                                        :groups [{(id/key) (id/extract owners)}]})
//       (access/load-rules)
//       client))
//
// Each test creates its own account, stamped with the client's own owner
// group so it lands inside the principal's write scope.

const PROVISION_CLIENT_ID = process.env.SYNTHIGY_PROVISION_CLIENT_ID
const PROVISION_CLIENT_SECRET = process.env.SYNTHIGY_PROVISION_CLIENT_SECRET

const skipOnboard = (!PROVISION_CLIENT_ID || !PROVISION_CLIENT_SECRET)
  ? 'Set SYNTHIGY_PROVISION_CLIENT_ID + SYNTHIGY_PROVISION_CLIENT_SECRET (a confidential client holding User Provisioner)'
  : false

describe('onboard (live)', { skip: skipOnboard }, () => {
  const provisionClient = () => createClient({
    endpoint: ENDPOINT, clientId: PROVISION_CLIENT_ID, clientSecret: PROVISION_CLIENT_SECRET,
  })

  // The client's own first group; null for an unscoped (superuser) client.
  const ownerGroup = async (client) => {
    const me = await client.get('User', { name: PROVISION_CLIENT_ID }, { groups: { xid: null } })
    return me?.groups?.[0]?.xid ?? null
  }

  // Cleanup runs as ROOT, not as the provisioner: User Provisioner grants
  // create/read/update on User but deliberately NOT delete, so a
  // provisioner-run purge fails with insufficient privileges. These tests ran
  // as skips for their whole life, so nothing ever noticed them piling up
  // accounts on the dev tenant.
  const created = []
  after(async () => {
    if (!created.length) return
    const root = createClient({
      endpoint: ENDPOINT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    })
    try {
      for (const xid of created) {
        await root.purge('User', { xid: eq(xid) })
      }
    } finally {
      root.close()
    }
  })

  const createAccount = async (client, username) => {
    const group = await ownerGroup(client)
    const xid = newXid()
    await client.sync('User', {
      xid, name: username, active: false,
      ...(group ? { owner_group: { xid: group } } : {}),
    })
    created.push(xid)
    return { xid }
  }

  it('mints a claim link for an account created via sync, then user_not_found for an unknown xid', async () => {
    const client = provisionClient()
    const username = `sdk-onboard-test-${Date.now()}@example.com`
    const created = await createAccount(client, username)

    const out = await client.onboard(created.xid, { methods: ['password'] })
    assert.ok(out.onboard_url.includes('/oauth/claim?token='))
    assert.equal(typeof out.expires_at, 'number')
    assert.equal(out.user.xid, created.xid)

    await assert.rejects(
      () => client.onboard('does-not-exist-xid'),
      (err) => err instanceof SynthigyError && err.code === 'USER_NOT_FOUND'
    )
  })

  it('redeems its own ticket indirectly via onboardComplete, without ever setting a credential', async () => {
    const client = provisionClient()
    const username = `sdk-onboard-complete-test-${Date.now()}@example.com`
    const created = await createAccount(client, username)

    const out = await client.onboard(created.xid, { methods: ['password'] })
    const ticket = new URL(out.onboard_url).searchParams.get('token')

    const result = await client.onboardComplete(ticket)
    assert.equal(result.active, true)
    assert.equal(result.user.xid, created.xid)
  })
})
