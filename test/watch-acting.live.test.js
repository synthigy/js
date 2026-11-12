/**
 * Live: a trusted client's live XSQL list acting as a user sees that user's
 * rows only (RLS), on the snapshot and on every refresh. Runs the shape
 * generated `watch*` ops pass: `{ entity, op, searchOpts: { actingAs } }`.
 *
 * Needs the guarded Project Management model (examples/datasets/
 * project-management@0.1.2 + seed/) and a trusted confidential client:
 *   SYNTHIGY_RLS_TEST_ENDPOINT
 *   SYNTHIGY_RLS_TEST_CLIENT_ID  SYNTHIGY_RLS_TEST_CLIENT_SECRET
 *   SYNTHIGY_RLS_TEST_ALICE      SYNTHIGY_RLS_TEST_BOB   (user xids)
 * Run: node --test test/watch-acting.live.test.js
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '../src/index.js'

const env = process.env
const ENDPOINT = env.SYNTHIGY_RLS_TEST_ENDPOINT
const ALICE = env.SYNTHIGY_RLS_TEST_ALICE
const BOB = env.SYNTHIGY_RLS_TEST_BOB
const skip = !ENDPOINT ? 'Set SYNTHIGY_RLS_TEST_ENDPOINT, the client and the ALICE/BOB xids' : false
const RUN = `w-${Date.now().toString(36)}`
const LIST = '@search list\nproject\n  xid\n  name\n  description'

const names = (rows) => rows.map((r) => r.name).sort()

async function until(check, ms = 10000) {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) {
    if (check()) return true
  }
  return check()
}

describe('live query acting as a user', { skip }, () => {
  const c = skip ? null : createClient({
    endpoint: ENDPOINT, clientId: env.SYNTHIGY_RLS_TEST_CLIENT_ID, clientSecret: env.SYNTHIGY_RLS_TEST_CLIENT_SECRET,
  })
  let w

  after(() => w?.close())

  it('snapshot and refreshes run as the user', async () => {
    const plain = await c.query(LIST, {}, { actingAs: ALICE })
    assert.ok(names(plain).includes('Project Alpha'))
    assert.ok(!names(plain).includes('Project Beta'), 'RLS hides bob\'s project from alice')
    const alpha = plain.find((p) => p.name === 'Project Alpha')
    const beta = (await c.query(LIST, {}, { actingAs: BOB })).find((p) => p.name === 'Project Beta')
    assert.ok(beta, 'bob sees his own project')

    w = c.watchQuery.xsql(LIST, {}, { entity: 'project', op: 'search', searchOpts: { actingAs: ALICE } })
    await w.ready()
    assert.deepEqual(names(w.list()), names(plain), 'the watch snapshot is the same rows as the plain query')

    await c.sync('project', { xid: alpha.xid, description: `alice ${RUN}` }, { actingAs: ALICE })
    await c.sync('project', { xid: beta.xid, description: `bob ${RUN}` }, { actingAs: BOB })
    const seen = await until(() => w.records.get(alpha.xid)?.description === `alice ${RUN}`)
    assert.ok(seen, 'alice\'s change reaches her watch, refetched as her')
    assert.deepEqual(names(w.list()), names(plain), 'the refetch is still exactly alice\'s rows')
    await w.refresh()
    assert.deepEqual(names(w.list()), names(plain))
    assert.ok(!w.records.has(beta.xid), 'bob\'s project never reaches alice\'s watch')
  })
})
