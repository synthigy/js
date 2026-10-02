/**
 * OIDC authorization-code + PKCE — the protocol half of a browser login.
 *
 * What this owns: the PKCE pair, the authorize URL, the code exchange, and
 * reading the subject out of the id_token. What it deliberately does NOT own:
 * sessions, cookies, redirects, routing. Those are your app's, and they are
 * where a framework dependency would come from. The one piece of state the
 * protocol itself needs — the in-flight login, from /login until the callback
 * comes back — you supply as a `loginStore`.
 *
 * Zero dependencies and no Node built-ins: WebCrypto, btoa/atob, URL.
 */

const PKCE_VERIFIER_BYTES = 32
const STATE_BYTES = 24
// must exceed the server's 8-minute login window, or slow logins fail LOGIN_STATE_UNKNOWN
const LOGIN_TTL_MS = 10 * 60_000

function base64urlEncode(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function randomToken(bytes) {
  return base64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)))
}

/** A fresh PKCE verifier and its S256 challenge (RFC 7636). */
export async function pkce() {
  const codeVerifier = randomToken(PKCE_VERIFIER_BYTES)
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(codeVerifier))
  return { codeVerifier, codeChallenge: base64urlEncode(new Uint8Array(digest)) }
}

/**
 * Read a JWT's payload without verifying its signature.
 *
 * Safe here and nowhere else: this token arrived in the body of our own
 * client-authenticated POST to the token endpoint, over TLS, so its origin is
 * already established by the channel. A signature check would be guarding
 * against an attacker who can already answer as the IdP. Never use this on a
 * token that reached you any other way — verifying those stays out of the
 * SDK's scope, and `jose` is the library for it.
 */
export function decodeJwtPayload(jwt) {
  const parts = String(jwt ?? '').split('.')
  if (parts.length < 2) return null
  try {
    return JSON.parse(base64urlDecode(parts[1]))
  } catch {
    return null
  }
}

/**
 * In-flight logins in a Map — SINGLE PROCESS ONLY.
 *
 * Every instance behind a load balancer gets its own Map, so a callback that
 * lands on a different instance than the one that started the login fails with
 * LOGIN_STATE_UNKNOWN. Real deployments back the store with whatever already
 * holds their sessions (Redis, Postgres, a signed cookie).
 */
export class MemoryLoginStore {
  constructor({ ttlMs = LOGIN_TTL_MS } = {}) {
    this._ttlMs = ttlMs
    this._pending = new Map()
  }

  put(state, login) {
    // Swept on write rather than on a timer: a timer would keep a Node
    // process alive and would have to be torn down by someone.
    const cutoff = Date.now() - this._ttlMs
    for (const [key, value] of this._pending) {
      if (value.createdAt <= cutoff) this._pending.delete(key)
    }
    this._pending.set(state, login)
  }

  take(state) {
    const login = this._pending.get(state)
    if (!login) return null
    this._pending.delete(state)
    return login.createdAt <= Date.now() - this._ttlMs ? null : login
  }
}

export function noLoginStoreError(SynthigyError) {
  return new SynthigyError(
    'no login store: pass createClient({ loginStore }) — an object with ' +
    'put(state, login) and take(state), backed by whatever already holds ' +
    'your sessions. For a single-process dev server, import ' +
    '{ MemoryLoginStore } and pass new MemoryLoginStore().',
    'NO_LOGIN_STORE')
}

/** A store that refuses rather than silently keeping logins in one process. */
export function rejectingLoginStore(SynthigyError) {
  return {
    put() { throw noLoginStoreError(SynthigyError) },
    take() { throw noLoginStoreError(SynthigyError) },
  }
}

/**
 * The `client.login` namespace: start / complete / cancel.
 *
 * Takes the client rather than importing it, so this module never depends on
 * index.js and the two can't cycle.
 */
export function createLoginApi(client, { SynthigyError }) {
  const requireConfidential = () => {
    if (!client._clientId || !client._clientSecret) {
      throw new SynthigyError(
        'login needs clientId + clientSecret: the code exchange authenticates ' +
        'this process as a confidential client. A browser or native app is a ' +
        'public client and drives the same flow with a PKCE library of its ' +
        'own — see docs/AUTH.md.',
        'LOGIN_REQUIRES_CONFIDENTIAL_CLIENT')
    }
  }

  // the store's own expiry is not trusted: one that never expires would accept a login of any age
  const takePending = async (state) => {
    const pending = state ? await client._loginStore.take(state) : null
    return pending && pending.createdAt > Date.now() - LOGIN_TTL_MS ? pending : null
  }

  return {
    /**
     * Begin a login: returns the URL to redirect the browser to, and stashes
     * the PKCE verifier under a fresh `state` in the login store.
     */
    async start({ redirectUri, returnTo = '/', scope = 'openid', publicEndpoint } = {}) {
      requireConfidential()
      if (!redirectUri) {
        throw new SynthigyError(
          'login.start needs redirectUri — the URL on YOUR server the IdP ' +
          'sends the browser back to, registered on this OAuth client.',
          'LOGIN_REQUIRES_CONFIDENTIAL_CLIENT')
      }
      const state = randomToken(STATE_BYTES)
      const nonce = randomToken(STATE_BYTES)
      const { codeVerifier, codeChallenge } = await pkce()
      // Stored BEFORE the URL is handed out: a browser that follows the
      // redirect faster than the store commits would come back to nothing.
      await client._loginStore.put(state, { codeVerifier, nonce, returnTo, createdAt: Date.now() })

      const url = new URL(`${publicEndpoint ?? client._endpoint}/oauth/authorize`)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', client._clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', scope)
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('nonce', nonce)
      return { url: url.toString() }
    },

    /**
     * Exchange the callback's code for tokens and the user behind them.
     *
     * `user.xid` comes straight out of the id_token — the engine puts it on
     * every token it signs — so this costs no /data round-trip.
     */
    async complete({ code, state, redirectUri } = {}) {
      requireConfidential()
      const pending = await takePending(state)
      if (!pending) {
        throw new SynthigyError(
          'unknown or expired login state: the store never saw it, it was ' +
          'already consumed, or it timed out. A callback landing on a ' +
          'different instance than the one that served /login does this.',
          'LOGIN_STATE_UNKNOWN')
      }

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: client._clientId,
        client_secret: client._clientSecret,
        code_verifier: pending.codeVerifier,
      })
      const resp = await client._fetch(`${client._endpoint}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new SynthigyError(
          `authorization-code exchange failed (${resp.status})`,
          'LOGIN_EXCHANGE_FAILED', text, { status: resp.status })
      }
      const tokens = await resp.json()
      const claims = decodeJwtPayload(tokens.id_token)
      if (!claims) {
        throw new SynthigyError(
          'token response carried no readable id_token — request the openid ' +
          'scope, which is what names the user.',
          'LOGIN_EXCHANGE_FAILED')
      }
      if (claims.nonce !== pending.nonce) {
        throw new SynthigyError(
          'id_token nonce does not match the one this login started with',
          'LOGIN_NONCE_MISMATCH')
      }

      return {
        user: {
          xid: claims.xid ?? null,
          name: claims.sub ?? null,
          // Granted scopes live in the token response; the id_token carries
          // them only when the IdP chose to mirror them.
          scopes: String(tokens.scope ?? claims.scope ?? '').split(' ').filter(Boolean),
        },
        tokens,
        returnTo: pending.returnTo,
      }
    },

    /**
     * Discard an in-flight login and recover where the visitor was headed.
     *
     * Cancelling on the IdP's login page is a normal outcome (RFC 6749
     * §4.1.2.1 sends `error` back with no code), so an unknown state is null
     * here rather than a throw.
     */
    async cancel(state) {
      const pending = await takePending(state)
      return pending ? { returnTo: pending.returnTo } : null
    },
  }
}
