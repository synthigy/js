// Type-conformance gate for the hand-written core library (src/index.js +
// src/index.d.ts). These two files are maintained in parallel with nothing
// else forcing them to agree — this file is that check. `tsc --noEmit` here
// fails if the public type contract drifts (a re-added dead field, a resurrected
// removed op, a changed watch-event shape). Run via `npm run typecheck`.
//
// `satisfies` asserts a type without creating an unused binding; `@ts-expect-error`
// asserts that something is (still) NOT part of the surface.

import {
  connect, disconnect, getClient,
  search, sync, watch, sqlTemplate, op as opBuilders,
  delete as del,
} from '../src/index.js'
import type {
  SynthigyClient, RecordEvent, RelationEvent, LoginStore, PendingLogin, Operation,
} from '../src/index.js'
import * as sdk from '../src/index.js'

// ── single-client layer ────────────────────────────────────────────────────
const client = connect({ endpoint: 'http://x', token: '' })
client satisfies SynthigyClient
disconnect satisfies () => void
getClient() satisfies SynthigyClient | null

// bare verbs exist and are callable (the imports above already assert existence)
void search
void sync
void sqlTemplate
del satisfies (...a: any[]) => unknown   // `delete` is exported under its reserved-word key

// ── removed ops must STAY removed (aggregate op deprecated → sqlTemplate/XSQL) ──
// @ts-expect-error count() was removed from the SDK
sdk.count
// @ts-expect-error aggregate() was removed from the SDK
sdk.aggregate

// ── watch event contract ────────────────────────────────────────────────────
async function watchContract() {
  const w = watch({ records: ['x'] })
  for await (const ev of w.events) {
    if (ev.type === 'record/update') {
      ev satisfies RecordEvent
      ev.record satisfies string
      ev.after satisfies Record<string, unknown> | undefined
      ev.changed satisfies string[] | undefined
      // @ts-expect-error `entity` was removed from watch record events (dead field)
      ev.entity
      // @ts-expect-error record events carry no `data` tuple
      ev.data satisfies [string, string]
    }
    if (ev.type === 'relation/link') {
      ev satisfies RelationEvent
      ev.data satisfies [string, string]
    }
  }
}
void watchContract

// ── login: the store is user-implementable, the namespace is on the client ──
sdk.login satisfies () => SynthigyClient['login']
new sdk.MemoryLoginStore() satisfies LoginStore
new sdk.MemoryLoginStore({ ttlMs: 1000 }) satisfies LoginStore

// A hand-rolled store — sync or async, both must satisfy the interface.
const asyncStore: LoginStore = {
  async put(_state: string, _login: PendingLogin) {},
  async take(_state: string) { return null },
}
void asyncStore

async function loginContract() {
  const c = connect({ endpoint: 'http://x', clientId: 'a', clientSecret: 'b' })
  const { url } = await c.login.start({ redirectUri: 'http://app/cb' })
  url satisfies string
  const out = await c.login.complete({ code: 'c', state: 's', redirectUri: 'http://app/cb' })
  out.user.xid satisfies string | null
  out.user.scopes satisfies string[]
  out.returnTo satisfies string
  await c.login.cancel('s') satisfies { returnTo: string } | null
}
void loginContract

// error fields the runtime sets are typed — branch on them without a cast
function errorContract(e: unknown) {
  if (e instanceof sdk.SynthigyError) {
    e.retryable satisfies boolean
    e.category satisfies 'auth' | 'iam' | 'validation' | 'not_found' | 'conflict' | 'rate_limit' | 'network' | 'internal'
    e.hint satisfies string | undefined
    e.status satisfies number | undefined
    e.requestId satisfies string | undefined
  }
}
void errorContract

// sync/stack carry one record OR a list (bulk import), on the client, the
// module-level mirrors and the batch op builders alike.
async function bulkWriteContract(c: SynthigyClient) {
  await c.sync('movie', { title: 'A' })
  await c.sync('movie', [{ title: 'A' }, { title: 'B' }])
  await c.stack('movie', [{ xid: 'a' }], { returning: true })
  await sync('movie', [{ title: 'A' }])
  opBuilders.sync('movie', [{ title: 'A' }]) satisfies Operation
  opBuilders.stack('movie', { xid: 'a' }, true) satisfies Operation
}
void bulkWriteContract
