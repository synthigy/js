# `@synthigy/sdk`

TypeScript / JavaScript client for [Synthigy](https://github.com/synthigy/synthigy).
Zero dependencies. Typed reads, structured writes, live data on one connection,
and per-call server-enforced permissions.

```bash
npm install @synthigy/sdk
```

## Hello world

```ts
import { createClient } from '@synthigy/sdk'

const synthigy = createClient({
  endpoint:     'http://localhost:7887',
  clientId:     process.env.SYNTHIGY_CLIENT_ID,
  clientSecret: process.env.SYNTHIGY_CLIENT_SECRET,
  // The audience model is opt-in: a token naming none is identity-only and
  // /data rejects it. Your server publishes this at /.well-known/synthigy
  // (auth.oidc.audience). Defaults to $SYNTHIGY_AUDIENCE on Node. See docs/AUTH.md.
  audience:     'https://synthigy.com',
})

// Read — you get back exactly the shape you ask for
const movies = await synthigy.search('Movie',
  { _limit: 5, _order_by: [['release_year', 'desc']] },
  { title: null, release_year: null, genres: { name: null } })

// Write — additive; doesn't disturb the movie's other ratings
await synthigy.stack('user_rating', {
  value: 5, timestamp: new Date().toISOString(),
  movie: { xid: movies[0].xid },
})

// Live — snapshot + keep-current, multiplexed onto one SSE
const w = synthigy.watchSqlTemplate(
  `SELECT count(*) AS n FROM {user_rating}`, {}, { entities: ['user_rating'] })
await w.ready()
for await (const ev of w.events) {
  if (ev.type === 'result/changed') console.log('ratings:', ev.after[0].n)
}
```

## What makes it Synthigy

- **The query *is* the result shape.** Ask for fields and relations; get back
  that JSON and nothing else. Two surfaces for the same engine: an
  [XSQL](./docs/XSQL.md) string, or a [wire](./docs/WIRE-FORMAT.md) selection object.

- **Writes are silent by default.** `sync`/`stack` answer `{ count }`, not the
  record. Mint the id up front with `newXid()` when you need it — cheaper than
  the echo, and a retried write upserts the same row instead of duplicating it.
  Pass `{ returning: true }` for the record; generated code types the two apart.
- **Writes that ORMs make you hand-roll.** `stack` adds a child without
  clobbering its siblings; `slice` detaches a link without deleting the record.
  Plus `sync` (upsert), `delete`, `purge`. → [WIRE-FORMAT.md](./docs/WIRE-FORMAT.md)

- **Live data on one connection.** Open dozens of watches — they multiplex onto
  a single SSE per client. `watchQuery` for a live result set,
  `watchSqlTemplate` for live analytics, `watch` for raw record events.
  → [WATCH.md](./docs/WATCH.md)

- **`actingAs` per call.** Every read and write can run as a specific user, with
  IAM / RBAC / row-level security enforced *server-side*. Tokens never have to
  reach the browser. → [AUTH.md](./docs/AUTH.md)

- **Typed from your model.** `synthigy-gen` compiles your ERD + `.xsql` files
  into typed methods whose result types follow the selection — a typo'd entity
  or an unselected field is a compile error. → [codegen](./docs/WATCH.md#codegen)

## Docs

| Doc | What's in it |
|---|---|
| [XSQL.md](./docs/XSQL.md) | The query language: shapes, params, aggregates, op files, sql-templates |
| [WIRE-FORMAT.md](./docs/WIRE-FORMAT.md) | JSON selections, args/operators, result conventions, the five write primitives |
| [WATCH.md](./docs/WATCH.md) | `watch` / `watchQuery` / `watchSqlTemplate` / `observe`, lifecycle, and codegen |
| [AUTH.md](./docs/AUTH.md) | OAuth client registration, `actingAs`, BFF / SPA / native patterns |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |
| [examples/datastar-movies/](./examples/datastar-movies/) | End-to-end BFF exercising every primitive |
| [examples/movies-live.mjs](./examples/movies-live.mjs) | Minimal live-watch demo |
| [src/index.d.ts](./src/index.d.ts) | Full type definitions |

## Tests

```bash
node --test 'test/*.test.js'                    # unit
SYNTHIGY_ENDPOINT=http://localhost:7887 \
  SYNTHIGY_CLIENT_ID=… SYNTHIGY_CLIENT_SECRET=… \
  node --test 'test/integration.test.js'        # integration (skips without a server)
```

## License

MIT — see [LICENSE](LICENSE).

The SDKs are deliberately permissive: they are client libraries you embed in
your own application. The Synthigy **engine** is separate, and is fair-code
under the Sustainable Use License.

