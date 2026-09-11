# Wire format

XSQL is the ergonomic surface. Under it is the **wire format**: plain JSON
objects for reads and writes. Use it directly when you'd rather build queries
from data than from strings — it's the same engine, same IAM/RLS.

## Selections

A **selection** is an object that mirrors the shape you want back. `null` means
"give me this scalar"; a nested object means "pull this relation".

```ts
const movies = await client.search('Movie',
  { _limit: 5, _order_by: [['release_year', 'desc']] },   // args
  {                                                        // selection
    title: null,
    release_year: null,
    genres: { name: null },        // relation → nested selection
  })
```

Reads:

| Method | Returns |
|---|---|
| `search(entity, args, selection)` | `T[]` |
| `get(entity, args, selection)` | `T \| null` |
| `searchTree(entity, on, args, selection)` | self-referential rows composed into a forest |

Counting and aggregation have no dedicated op — use `sqlTemplate` (e.g.
`SELECT COUNT(*) AS n FROM {entity} WHERE {entity.field} = ?`) or XSQL
`_count` / `_agg` selections within a `search`.

## Args

Args filter, page, and sort. Operators are helper functions (or plain
`{ _op: value }` objects):

```ts
import { eq, gt, ilike, and } from '@synthigy/sdk'

await client.search('Movie', {
  release_year: gt(1990),
  title: ilike('%star%'),
  _limit: 20,
  _offset: 0,
  _order_by: [['release_year', 'desc']],
})
```

Operators: `eq neq gt gte lt lte in_ nin like ilike isNull isNotNull` and the
combinators `and or not`.

## Result conventions

- **Empty relations are omitted**, not returned as `[]`. Check with `?.` /
  default to `[]` in your code: `(movie.genres ?? [])`.
- **Only listed fields come back.** No `SELECT *`.
- **Key format** is configurable on the client: `keyFormat: 'kebab'` (default)
  gives `release-year`; `'snake'` gives `release_year`. Pick one and your
  selections + results use it consistently.

## Writes

Five primitives, each doing one thing. Relations are linked by `{ xid }`.

```ts
// sync — upsert. REPLACES relation link-sets (empty list = unlink all).
await client.sync('Movie', {
  xid: 'm-1', title: 'Dune',
  genres: [{ xid: 'g-scifi' }],
})

// stack — additive insert. Adds without disturbing siblings.
await client.stack('user_rating', {
  value: 5, timestamp: new Date().toISOString(),
  movie: { xid: 'm-1' },
})

// slice — surgical unlink of specific relation members (no delete).
await client.slice('Movie', { xid: 'm-1' }, { genres: [{ xid: 'g-scifi' }] })

// delete — remove one record by identity.
await client.delete('Movie', { xid: 'm-1' })

// purge — delete every record matching a filter (RLS-scoped).
await client.purge('user_rating', { value: lt(2) })
```

**`stack` and `slice` are the ones ORMs make you hand-roll.** `stack` adds a
child without re-sending (and clobbering) its siblings; `slice` detaches a link
without deleting the record. `sync` is a full upsert and *replaces* link-sets, so
send a relation in full or not at all.

All writes accept `{ actingAs: userXid }` in `opts` — the write executes under
that user's permissions, server-enforced. See [AUTH.md](./AUTH.md).

## Raw ops

`client.exec([...operations])` sends raw wire operations in one round-trip if you
need to batch heterogeneous ops. The typed methods above cover almost everything.
