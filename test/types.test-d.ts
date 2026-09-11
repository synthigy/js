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
  search, sync, watch, sqlTemplate,
  delete as del,
} from '../src/index.js'
import type { SynthigyClient, RecordEvent, RelationEvent } from '../src/index.js'
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
