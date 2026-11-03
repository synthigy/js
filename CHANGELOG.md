# Changelog

All notable changes to `@synthigy/sdk`. Follows [semver](https://semver.org).
Pre-1.0: breaking changes can land on minor bumps.

## 0.2.3

Needs engine v0.4.1 or newer for files.

### Added
- **`client.files`** (and `files()`): `put` (a path creates or replaces the
  file there; an xid or file replaces it; `{ name }` makes a file in no folder;
  `ifMatch`), `download` (`as`, `range`, `ifNoneMatch`, `version`), `info`,
  `list` (a folder's `{ files, folders }`; `null`: files in no folder; nothing:
  every file you can see; `q` (words in order, a space for anything between),
  `limit`, `offset`), `delete` (a file, or an
  empty folder), `url` (a link without a request, `inline`), `move`, `folder`
  (made with every missing folder above it, `public` and `cache` settings),
  `search` (folders and files whose paths hold the words in order, shortest
  path first), `share`, `unshare`, `access`, `versions`, `restore`, `objectUrl` (browser)
  and `serve` (server: a `Response` that passes Range and 304 through). A file
  is a path, an xid or the file; a folder a path ending in `/`, an xid or the
  folder. Files carry `uploaded_by { xid, name }` and `public`. Types
  `FilesApi`, `FileInfo`, `FolderInfo`, `FileListing`, `FileVersion`,
  `FolderSettings`, `FileSearch`, `FileSearchResult`, `FileSearchOpts`. New error codes: `FILE_NOT_FOUND`, `FOLDER_NOT_FOUND`,
  `FILES_UNAVAILABLE`, `AUDIT_UNAVAILABLE`, `VERSION_EXPIRED` → `not_found`;
  `FILE_NAME_TAKEN`, `FILE_CHANGED`, `FILE_NOT_READY`, `FOLDER_NAME_TAKEN`,
  `FOLDER_NOT_EMPTY`, `FOLDER_CYCLE` → `conflict`; `FILE_TOO_LARGE`,
  `NAME_REQUIRED`, `UNSUPPORTED_MEDIA_TYPE`, `RANGE_NOT_SATISFIABLE`,
  `INVALID_NAME`, `INVALID_ACCESS`, `INVALID_PATH`, `INVALID_SETTINGS`,
  `INVALID_QUERY`, `METHOD_NOT_ALLOWED`, `INVALID_SLICE` → `validation`;
  `NOT_FOUND` → `not_found` (they fell to `internal` before). Needs a server
  with the files module and File System 0.3.10.
  See `docs/FILES.md`.

### Changed
- Error categories for the deploy checks: `SYSTEM_DATASET_ENGINE_OWNED` and
  `SYSTEM_ENTITY_ALTERED` → `iam` (a superuser may); `ENTITY_NAME_CONFLICT`,
  `FIELD_KEY_CONFLICT` and `IMMUTABLE_VERSION_ALTERED` → `validation`. They used to
  fall back to `internal`.
- `UNKNOWN_TREE_RELATION` (the engine refuses an `on` of a tree op that is not a tree relation of
  the entity) → `validation`.
- More codes categorized: `ENGINE_OWNED` (a meta-model row or field only deploy and
  recall write) → `iam`; `SYSTEM_ENTITY_RLS`, `RLS_GUARD_BROKEN` and
  `VERSION_NAME_TAKEN` → `validation`; `MODEL_BUSY` (another deploy, recall or destroy
  is running; retry when it finishes) → `conflict`.

## 0.2.2

### Added
- **`client.whoami({ actingAs })`** (and `whoami()`, `op.whoami()`, the
  `WhoAmI` type) — who a call runs as: xid, name, active, superuser, roles
  (group-conferred included), groups, and `client` `{ id, trusted }`, where
  `trusted` means this client may act as users. Needs engine v0.2.11 or newer.

### Removed
- **`synthigy-gen pull`.** Without an output path it wrote `schema.json` into
  the SDK's own package folder, where nothing reads it. `synthigy-gen --pull`
  refreshes the `schema.json` beside the `.xsql`; `synthigy schema pull` writes
  the same `xsql/schema.json`.

### Fixed
- **`SynthigyError` typings declare what the runtime sets** — `category`,
  `retryable`, `hint`, `status`, `requestId`, the source positions and the
  rest. TypeScript code could read them only through a cast.
- An input path that doesn't exist is an error before anything is pulled. The
  old `synthigy-gen pull <endpoint>` would otherwise pull a schema into the
  working directory and then fail on a file named `pull`.

## 0.2.1

### Fixed
- **A login may take 10 minutes, not 5** — `MemoryLoginStore`'s default and
  `createBrowserLogin`'s pending login. Synthigy's login page allows 8, so a
  user who took 5–8 minutes logged in there and then failed the callback with
  `LOGIN_STATE_UNKNOWN`.
- **`login.complete()` and `login.cancel()` refuse a login older than 10
  minutes themselves.** Expiry used to live only in the store, so a custom
  store that never expired accepted a login of any age.
- **Permission denials are `iam`, not retryable `internal`.**
  `RELATION_FORBIDDEN`, `ATTRIBUTE_FORBIDDEN`, `ROW_FORBIDDEN`,
  `CREATE_FORBIDDEN`, `DELETE_FORBIDDEN` and `SLOT_OCCUPIED` were missing from
  the code table, so a denied relation read came back as a retryable server
  error.
- **A code the SDK doesn't know is no longer retryable.** It stays category
  `internal`, but `.retryable` is true only when the server marks the error
  retryable (it does for transient database failures) or the code is a known
  `network`/`rate_limit`/`internal` one.
- **A refused token mint is a `SynthigyError` that says why.** It was a plain
  `Error`. `invalid_client` → `INVALID_CLIENT` (with a `.hint` to check the
  client id and secret), `invalid_scope` → `INVALID_SCOPE`, `invalid_target` →
  `INVALID_AUDIENCE`; other refusals are `UNAUTHORIZED`. `.message` carries the
  server's `error_description`, `.details` the decoded OAuth error, `.status`
  the HTTP status.
- `USERINFO_SUB_MISMATCH` is category `auth`, no longer retryable `internal`.

## 0.2.0

### Added
- **Browser login: `createBrowserLogin`** — authorization code + PKCE as a
  public client, the flow Synthigy's own tools use: `start()` / `complete()` /
  `cancel()`, silent renew through a hidden `prompt=none` iframe (`renew()`,
  automatic before expiry), `logout()`, events, and tokens in memory only.
  The silent-redirect page calls `silentCallback()` first. `loadUserInfo: true`
  merges `/oauth/userinfo` (name, email) into `login.user`.
- **`createClient({ tokenProvider })`** — a caller-owned token source
  (`getToken(audience)`, `clear()`). `clear()` runs on a 401 before the one
  retry; `login.tokenProvider()` renews there.
- **`synthigy-gen` generates `@batch`.** Each batch is one exported function
  that sends all its members in ONE request and returns them keyed by member
  name, each typed with its own result; a failed member is a `SynthigyError`
  value in its slot rather than a throw. Params are one object shared by every
  member. It used to be skipped with a warning.
- **`op.query(xsql, params, verb)`** — an XSQL read for `exec` batches, beside
  the existing `op.*` builders.
- **`createClient()` / `connect()` / generated `configure()` take the
  endpoint from `SYNTHIGY_ENDPOINT` when `config.endpoint` is absent.** Under
  `synthigy exec` that and the identity are already set, so `connect()` with no
  arguments is the whole setup. No endpoint anywhere throws `NO_ENDPOINT`
  (category `validation`, not retryable); it used to be a `TypeError` on
  `undefined.replace`.
- **`client.login`** — the OIDC authorization-code + PKCE exchange for a
  server-side (confidential) app: `start()` builds the authorize URL and
  stashes the PKCE verifier, `complete()` exchanges the callback's code and
  returns `{ user: { xid, name, scopes }, tokens, returnTo }`, `cancel()`
  recovers `returnTo` when the visitor backs out at the login page. The user's
  xid comes straight out of the id_token — no `/data` lookup — which needs an
  engine that puts `xid` on every token it signs.

  Sessions, cookies and routing stay the app's. The one piece of protocol state
  the SDK can't hold, the in-flight login, goes in a `loginStore` you register
  via `createClient({ loginStore })`: any object with `put(state, login)` and
  `take(state)`. There is no default — without one `login.*` throws
  `NO_LOGIN_STORE` with instructions. `MemoryLoginStore` is exported for
  single-process dev servers.

  New error codes: `NO_LOGIN_STORE`, `LOGIN_REQUIRES_CONFIDENTIAL_CLIENT`,
  `LOGIN_STATE_UNKNOWN`, `LOGIN_NONCE_MISMATCH`, `LOGIN_EXCHANGE_FAILED`.
  Zero new dependencies: WebCrypto, `btoa`/`atob`, `URL`.
- **`compile(source, opts)`** — `POST /compile` returns the wire operation the
  engine would execute for an XSQL source, without executing it. The compiler
  is the authority on the wire format, so this is how you take programmatic
  control of a query instead of hand-writing the JSON: edit what comes back
  and send it through `exec([op])`. `opts.params` bind exactly as on `query`,
  so the result IS what the engine receives. Also exported module-level and
  typed in `index.d.ts`.

### Fixed
- **`op.sync` / `op.stack` accept a list of records** in `index.d.ts`, as the
  client's `sync`/`stack` already did.
- **`index.d.ts` declares the module-level `onboard` / `onboardComplete`.**
  `index.js` exported them, but TypeScript callers couldn't import them.
- **A Node process run under `synthigy exec` exits when its work is done.**
  The supervised token reader held stdin open for the life of the process, so
  a script that fetched a token never finished on its own. stdin is now
  released between token requests.
- **`synthigy-gen check` runs offline.** With no `SYNTHIGY_*` server settings
  it passes on a matching source hash, like the other SDKs' checks; it used to
  demand a live describe and fail in CI without credentials.
- **`synthigy-gen` works with TypeScript 7.** `npm install typescript` now
  installs 7, the native compiler, which has no JavaScript API; the generator
  crashed on `ts.NewLineKind`. It no longer uses that API: output is written as
  generated (formatting changes once when you regenerate) and `typescript` is
  only needed for the type-check gate, which runs on 5, 6 and 7.

### Changed
- **`synthigy-gen` no longer falls back to `http://localhost:7887`.** With no
  endpoint passed and no `SYNTHIGY_ENDPOINT`, a run that needs the server
  fails with `NO_ENDPOINT`, as the client does; offline runs from a current
  `ops.ir.json` are unaffected.
- **`synthigy-gen` searches directories recursively** for `.xsql`
  files, sorted by path; it read only a directory's top level.
- **Codegen:** each `.xsql` file is sent to `describe` separately (`sources: [{path,
  source}]`) instead of one concatenated text. Concatenation leaked the
  first file's buffer-level `@namespace` into every later file and dropped
  the others'. Needs an engine with per-file `describe`. A `(namespace,
  name)` declared twice across files now fails with `DUPLICATE_OPERATION`,
  naming both files; a `@batch` naming an op from another file fails with
  `BATCH_MEMBER_UNRESOLVED`. Both are `validation` in the error table.

## 0.1.2

### Added
- **`deploy(exportContents)` and `destroy(datasetXid)`** — client methods,
  `op.deploy` / `op.destroy` builders, the `DeployAck` type, and the
  module-level facade exports. A model export goes over the wire verbatim as
  a string and the server decodes it, so no client needs a transit codec:
  `deploy` posts the export file's bytes, and `destroy` is `delete` on the
  `dataset` meta-entity. The deploy ack carries the dataset xid that
  `destroy` takes, so a caller holding nothing but the export can still tear
  down what it deployed. Both are scope-gated server-side (`dataset:deploy` /
  `dataset:delete`, which only the Dataset Developer role carries), so the
  SDK adds no permission surface of its own.

### Changed
- **The platform audience is now the default; nobody configures it.** A
  `client_credentials` mint naming no audience resolves to the identity-only
  OIDC audience, which `/data`, `/schema`, `/history`, `/logs` and
  subscriptions all reject — so every user had to set `SYNTHIGY_AUDIENCE` to a
  constant they could not look up, since the server does not advertise it in
  discovery. The failure was a bare 401 that said nothing about audiences.
  This SDK is the client for the platform API, so that is what it now mints
  for. Minting for a different API stays a per-call argument. The environment
  variable remains as an escape hatch.

### Fixed
- **A failed `describe` crashed codegen with `ir.operations is not iterable`,
  throwing away the server's diagnostic.** `/data` answers a failed describe
  with HTTP 200 and `{ok: false, error}` in the result, so the generator read
  `.operations` off an error object and died on a TypeError — while the server
  had said, precisely, `describe: 'timestamp' is not an attribute on
  'user_rating'`. The `ok: false` result is now surfaced as that message, and a
  response carrying no operations array fails with what it did carry.
- **Codegen could not authenticate against a server that requires an audience.**
  Neither the schema pull nor the describe call read `SYNTHIGY_AUDIENCE`, so on
  such a server the token minted fine and was then refused, surfacing as a bare
  401 on `/schema` that said nothing about audiences. Both paths now pass it
  when set. A static `SYNTHIGY_TOKEN` is unaffected, since its audience is
  already baked in. The PHP generator has always read this variable; Go,
  Python and Clojure still do not.
- **`@batch` was skipped silently.** The generator's own comment says to skip
  loudly and never silently, and the batch branch did the opposite: an author
  declaring a batch got nothing back and no diagnostic. It now says what it
  skipped and what to do instead. Emitting batch functions, which the Python
  and PHP generators do, is still not implemented here.
- **Generated code imported the SDK by relative path.** `ops.ts` was emitted
  with a path computed from the codegen directory, which outside this repo
  becomes `../node_modules/@synthigy/sdk/src/index.js` — correct for exactly
  one install layout. When codegen runs from an installed copy it now emits the
  bare specifier `@synthigy/sdk`.
- **The type-check gate could not find `tsc` in a normal install.** It looked
  under `@synthigy/sdk/node_modules/.bin`, a path that only exists when the
  compiler is nested rather than hoisted, and failed with an empty message.
  `tsc` is now resolved the same way the `typescript` module already was, and
  when no compiler is present the gate is skipped with a warning instead of
  failing codegen.
- **`--ignoreConfig` was passed to every compiler version.** The flag needs
  TypeScript 6; on 5.x it is itself an error (TS5023), so every consumer on a
  5.x toolchain saw codegen fail. It is now sent only to compilers that
  accept it.

## 0.1.1

### Fixed
- `synthigy-gen` crashed on install with `ERR_MODULE_NOT_FOUND: typescript` —
  the codegen imported the compiler as if it were bundled. `typescript` is now
  an optional peer dependency, resolved from your project; the CLI says so
  plainly when it is missing. The runtime client still has zero dependencies.

## 0.1.0

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

## Pre-release development (2026-05-31)

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

## Initial sketch (pre-release)

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
