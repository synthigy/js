# datastar-movies

Live Movies showcase for `@synthigy/sdk`. A full **live, authenticated, editable**
app — real-time list + detail, OIDC login, infinite scroll, live counters — with
**no client-side framework and no build step**. The browser gets HTML + SSE patches;
all interactivity is ~40 Datastar `data-*` attributes over **Tyrell** web components,
styled with **Tailwind** (layout) + a small `style.css` (color).

```
Browser (Datastar + Tyrell + Tailwind — all from CDN/vendor, zero build)
   ↕ HTML + SSE patches
Node BFF (this directory, TypeScript run directly by node --watch)
   ↕ @synthigy/sdk  (typed, codegen'd from synthigy/*.xsql)
Synthigy server (/data, /oauth, /data/events)
```

**Tokens never touch the browser** (OIDC code+PKCE; cookie-keyed session). **One SDK
client per process** → one upstream SSE BFF→Synthigy, multiplexed across all browser
sessions. Every SDK call carries `actingAs: user.xid`, so rows are RLS-scoped per user.

## What it shows

| page | feature | SDK primitive |
|---|---|---|
| `/` | landing + login state | — |
| `/movies` | live top-rated list — paginated, searchable; rate/edit a movie and its row repaints **in place, no reload** | `Movie.watchList` + `Movie.list/count` |
| `/movies/:xid` | live detail — rate it, edit title/year/cast/genres via modal; changes patch the card | `Movie.watchDetail` + `Movie.detail/sync` |
| `/actors` | infinite-scroll actor grid | `MovieActor.list` (paged) |
| `/dashboard` | four live counters: movies, ratings, avg rating, actors | `Dashboard.watchStats` |

The list/detail modal shares one `movieModal` — add or edit, with a searchable
**infinite-scroll actor picker** (`ty-scroll-container` `nearend` + server `patchSignals`).
Mutations (`@post` → `Movie.sync`/`UserRating.stack`) answer with an **empty SSE**; the
`watch` repaints the affected row. No page reloads, no polling.

Open `/movies` in two tabs. Rate/edit in one; the other updates within ~100ms.

## Prerequisites

1. **Synthigy server** with `:synthigy/server` up (needs IAM + subscriptions).
   Default endpoint `http://localhost:7887`.
2. **JWT keypair seeded** (one-time, REPL): `(require '[synthigy.iam.encryption :as enc]) (enc/rotate-keypair)`
3. **Movies dataset deployed** (see `examples/movies/datasets/`).
4. **OAuth client registered** (authorization_code grant) via REPL:
   ```clojure
   (require '[synthigy.iam :as iam])
   (let [{:keys [id secret]}
         (iam/add-client
           {:id "datastar-movies" :name "Datastar Movies Demo" :type :confidential
            :settings {:allowed-grants ["authorization_code"] :trusted true
                       :scopes ["openid" "email" "profile"]
                       :redirect-uris ["http://localhost:5174/auth/callback"]}})]
     (println "CLIENT_ID:" id "\nCLIENT_SECRET:" secret))
   ```
   Save the printed secret — it's hashed on store; shown once. **Note:** the validator
   reads `settings["redirections"]` on some builds — if login fails with `no_redirections`,
   set that key too. Never `sync`/`stack` the client with `:secret` after (Hash type → re-hashes → breaks auth).
5. **A user** with read on Movie + write on UserRating (SUPERUSER is simplest for the demo).

## Run

```bash
direnv allow            # loads .envrc: CLIENT_ID/SECRET, PORT, ENDPOINT (see .envrc)
npm install             # tyrell-components
npm start               # = node --watch serve.ts  (hot-reloads on save)
```

Then open <http://localhost:5174>. Logs go to stdout.

> `--watch` is mandatory (in `package.json`) — plain `node serve.ts` won't pick up edits.
> Run exactly **one** instance; two `--watch` processes race to bind the port.

### Env vars (`.envrc`)

| var | default | meaning |
|---|---|---|
| `SYNTHIGY_ENDPOINT` | `http://localhost:7887` | Synthigy base URL |
| `SYNTHIGY_CLIENT_ID` / `_SECRET` | (required) | OAuth client creds |
| `PORT` | `5174` | BFF port |
| `BASE_URL` | `http://localhost:$PORT` | OAuth `redirect_uri` base |

Change `PORT`/`BASE_URL` → update the client's `redirect-uris` to match (strict equality).

## Codegen

The typed SDK in `generated/` is compiled from `synthigy/*.xsql`:

```bash
npm run codegen:pull    # recompile xsql → IR → generated/  (needs server)
npm run codegen         # regenerate from CACHED IR only
```

⚠️ **After editing a `.xsql`, use `codegen:pull`.** Plain `codegen` regenerates from the
cached IR and your change silently won't appear.

## Architecture in 30 seconds

- **One SDK client/process** (`configure()` at load, `keepAlive:true`). All page SSE
  handlers share its multiplexer → **one** `text/event-stream` BFF→Synthigy total.
- **Each browser page opens one SSE browser→BFF**; the BFF turns `watch` events into
  Datastar element patches.
- **Mutate → watch → patch.** Writes don't return HTML; the live watch repaints the row.
- **Tokens stay server-side.** Swap the in-memory session store for Postgres/Redis to scale.

## Files

```
serve.ts            — BFF: hand-rolled router, OAuth bounce, routes, SSE streams (~700 LOC)
views/movies.ts     — /movies, /movies/:xid, modal, picker, dashboard cards (~630)
views/actors.ts     — /actors (infinite scroll) + detail
views/layout.ts     — shell (Tyrell + Datastar + Tailwind CDN, no-FOUC), landing.ts
lib/auth.ts         — OIDC code+PKCE + in-memory sessions
lib/icons.ts        — lucide icon helper
synthigy/*.xsql     — the data layer (88 lines → 7.4k generated)
generated/*.ts      — AUTO-GENERATED typed SDK (ops.ts, schema.ts) — do not edit
public/style.css    — dark theme: color + edge-cases (layout is Tailwind, inline)
```

~2,330 hand-written LOC; ~7,400 generated. Deps: `tyrell-components` (that's it).

## Not in this demo (on purpose)

- Optimistic UI — writes wait one server round trip (add if latency matters).
- Live schema-changed events (`watchSchema`).
- Production session store / `id_token` signature verification (demo trusts the direct exchange).
