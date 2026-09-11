# XSQL

XSQL is Synthigy's query language. You write **what shape you want back**; the
server enforces IAM, RBAC, and row-level security, then returns exactly that
shape as JSON. It reads like the result.

You can send XSQL two ways:

- **Inline** — paste a query string into `client.query(...)`.
- **Compiled** — keep queries in `.xsql` files and generate typed methods
  ([codegen](./WATCH.md#codegen)).

## A query is a shape

```
movie (release_year > ?since:int=1980, limit ?limit:int=20, order by release_year desc)
  xid
  title (ilike ?q:string="%")
  release_year
  ->genres
    xid
    name
```

- The **root** (`movie`) is an entity. Arguments in `(...)` filter, page, and
  sort it.
- Each **indented field** is a column you want back. Nothing you don't list is
  returned.
- A field can carry its **own filter**: `title (ilike ?q)` filters rows by title.
- `->genres` pulls a **relation**. Indent its fields underneath. Nest as deep as
  the model allows.

Run it:

```ts
const movies = await client.query(
  `movie (release_year > ?since:int=1980, limit ?limit:int=20)
     xid
     title
     ->genres
       name`,
  { since: 1990, limit: 5 },          // named params
)
```

## Named parameters

`?name:type=default` — typed, optional default. The same syntax works in filters
and in sql-templates.

```
?since:int=1980        int, defaults to 1980
?q:string="%"          string, defaults to "%" (match-all for ilike)
?xid:string            required (no default)
```

Pass them as a plain object: `{ since: 1990, q: "%star%" }`.

## Aggregates without shipping rows

`_count` and `_agg` compute in the database — no child rows cross the wire.

```
movie (limit 20)
  title
  _count
    ratings:movie_ratings      # count of the movie_ratings relation, aliased "ratings"
    actors:actors
  _agg
    ratings:movie_ratings
      value: avg               # avg(value) over movie_ratings
```

Result:

```json
{ "title": "…", "_count": { "ratings": 42, "actors": 7 },
  "_agg": { "ratings": { "avg": { "value": 4.3 } } } }
```

## Relations: inner vs left

`->relation` is a **left** pull — parent rows survive even when the relation
is empty (empty relations are simply omitted from the result, see
[WIRE-FORMAT.md](./WIRE-FORMAT.md)). `-relation` is an **inner** pull — the
relation's existence scopes the parent. The compiler emits an explicit
`_join` for both sigils.

The engine's wire default matches `->`: absent `_join` is LEFT for every
operation — a selection is a projection and never drops parents, and
relation args filter the related rows. Parent scoping is always explicit
(`-rel` / `_join: "inner"`).

## Op files (`.xsql`)

An `.xsql` file holds one or more named operations. A header line declares the
verb and name; the body is the query.

```
@search list
@watch
movie (release_year > ?since:int=1980, limit ?limit:int=20)
  xid
  title (ilike ?q:string="%")
  release_year

@get detail
movie (xid = ?xid:string)
  xid
  title
  ->actors
    xid
    name
```

Headers:

| Header | Meaning |
|---|---|
| `@search <name>` | List/query op — returns rows |
| `@get <name>` | Single-record op — returns one row |
| `@watch` | Mark the op live-watchable ([WATCH.md](./WATCH.md)) |
| `@sql-template <name>` | Raw-SQL op ([below](#sql-templates)) |
| `@namespace <Name>` | Which generated class the method attaches to |
| `@returns <name>:<type>` | Declares result columns for a sql-template |

XSQL is **read-only**. Writes go through the wire write primitives (`sync`,
`stack`, `slice`, `delete`, `purge`) — see [WIRE-FORMAT.md](./WIRE-FORMAT.md).

## sql-templates

When you need raw SQL (analytics, cross-entity counts), use a sql-template. It's
parameterized SQL with a declared return shape, and it still runs under IAM/RLS.

Name entity tables with `{braces}` — that's what routes RLS/RBAC into the
query. A bare `FROM movie` is a hard `TEMPLATE_ERROR`. Use one CTE per
entity rather than scalar subqueries so each aggregate gets its own guard
scope:

```
@sql-template stats
@namespace dashboard
@returns total_movies:int, total_ratings:int, avg_rating:float?
WITH m AS (SELECT count(*) AS n FROM {movie}),
     r AS (SELECT count(*) AS n, avg({user_rating.value}) AS avg_value FROM {user_rating})
SELECT m.n AS total_movies, r.n AS total_ratings, r.avg_value AS avg_rating
FROM m, r
```

Inline equivalent:

```ts
const [row] = await client.sqlTemplate(
  `SELECT count(*) AS n FROM {user_rating} WHERE value >= ?min:int`,
  { min: 4 },
)
```

`@returns` types the generated method's result. A `?` (e.g. `float?`) marks a
nullable column.
