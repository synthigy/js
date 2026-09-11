# Live data & codegen

Every read has a live twin. Open as many as you like — they all **multiplex onto
one SSE connection** per client. Most competitors open one connection per
listener; this opens one, period.

## Pick a primitive

| You have | Use | Emits |
|---|---|---|
| An XSQL query | `watchQuery` | `query/added \| query/changed \| query/removed` |
| A sql-template (analytics) | `watchSqlTemplate` | `result/changed` |
| Specific record/relation xids | `watch` | `entity/*`, `relation/*` |
| A one-liner you just want to iterate | `observe` | record-shaped events |

### watchQuery — a live result set

Give it a query; it snapshots, then keeps the set current as rows enter, change,
and leave the result window.

```ts
const w = client.watchQuery(
  `movie (release_year > ?since:int, _limit 20)
     xid
     title
     _agg
       ratings:movie_ratings
         value: avg`,
  { since: 1990 },
)
await w.ready()
for await (const ev of w.events) {
  if (ev.type === 'query/added')   addRow(ev.record)
  if (ev.type === 'query/changed') patchRow(ev.record)
  if (ev.type === 'query/removed') dropRow(ev.recordXid)
}
```

`w.list()` is the current result array at any moment.

### watchSqlTemplate — live aggregate

Snapshots a sql-template, then re-runs it whenever the entities it reads change.
Name those entities in `opts.entities`.

```ts
const w = client.watchSqlTemplate(
  `SELECT count(*) AS n, avg(value) AS avg FROM {user_rating}`,
  {},
  { entities: ['user_rating'] },
)
await w.ready()
for await (const ev of w.events) {
  if (ev.type === 'result/changed') render(ev.after[0])   // { n, avg }
}
```

### watch — raw record subscription

The primitive the others build on. You hand it record xids (and it also watches
their relations); it emits granular change events. Grow the set live with
`w.add([xid])`.

```ts
const w = client.watch({ records: [movie.xid, ...ratingXids] })
for await (const ev of w.events) {
  switch (ev.type) {
    case 'record/update': Object.assign(cache.get(ev.record), ev.after); break
    case 'record/delete': cache.delete(ev.record); break
    case 'relation/link': /* ev.data = [subscribed, other] — fetch new child, w.add([other]) */ break
  }
}
```

### observe — one call, iterate

```ts
for await (const ev of client.observe(['u-abc', 'u-def'])) {
  console.log(ev.type, ev.record)
}
```

## Lifecycle

- `await w.ready()` resolves once the snapshot is loaded and the watch is wired.
- `for await (const ev of w.events)` drains events. Multiple consumers can drain
  the same watch independently.
- `w.close()` (or an `AbortController` via `opts.signal`) tears it down. When the
  last watch on a client closes, the SSE closes too — unless you set
  `keepAlive: true` on the client to pin it open.

## Sentinels

Between data events you may see lifecycle events — handle the ones you care about:

- `connection/resumed` — SSE reconnected; your cache may have gaps, consider a refetch.
- `schema/changed` — a model was deployed; attribute names refreshed.
- `subscription/rejected` — the server refused the interest (check `ev.reason`).
- `paused` — the buffer filled and events were dropped.

## Codegen

Hand-written entity names and query strings are stringly-typed. Codegen turns
your model + `.xsql` files into typed methods.

```bash
# 1. Once, when the model changes — writes synthigy.schema.json (commit it):
npx synthigy-gen pull

# 2. Every install (wire to postinstall) — no network:
npx synthigy-gen generate
```

Each `.xsql` op becomes a typed method, attached to the class named by its
`@namespace` (or the root entity). The result type follows the selection — so
the fields you didn't select aren't on the type.

```ts
import { Movie, Dashboard } from './generated/ops.ts'

const movies = await Movie.list({ since: 1990, limit: 5 })   // typed rows
const [stats] = await Dashboard.stats()                      // typed by @returns
```

An op marked `@watch` also gets a live method:

```ts
const live = Movie.watchList({ since: 1990, limit: 20 })
await live.ready()
for (const m of live.list()) render(m)
```

See [XSQL.md](./XSQL.md) for op-file headers (`@search`, `@watch`, `@namespace`,
`@returns`).

### What to commit

Codegen has three tiers — treat them like Prisma treats `schema.prisma` vs the
generated client:

| Tier | Files | Commit? |
|---|---|---|
| Source | `*.xsql` | ✅ yes |
| Contract snapshot | `schema.json`, `ops.ir.json` | ✅ yes — server-produced, can't be regenerated offline; this is your lockfile |
| Build artifact | `generated/**` | ❌ no — reproducible, `.gitignore` it |

Commit the **snapshots** because `synthigy-gen generate` needs them to run
offline / in CI (they pin the exact server contract). Gitignore **generated/**
and regenerate on install:

```jsonc
// package.json
"scripts": { "prepare": "synthigy-gen generate" }
```

Committing generated code invites drift (edit `.xsql`, forget to regen, ship
stale types) — if you must, add a CI guard: `synthigy-gen generate && git diff --exit-code generated/`.
