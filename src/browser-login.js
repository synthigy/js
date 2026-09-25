/**
 * Browser login as a PUBLIC client: authorization code + PKCE, silent renew
 * through a hidden iframe, tokens in memory only. The same flow Synthigy's own
 * tools use (the Clojure SDK's `synthigy.client.login`).
 *
 * The server-side, confidential flow is `client.login` (login.js). This one
 * holds no secret: the code exchange is authenticated by the PKCE verifier.
 * Nothing touches localStorage — only the in-flight login (verifier, nonce,
 * return path) sits in sessionStorage between the redirect and the callback.
 * A reload restores the session through silent renew, which rides the
 * engine's own session cookie.
 */

import { pkce, decodeJwtPayload } from './login.js'

const PENDING_PREFIX = 'synthigy.login:'
const PENDING_TTL_MS = 5 * 60_000
const MESSAGE_SOURCE = 'synthigy-login'

function randomToken(bytes) {
  let binary = ''
  for (const b of globalThis.crypto.getRandomValues(new Uint8Array(bytes))) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The authorization response `href` carries, or null. */
export function callbackParams(href) {
  const q = new URL(href).searchParams
  const state = q.get('state')
  const code = q.get('code')
  const error = q.get('error')
  if (!state || !(code || error)) return null
  return { state, code, error, errorDescription: q.get('error_description') }
}

/**
 * Call first thing on the silent-redirect page. True when this window is a
 * renewal iframe and has handed its URL to the parent — stop there.
 */
export function silentCallback() {
  const w = globalThis.window
  if (!w || w === w.parent || !callbackParams(globalThis.location.href)) return false
  w.parent.postMessage({ source: MESSAGE_SOURCE, url: globalThis.location.href }, globalThis.location.origin)
  return true
}

export function createBrowserLogin(config = {}, { SynthigyError }) {
  const { endpoint, clientId, redirectUri } = config
  if (!endpoint || !clientId || !redirectUri) {
    throw new SynthigyError('createBrowserLogin needs endpoint, clientId and redirectUri', 'CONFIG_ERROR')
  }
  const cfg = {
    scope: 'openid profile',
    automaticSilentRenew: true,
    loadUserInfo: false,
    silentTimeoutMs: 10_000,
    expiringSeconds: 60,
    silentRedirectUri: redirectUri,
    postLogoutRedirectUri: redirectUri,
    ...config,
    endpoint: endpoint.replace(/\/+$/, ''),
  }
  const doFetch = cfg.fetch ?? globalThis.fetch.bind(globalThis)
  const storage = cfg.storage ?? globalThis.sessionStorage

  let tokens = null
  let user = null
  let renewal = null
  let timers = []
  const listeners = new Map()

  const emit = (event, payload) => {
    for (const f of listeners.get(event) ?? []) {
      try { f(payload) } catch (e) { console.warn('synthigy browser login listener error:', e) }
    }
  }

  const authorizeUrl = (request) => {
    const params = new URLSearchParams()
    for (const [k, v] of [
      ['response_type', 'code'],
      ['client_id', clientId],
      ['redirect_uri', request.redirectUri],
      ['scope', cfg.scope],
      ['state', request.state],
      ['nonce', request.nonce],
      ['code_challenge', request.codeChallenge],
      ['code_challenge_method', 'S256'],
      ['audience', cfg.audience],
      ['prompt', request.prompt],
    ]) if (v != null) params.append(k, v)
    return `${cfg.endpoint}/oauth/authorize?${params}`
  }

  const startRequest = async (uri, prompt) => {
    const { codeVerifier, codeChallenge } = await pkce()
    return { redirectUri: uri, prompt, state: randomToken(24), nonce: randomToken(24), codeVerifier, codeChallenge }
  }

  const putPending = (request, returnTo) => storage.setItem(PENDING_PREFIX + request.state, JSON.stringify({
    redirectUri: request.redirectUri, nonce: request.nonce, codeVerifier: request.codeVerifier,
    returnTo, createdAt: Date.now(),
  }))

  const takePending = (state) => {
    const key = PENDING_PREFIX + state
    const raw = storage.getItem(key)
    storage.removeItem(key)
    if (!raw) return null
    const pending = JSON.parse(raw)
    return pending.createdAt > Date.now() - PENDING_TTL_MS ? pending : null
  }

  const stripCallback = () => {
    const l = globalThis.location
    globalThis.history.replaceState(null, '', l.pathname + l.hash)
  }

  const exchange = async (code, { redirectUri: uri, codeVerifier }) => {
    const resp = await doFetch(`${cfg.endpoint}/oauth/token`, {
      method: 'POST',
      credentials: 'omit',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: uri,
        client_id: clientId, code_verifier: codeVerifier,
      }).toString(),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new SynthigyError(`authorization-code exchange failed (${resp.status})`,
        'LOGIN_EXCHANGE_FAILED', text, { status: resp.status })
    }
    return JSON.parse(text)
  }

  const clearTimers = () => { timers.forEach(clearTimeout); timers = [] }

  const schedule = (expiresAt) => {
    clearTimers()
    const now = Date.now()
    timers = [
      setTimeout(() => {
        emit('accessTokenExpiring')
        if (cfg.automaticSilentRenew) api.renew().catch(() => {})
      }, Math.max(0, expiresAt - cfg.expiringSeconds * 1000 - now)),
      setTimeout(() => emit('accessTokenExpired'), Math.max(0, expiresAt - now)),
    ]
  }

  const userInfo = async (accessToken) => {
    const resp = await doFetch(`${cfg.endpoint}/oauth/userinfo`, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new SynthigyError(`userinfo request failed (${resp.status})`, 'USERINFO_FAILED', text,
        { status: resp.status })
    }
    return JSON.parse(text)
  }

  const accept = async (tokenResponse, nonce) => {
    const claims = decodeJwtPayload(tokenResponse.id_token)
    if (!claims) {
      throw new SynthigyError('token response carried no readable id_token — request the openid scope',
        'LOGIN_EXCHANGE_FAILED')
    }
    if (claims.nonce !== nonce) {
      throw new SynthigyError('id_token nonce does not match the one this login started with',
        'LOGIN_NONCE_MISMATCH')
    }
    const info = cfg.loadUserInfo ? await userInfo(tokenResponse.access_token) : null
    if (info && info.sub !== claims.sub) {
      throw new SynthigyError('userinfo sub does not match the id_token', 'USERINFO_SUB_MISMATCH')
    }
    tokens = tokenResponse
    user = { ...claims, ...info }
    schedule(Date.now() + 1000 * (tokenResponse.expires_in ?? 300))
    emit('userLoaded', user)
    return user
  }

  const authorizationError = ({ error, errorDescription }) =>
    new SynthigyError(errorDescription || error, error)

  const silentFrame = (request) => new Promise((resolve, reject) => {
    const frame = globalThis.document.createElement('iframe')
    const origin = new URL(cfg.silentRedirectUri).origin
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      globalThis.window.removeEventListener('message', onMessage)
      frame.remove()
    }
    const onMessage = (e) => {
      if (e.origin !== origin || e.source !== frame.contentWindow || e.data?.source !== MESSAGE_SOURCE) return
      cleanup()
      const params = callbackParams(e.data.url)
      if (params?.state === request.state) resolve(params)
      else reject(new SynthigyError('silent renew answered with a foreign state', 'LOGIN_STATE_UNKNOWN'))
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new SynthigyError('silent renew timed out', 'SILENT_TIMEOUT'))
    }, cfg.silentTimeoutMs)
    globalThis.window.addEventListener('message', onMessage)
    frame.src = authorizeUrl(request)
    globalThis.document.body.appendChild(frame)
  })

  const api = {
    get user() { return user },
    get token() { return tokens?.access_token ?? null },

    /** Subscribe to userLoaded, userUnloaded, accessTokenExpiring, accessTokenExpired or silentRenewError. */
    on(event, f) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(f)
      return () => listeners.get(event).delete(f)
    },

    /** True when the current URL is an authorization response. */
    isCallback: () => callbackParams(globalThis.location.href) !== null,

    /** Redirect to the login page. `prompt: 'none'` comes straight back when a session is alive. */
    async start({ prompt, returnTo } = {}) {
      const l = globalThis.location
      const request = await startRequest(redirectUri, prompt)
      putPending(request, returnTo ?? l.pathname + l.search + l.hash)
      l.assign(authorizeUrl(request))
    },

    /** Finish the login the current URL returns from: `{ user, returnTo }`, or null when it carries none. */
    async complete() {
      const params = callbackParams(globalThis.location.href)
      if (!params) return null
      const pending = takePending(params.state)
      stripCallback()
      if (!pending) {
        throw new SynthigyError('unknown or expired login state: already consumed, timed out, or started in another tab',
          'LOGIN_STATE_UNKNOWN')
      }
      if (!params.code) throw authorizationError(params)
      const tokenResponse = await exchange(params.code, pending)
      return { user: await accept(tokenResponse, pending.nonce), returnTo: pending.returnTo }
    },

    /** Drop the login the current URL returns from (the user cancelled): `{ returnTo }` or null. */
    cancel() {
      const params = callbackParams(globalThis.location.href)
      if (!params) return null
      stripCallback()
      const pending = takePending(params.state)
      return pending ? { returnTo: pending.returnTo } : null
    },

    /** Silent renew through a hidden iframe (prompt=none); one renewal at a time. */
    renew() {
      if (renewal) return renewal
      renewal = (async () => {
        const request = await startRequest(cfg.silentRedirectUri, 'none')
        const params = await silentFrame(request)
        if (!params.code) throw authorizationError(params)
        return await accept(await exchange(params.code, request), request.nonce)
      })()
        .catch((e) => { emit('silentRenewError', e); throw e })
        .finally(() => { renewal = null })
      return renewal
    },

    /** Forget the tokens here without ending the server session. */
    removeUser() {
      clearTimers()
      tokens = null
      user = null
      emit('userUnloaded')
    },

    /** End the server session and go to postLogoutRedirectUri. */
    logout() {
      const params = new URLSearchParams()
      if (tokens?.id_token) params.append('id_token_hint', tokens.id_token)
      params.append('post_logout_redirect_uri', cfg.postLogoutRedirectUri)
      api.removeUser()
      globalThis.location.assign(`${cfg.endpoint}/oauth/logout?${params}`)
    },

    /**
     * For `createClient({ tokenProvider })`. A 401 clears → starts a renewal,
     * and the retried request waits for it.
     */
    tokenProvider() {
      return {
        async getToken() {
          if (renewal) await renewal.catch(() => {})
          return api.token
        },
        clear() {
          api.renew().catch(() => {})
        },
      }
    },
  }
  return api
}
