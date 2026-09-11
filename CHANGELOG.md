# Changelog

All notable changes to `@synthigy/sdk`. Follows [semver](https://semver.org).
Pre-1.0: breaking changes can land on minor bumps.

## 0.1.0 — unreleased

First public release.

### Changed

- **Codegen source↔IR contract** — the pulled IR carries `sourceHash`
  (sha256 of the concatenated `.xsql` sources); `--check` fails fast and
  offline when sources drifted from the committed IR. Same contract now in
  the Go (`synthigy-gen -check`) and Python (`codegen check`) generators.
- **Demos/fixtures migrated to braced sql-template identifiers** —
  `FROM {movie}`, never `FROM movie`. The server now hard-errors
  (`TEMPLATE_ERROR`) on bare entity tables in sql-templates: a bare name
  silently opted the scope out of RLS. Regenerate stale clients with
  `npm run codegen:pull`.

### Server compatibility notes

- **Identifiers are strict snake_case** on XSQL, sql-template placeholders,
  and wire entity names. `{Movie}` → `INVALID_TEMPLATE_IDENTIFIER`;
  `search("MovieActor", …)` → `UNKNOWN_ENTITY` with the canonical form as
  `hint`. Spaced/kebab forms still resolve; casing is never parsed.
- **`key_format` echo is now guaranteed** — result keys (any of
  snake/kebab/camel/pascal) always resolve when sent back, digits and
  acronyms included; skins render from the model's display labels
  (`"OAuth API"` → `OAuthAPI`).
- **`op: "aggregate"` removed** (→ `UNKNOWN_OP`). Aggregates go through
  `sqlTemplate` / `_count` / `_agg` selection keys.

## Unreleased — 2026-05-31

### Added

- **`createClient({ keepAlive: true })`** — long-lived BFFs / Node services
  can now pin the upstream SSE open for the lifetime of the client. The
  multiplexer's empty-watch teardown is suppressed; the server-side
  plug session keyed by `[sub, client_id]` stays alive across
  user-watch churn (browser tab refreshes, momentary watch drops).
  Replaces the prior workaround (a dummy `client.watch({records: ["__bff_keepalive__"]})`
  watch held forever).
- **`client.close()`** — explicit teardown. Closes every live watch,
  releases the keepAlive hold, closes the SSE. Idempotent. Use on
  shutdown so the server drops the plug session promptly instead
  of waiting for the SSE to time out.
- **`SynthigyErrorCode` union type** in `index.d.ts` — TS users get
  autocomplete on `if (e.code === '...')` discrimination across all
  stable wire codes (auth, shape, resolution, db, transport buckets).
  Includes the new typed wire-triage codes (see below).
- **New server-side typed error codes** — surfaced via `SynthigyError.code`:
  - `BAD_OP` — operation missing `:op` field
  - `MISSING_ENTITY` — entity-required op without `:entity`
  - `BAD_ARGS_SHAPE` — `_`-prefixed unknown args modifier (e.g. `_lmit`, `_wheree`);
    carries `modifier` + `supported` list
  - `UNKNOWN_ATTRIBUTE` — selection / args / where references an attribute
    not on the entity; carries `entity`, `attribute`, `path`,
    Levenshtein `hint` when applicable
  - `UNKNOWN_OPERATOR` — already-typed code now consistently surfaces
    `operator` field on `error.code` discrimination

  Replaces silent-drop and `INTERNAL_ERROR` sanitization for these shapes.
  Server-side: shape gates ride along existing engine walks — zero
  happy-path cost.

### Fixed

- **Safe watch teardown — no more `unhandledRejection` on close-before-bootstrap.**
  `QueryWatch` and `SqlTemplateWatch` no longer re-throw bootstrap
  failure into an un-awaited `_readyPromise`. Errors are captured and
  surfaced via `ready()` on demand AND pushed as a
  `subscription/rejected` sentinel through the event stream. Demo BFFs
  no longer need a process-wide `unhandledRejection` swallow.
- **`opts.signal` honored on `watchQuery` and `watchSqlTemplate`** —
  was silently ignored before; aborting via `AbortController` now
  closes the watch cleanly.
- **Demo (`examples/datastar-movies/serve.mjs`) migrated off two hacks**:
  the dummy-keepalive-watch ballast is replaced by `keepAlive: true`;
  the regex-based `classifySdkError` is replaced by typed-code
  `Set.has(e.code)` discrimination.

### Added (continued from 2026-05-29)

- **`SynthigyError.category`** — every error code maps to one of
  `auth` / `iam` / `validation` / `not_found` / `conflict` /
  `rate_limit` / `network` / `internal`. Consumers branch on category
  instead of parsing message strings.
- **`SynthigyError.retryable`** — boolean derived from category.
  `internal`, `network`, `rate_limit` are retryable; everything else
  is one-shot.
- **`SynthigyError.line` / `col` / `start` / `end` / `diagnostics`** —
  source-position fields populated for `XSQL_PARSE_ERROR` and
  `TEMPLATE_*` errors. 1-based coordinates pointing at the failing
  token so editors can highlight in-place. `TEMPLATE_UNBALANCED_PARENS`,
  `TEMPLATE_BAD_CTE`, and XSQL parse errors all carry them now.
  Server-side: `data.clj` enriches errors with `offset->line-col`
  via `enrich-position-error`.
- **`SynthigyError.hint`, `available`, `path`, `entity`, `relation`,
  `operator`** — structured fields populated from the server response.
  `UNKNOWN_ENTITY` includes a fuzzy-match suggestion;
  `UNKNOWN_RELATION` lists every relation on the entity;
  `UNKNOWN_OPERATOR` includes the supported set.
- **`SynthigyError.requestId`** — auto-generated per-call ID echoed in
  every error so consumers can correlate with server logs. Also
  available as `X-Request-Id` on the request header (caller can
  override).
- **`UNKNOWN_OPERATOR` error code** — replaces the previous
  `Nested problem` Java leak when a predicate uses an unknown operator
  (e.g., `_typo`). Structured, with `operator` field.
- **`_gte` / `_lte` / `_ne` accepted as aliases** for `_ge` / `_le` /
  `_neq` — these were silently rejected before; now they work
  identically.
- **`AUTH.md`**, **`SPA-INTEGRATION.md`**, **`ERRORS.md`**,
  **`PERFORMANCE.md`**, **`PRODUCTION-CHECKLIST.md`**,
  **`COMPATIBILITY.md`** — new reference docs.

### Fixed

- **Java internals no longer leak through error responses.** Server
  /data handler now sanitizes any exception message matching known
  Java/Clojure internal patterns (`ClassCastException`,
  `NullPointerException`, `nth not supported on...`, `Nested problem`,
  etc.) and returns a clean `INTERNAL_ERROR` with the original logged
  server-side. Examples that previously leaked:
  - `Character cannot be cast to Map$Entry` from single-key xid args
  - `Nested problem` from unknown operators
  - `nth not supported on this type: Integer` from nested `_limit`
- **`UNKNOWN_ENTITY` now suggests the closest match** via Levenshtein
  on the entity index. `Userr` → "Did you mean `user`?".
- **`UNKNOWN_RELATION` now lists every relation on the entity** so
  callers can see what's actually available.

### Breaking

- **Subscription wire format reshaped from one track to three** —
  `{type: "stats", entities: [...]}` is gone. Replaced with two explicit
  tracks: `{type: "entity", entities: [...]}` and
  `{type: "relation", relations: [...]}`. The `data` track is unchanged.
  See the stats→entity migration notes for
  before/after code.
- **Server now sends `entity/touched` instead of `stats/changed`** on the
  SSE wire, and `relation/touched` for the new relation track. Payload is
  reduced to `{type, entity|relation, ts}` — provenance fields (`actor`,
  `txid`, `scope`, `tenant`) are no longer included on coalesced pokes (RLS
  could leak across IAM boundaries; we don't compute it per envelope).
- **`watchSqlTemplate` opts** — `entities` is no longer the only valid
  shape; `relations: ['Entity.label']` is accepted alongside. At least one
  of `entities` or `relations` is required.
- **`Watch.interest.relations` semantic changed** — was relation xids (used
  locally for `relation/link` matching); now relation NAMES (sent on the
  wire as `relation` track interest). The xid form moved to
  `interest.relationXids`. Most callers don't touch this directly —
  `watchQuery` updated internally; `client.watch({relations})` callers
  that passed xids must rename to `relationXids`.
- **RBAC gate at subscribe time** — `entity` and `relation` subs are
  rejected with `ENTITY_NOT_READABLE` / `RELATION_NOT_READABLE` if the
  principal can't read them. Prevents entity-name enumeration; previously
  the wire was permissive.

### Fixed

- **`SqlTemplateWatch._drain` ignored coalesced touched-pokes**, so
  watchSqlTemplate tiles never refreshed when subscribed via
  `{entities: [...]}` (the headline path). One-line fix; covered by
  end-to-end smoke test via the datastar-movies dashboard.
- **`client.setSubscriptions` threw on `stats` items** —
  `Unsupported subscription type: stats` — which got swallowed by the
  multiplexer's catch as a silent `subscription/rejected` sentinel.
  Live subs are now wired through end-to-end and the multiplexer surfaces
  errors that would otherwise be invisible. (Now obsolete after the
  rename, but the same protection covers `entity` / `relation`.)
- **Multiplexer flush race** — `_scheduleFlush` reset `_flushScheduled`
  before the in-flight POST resolved, so concurrent `notifyInterestChanged`
  calls could fire multiple flushes whose POSTs arrived at the server in
  the wrong order. Smaller (older) unions could land last and overwrite
  larger ones, dropping entities from server state. Fixed by chaining each
  flush on `_flushInflight` so POSTs serialize.
- **Subscription matcher was case-sensitive** — user-supplied entity names
  (PascalCase `'UserRating'`) didn't match server-emitted form (snake
  `'user_rating'`). Now normalizes both sides via the existing `kebab()`
  helper. Same fix carried over to the new `relation/touched` matcher.

### Added

- **`relation` subscription track** — coalesced cache-invalidation pokes
  for `relation/link` / `relation/unlink` envelopes, narrowed by relation
  name (`"Movie.actors"` form). One poke per relation per 100ms window.
- **`dropSession(sid)` export from `examples/datastar-movies/lib/auth.mjs`** —
  lets BFF handlers kill a known-bad session (e.g., when the cached
  user xid no longer resolves server-side) without needing the request
  object.
- **Error-surfacing in datastar-movies BFF** — `/movies` and
  `/stream/movies` handlers now classify SDK errors, bounce to `/login` on
  stale-session detection, and render visible banners for non-auth errors
  instead of silently rendering empty.
- **`GET /logout`** route in the datastar-movies example so error banners
  can clear sessions with a plain anchor.

## 0.1.0 — initial sketch

Initial JS SDK. Surfaces:

- `client.search` / `client.get` / `client.aggregate` / `client.count`
- `client.query` (XSQL + named params)
- `client.sqlTemplate` (raw SQL with `{entity.attr}` interpolation)
- `client.sync` / `client.stack` / `client.slice` / `client.delete` /
  `client.purge`
- `client.exec` (batch)
- `client.watch` / `client.watchQuery` / `client.watchSqlTemplate` /
  `client.watchSchema` / `client.observe`
- `client.history.getAt` / `events` / `diff` / `timeline` / `since`
- `client.subscribe` / `unsubscribe` / `setSubscriptions` /
  `clearSubscriptions` / `listen`
- `client.schema` / `client.fetchFn` / `client.token`
- OAuth client_credentials with 401-retry + token cache
- Composable predicates: `and` / `or` / `not` / `eq` / `gt` / etc.
- Codegen CLI: `synthigy-gen pull` / `generate` / `lint`
- TypeScript definitions

169 unit tests + integration suite gated on env vars.
