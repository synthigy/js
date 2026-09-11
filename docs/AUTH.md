# Authentication & Authorization

How `@synthigy/sdk` authenticates to a Synthigy server, how to register an
OAuth client, what `actingAs` does, and which of the three integration
patterns (BFF, SPA, native) fits your app.

- [The two OAuth client kinds](#the-two-oauth-client-kinds)
- [Registering an OAuth client](#registering-an-oauth-client)
- [The SDK's auth model](#the-sdks-auth-model)
- [`actingAs` — running calls as a user](#actingas--running-calls-as-a-user)
- [Three integration patterns](#three-integration-patterns)
  - [BFF (Backend-for-Frontend)](#bff-backend-for-frontend)
  - [SPA (direct browser → Synthigy)](#spa-direct-browser--synthigy)
  - [Native (mobile / desktop)](#native-mobile--desktop)
- [Side-by-side tradeoffs](#side-by-side-tradeoffs)
- [The "don't" list](#the-dont-list)
- [References](#references)

---

## The two OAuth client kinds

OAuth 2.1 distinguishes two kinds of client:

| | Confidential | Public |
|---|---|---|
| Holds a `client_secret` | Yes | No |
| Runs in | Trusted environment (server, daemon) | Untrusted environment (browser, mobile, desktop) |
| Authenticates to the IdP via | `client_secret` | PKCE (`code_verifier`/`code_challenge`) |
| Allowed grants | `client_credentials`, `authorization_code` | `authorization_code` only (with PKCE) |
| Examples | Node BFF, Go service, daemon | React SPA, iOS app, Electron app |

Synthigy's IdP supports both. **`@synthigy/sdk`'s OAuth helper is for
confidential clients only** — its `ClientConfig` takes `clientSecret`, it
uses `client_credentials` for service auth, and it caches the bearer
token in-process. None of that is safe in a browser.

If your app is a browser-side SPA talking directly to Synthigy, see
[the SPA pattern below](#spa-direct-browser--synthigy) — that's a separate doc
because the SDK isn't your auth layer there.

---

## Registering an OAuth client

In the running Synthigy REPL (or via the modeler when that UI lands):

```clojure
(require '[synthigy.iam :as iam])

(iam/add-client
  {:id     "my-bff"
   :name   "My Backend Service"
   :type   :confidential                              ; or :public for SPAs
   :settings
     {:trusted        true
      :allowed-grants ["authorization_code"
                       "client_credentials"]
      :scopes         ["openid" "email" "profile"]
      :redirect-uris  ["http://localhost:5174/auth/callback"]
      :redirections   ["http://localhost:5174/auth/callback"]}})
```

A few things bite first-timers:

- **`redirect-uris` AND `redirections`.** The authorize endpoint reads
  `:redirections` (plural, no "uris"). The `add-client` docstring and most
  READMEs show `:redirect-uris`. Store both keys to avoid
  `Error: no_redirections` at `/oauth/authorize`. (Or fix the IdP's key
  reader — known polish gap.)
- **Both grants on confidential clients.** A BFF typically needs
  `client_credentials` (for the SDK's own token to call `/data` as the
  service) AND `authorization_code` (for OIDC user login through the
  BFF). If you only set one, the other path returns 401. Always set
  both unless you specifically know you only need one.
- **Strict redirect-URI matching.** The IdP compares character-by-character.
  `http://localhost:5174/auth/callback` ≠ `http://localhost:5174/auth/callback/`
  ≠ `https://...`. Register exactly what your client will send.
- **Service users.** For confidential clients, `add-client` auto-creates
  a `:SERVICE`-type user with the client's id as the username. The
  `client_credentials` grant runs as this user. Grant it whatever roles
  it needs (typically `SUPERUSER` for trusted internal services).
- **Secrets are bcrypt-hashed.** `add-client` returns the raw secret
  ONCE; the DB stores the hash. Lose it = re-create the client. Save it
  in your secrets store the moment you see it.

---

## The SDK's auth model

The SDK takes one of two shapes:

```ts
import { createClient } from '@synthigy/sdk'

// (1) OAuth client credentials — recommended for BFFs and services.
const synthigy = createClient({
  endpoint:     'https://synthigy.example.com',
  clientId:     process.env.SYNTHIGY_CLIENT_ID,
  clientSecret: process.env.SYNTHIGY_CLIENT_SECRET,
  audience:     'https://synthigy.com',     // see below
  scope:        'openid email profile',     // optional
})
```

`audience` (or `$SYNTHIGY_AUDIENCE` on Node) binds one audience to every mint
this client makes. The platform's audience model is **opt-in by design**: a
token minted naming no audience resolves to an identity-only audience that
`/data` rejects, so without this every data call 401s. Set it to the server's
`/data` audience, published at `/.well-known/synthigy` as `auth.oidc.audience`
— read it from there rather than hardcoding, the way the console and portal CLI
do. Left unset the SDK names no audience, so an unentitled client keeps a soft
401 rather than a hard `invalid_target`. `client.token({ audience })` still
overrides per call, for minting tokens aimed at a *different* audience.

```ts
// (2) Pre-minted bearer token — for testing, or when you already have
//     a valid access token from somewhere else (e.g., the framework's
//     session middleware).
const synthigy = createClient({
  endpoint: 'https://synthigy.example.com',
  token:    'eyJhbGc...',
})

// (3) No token in code at all — Node only. With neither of the above,
//     createClient falls back to (in order) — when SYNTHIGY_SUPERVISED=1 —
//     asking a supervising parent (`synthigy exec`/`agent`, or a robotics
//     commander) for a token over the process's own stdio, then the
//     SYNTHIGY_TOKEN env var. The pipe beats the env var deliberately:
//     exec injects the cached token AND supervises, and only the pipe can
//     refresh mid-run. With no source at all it throws a SynthigyError
//     whose code is NO_TOKEN and whose message teaches the fix. Bots meant
//     to run under `synthigy exec` can call createClient({ endpoint }) with
//     nothing else and just work, both locally and unmodified when the same
//     process later runs supervised.
const synthigy = createClient({ endpoint: 'https://synthigy.example.com' })
```

What the client_credentials path does internally:

1. On first call, POSTs `client_id` + `client_secret` + `grant_type=client_credentials`
   to `/oauth/token` and caches the returned access token.
2. Attaches `Authorization: Bearer <token>` to every subsequent call.
3. On a `401` response, clears the cache and retries the request once.
   If the retry also fails, throws `SynthigyError({ code: 'UNAUTHORIZED' })`.
4. Tokens are scoped to the SDK instance — sharing a client across
   threads/workers is fine; the cache + lock are atomic.

If you need the raw token (e.g., to forward it to another service):

```ts
const token = await synthigy.token()
// or with an audience claim for multi-tenant setups:
const scoped = await synthigy.token({ audience: 'reporting' })
```

---

## `actingAs` — running calls as a user

OAuth authenticates the **service** (the BFF). But the work the BFF does
is on behalf of a **user**. `actingAs` tells Synthigy "do this call as
user `xid`" — RBAC, RLS, audit attribution, and `created-by` stamps all
see the right principal.

```ts
// Per call (recommended for BFFs):
await synthigy.search('Movie', args, sel, { actingAs: req.session.userXid })

// Client-wide default (for daemons running as one user):
const synthigy = createClient({ /* … */, actingAs: serviceUserXid })

// Per call always wins over the client default.
```

A few rules that matter:

- **`actingAs` is server-trusted.** The IdP doesn't validate it — the
  service is already authenticated, and the assumption is the service
  knows who the request is for. **Never let the browser pick `actingAs`** —
  the BFF resolves the user from its own session and stamps the call.
  Passing browser-supplied user xids is impersonation on a postcard.
- **The xid is NOT the OIDC `sub` claim.** Synthigy's id_token `sub` is
  the username (e.g., `"alice"`); `actingAs` wants the user record's xid
  (e.g., `"9ALZzAsaimkw6Wk3bCHspm"`). Resolve once after token exchange:

  ```ts
  // In your OIDC callback:
  const userRecord = await synthigy.get('User', { name: oidcSubClaim },
    { xid: null, name: null })
  req.session.user = {
    xid:    userRecord.xid,
    name:   userRecord.name,
    scopes: idToken.scope.split(' '),
  }
  ```

  See `../examples/datastar-movies/serve.ts` for the `resolveUser` callback
  on `completeLogin`.

- **No `actingAs` = the service user.** If the BFF calls without it, the
  call runs as whatever user the client_credentials grant resolved to
  (the auto-created `:SERVICE` user). Fine for system tasks, wrong for
  per-user work.

---

## Three integration patterns

### BFF (Backend-for-Frontend)

```
Browser  ──cookie──▶  Node BFF  ──Bearer token──▶  Synthigy
        ◀──HTML/SSE──             ◀──/data/SSE──
```

The SDK runs in your BFF. Browser holds a session cookie (HttpOnly,
SameSite=Lax); BFF maps cookie → user xid → `actingAs` on every Synthigy
call. Tokens never reach the browser.

**Use it when:** you can run a server-side component (Node, Go, Python).
Most web apps.

**Auth flow:**
1. Browser hits `/login` on your BFF.
2. BFF kicks off OIDC authorization-code + PKCE against Synthigy's
   `/oauth/authorize`. Saves the `code_verifier` server-side.
3. User authenticates at Synthigy. Browser redirects to BFF's
   `/auth/callback?code=...&state=...`.
4. BFF exchanges code + verifier for tokens at `/oauth/token`. Resolves
   the user's xid via `synthigy.get('User', { name: subClaim }, ...)`.
5. BFF stores `{tokens, userXid}` in a session, sets the session cookie,
   redirects to the app.
6. Every page load + every Synthigy call: BFF reads cookie → session →
   `actingAs: session.userXid`.

**See:**
- [`../examples/datastar-movies/serve.ts`](../examples/datastar-movies/serve.ts) —
  full implementation
- [`../examples/datastar-movies/lib/auth.ts`](../examples/datastar-movies/lib/auth.ts) —
  OIDC + PKCE handler

### SPA (direct browser → Synthigy)

```
Browser (Bearer token in memory)  ──Bearer──▶  Synthigy
                                  ◀──/data──
```

Browser does authorization-code + PKCE directly to Synthigy, gets an
access token, calls `/data` from JavaScript. **This SDK is not your auth
layer here** — you use a browser-side PKCE library (e.g.,
`oidc-client-ts`, `react-oidc-context`) for token acquisition, and then
make raw `fetch` calls to `/data` with the bearer token.

**Use it when:** you genuinely can't run a server-side component —
static-hosted SPAs, micro-frontends with no BFF tier, hackathon demos.

**Trade-offs:** tokens live in the browser. Even with PKCE, XSS that runs
in your origin can read `sessionStorage`. You also lose multiplexed SSE
(each tab has its own connection) and `actingAs`-based principal selection
(the browser IS the user).

**See:** [the SPA pattern below](#spa-direct-browser--synthigy) for library recommendations
and a code walkthrough.

### Native (mobile / desktop)

```
Native app (token in OS keychain)  ──Bearer──▶  Synthigy
                                   ◀──/data──
```

Public client, authorization-code + PKCE via the platform's auth-session
library. Token storage is on the OS keychain rather than browser memory,
which is materially safer than the SPA path.

**Use it when:** you're building a real native app (iOS, Android,
Electron, Tauri, React Native).

**Library landscape:**
- iOS — [`AppAuth-iOS`](https://github.com/openid/AppAuth-iOS)
- Android — [`AppAuth-Android`](https://github.com/openid/AppAuth-Android)
- React Native — [`react-native-app-auth`](https://github.com/FormidableLabs/react-native-app-auth)
- Expo — [`expo-auth-session`](https://docs.expo.dev/versions/latest/sdk/auth-session/)
- Electron — [`@electron/auth`](https://github.com/electron/auth) or a
  custom embedded WebView with PKCE
- Tauri / desktop — `oauth2`-rs in the back-end, OS keychain via
  `keyring`-rs

This SDK is not your auth layer here either — get the token via the
platform helper, then call `/data` directly. (A future native SDK could
wrap this, but it doesn't exist yet.)

---

## Side-by-side tradeoffs

| | BFF | SPA | Native |
|---|---|---|---|
| Token storage | Server-side session | Browser memory | OS keychain |
| XSS exposure | None | High | Low |
| Server component needed | Yes | No | No |
| Multiplexed SSE | Yes (one per BFF process) | No (one per tab) | No (one per app instance) |
| Server-rendered HTML | Yes | No | N/A |
| `actingAs` available | Yes | No (browser IS the user) | No |
| Setup complexity | Medium | Low | Medium-high (per-platform) |
| Token rotation | Server-side, transparent | Library-handled, refresh tokens in browser | OS-managed |
| Reasonable for | Most web apps | Static hosting only | Native apps |

There's no single right answer. The shape of your deployment picks the
auth pattern more than your preference does.

---

## The "don't" list

These are the auth mistakes that bite during code review:

- **Never embed `clientSecret` in browser or mobile bundles.** It's
  the entire definition of a public client.
- **Never let the browser pass `actingAs`.** It's impersonation. The
  BFF resolves the user from its own session.
- **Don't share a confidential-client credential across multiple BFF
  processes for different services.** Each service should be its own
  OAuth client so audit attribution is clean and revoking one doesn't
  kill the others.
- **Don't store `id_token`s in cookies.** They expire, they're big, they
  leak claims. Cookies should be opaque session IDs; tokens live in
  server-side session storage.
- **Don't put `actingAs` in the `defaultActingAs` client option for a
  BFF.** It defaults the *whole client* to one user; per-call is the
  point. The default is for daemons that genuinely always run as one
  user.
- **Don't skip the `redirections` plural-key.** It's a Synthigy IdP
  reader gotcha. Always store both.
- **Don't grant `SUPERUSER` to interactive user clients.** Service users
  for confidential clients often need it; PERSON users authenticating
  through OIDC should have least-privilege roles.

---

## References

- [the SPA pattern below](#spa-direct-browser--synthigy) — the browser-direct path,
  library list, and walkthrough
- [`../examples/datastar-movies/`](../examples/datastar-movies/) — full BFF
  with OIDC + multiplexed SSE
- [OAuth 2.1 draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1)
  — the spec the IdP implements
- [RFC 7636 — PKCE](https://datatracker.ietf.org/doc/html/rfc7636) — the
  flow public clients use
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) —
  identity layer on top of OAuth
