import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createClient, createBrowserLogin, silentCallback, SynthigyError } from '../src/index.js'

const APP = 'http://app.test'
const ENGINE = 'http://engine.test'
const CB = `${APP}/cb`

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const jwt = (claims) => `e30.${b64url(JSON.stringify(claims))}.sig`
const json = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body })

let env
function installBrowser(href = `${APP}/movies?x=1`) {
  const store = new Map()
  const listeners = new Set()
  env = {
    assigned: [],
    frames: [],
    onFrame: null,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      size: () => store.size,
    },
    message(e) { for (const f of [...listeners]) f(e) },
  }
  const loc = new URL(href)
  globalThis.location = {
    get href() { return loc.href },
    get pathname() { return loc.pathname },
    get search() { return loc.search },
    get hash() { return loc.hash },
    get origin() { return loc.origin },
    assign: (u) => env.assigned.push(u),
  }
  globalThis.history = { replaceState: (_s, _t, url) => { loc.href = new URL(url, loc.origin).href } }
  const win = {
    addEventListener: (_t, f) => listeners.add(f),
    removeEventListener: (_t, f) => listeners.delete(f),
  }
  win.parent = win
  globalThis.window = win
  globalThis.document = {
    createElement: () => {
      const frame = { style: {}, contentWindow: {}, removed: false, remove() { this.removed = true } }
      env.frames.push(frame)
      return frame
    },
    body: { appendChild: (frame) => env.onFrame?.(frame) },
  }
  return loc
}

afterEach(() => {
  for (const k of ['location', 'history', 'window', 'document']) delete globalThis[k]
})

function tokenServer(respond) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, form: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null })
    return respond(url, init, calls)
  }
  return { fetch, calls }
}

const loginWith = (fetch, extra = {}) =>
  createBrowserLogin({ endpoint: ENGINE, clientId: 'spa', redirectUri: CB, fetch, storage: env.storage, ...extra })

// Answer the silent iframe the way the silent-redirect page would.
function answerFrames({ code = 'silent-code', state: forceState } = {}) {
  env.onFrame = (frame) => {
    const state = forceState ?? new URL(frame.src).searchParams.get('state')
    setTimeout(() => env.message({
      origin: APP, source: frame.contentWindow,
      data: { source: 'synthigy-login', url: `${CB}?code=${code}&state=${state}` },
    }), 0)
  }
}

// Token endpoint that echoes back the nonce the pending/silent request used.
function nonceEchoingServer(access = 'at-1') {
  let n = 0
  const nonces = []
  const server = tokenServer(async (url) => {
    if (url.endsWith('/oauth/token')) {
      n += 1
      return json(200, { access_token: `${access}-${n}`, expires_in: 3600, id_token: jwt({ sub: 'alice', xid: 'x-alice', nonce: nonces.shift() }) })
    }
    return json(404, {})
  })
  return { ...server, nonces }
}

describe('createBrowserLogin', () => {
  beforeEach(() => installBrowser())

  it('needs endpoint, clientId and redirectUri', () => {
    assert.throws(() => createBrowserLogin({ endpoint: ENGINE }),
      (e) => e instanceof SynthigyError && e.code === 'CONFIG_ERROR' && e.category === 'validation')
  })

  it('start stores the pending login and redirects to authorize with PKCE, no secret', async () => {
    const login = loginWith(async () => json(500, {}), { audience: 'https://synthigy.com' })
    await login.start()
    const u = new URL(env.assigned[0])
    assert.equal(u.origin + u.pathname, `${ENGINE}/oauth/authorize`)
    const q = Object.fromEntries(u.searchParams)
    assert.deepEqual(
      { response_type: q.response_type, client_id: q.client_id, redirect_uri: q.redirect_uri,
        scope: q.scope, code_challenge_method: q.code_challenge_method, audience: q.audience },
      { response_type: 'code', client_id: 'spa', redirect_uri: CB, scope: 'openid profile',
        code_challenge_method: 'S256', audience: 'https://synthigy.com' })
    const pending = JSON.parse(env.storage.getItem(`synthigy.login:${q.state}`))
    assert.equal(pending.nonce, q.nonce)
    assert.equal(pending.returnTo, '/movies?x=1')
    assert.equal(q.code_challenge, b64url(createHash('sha256').update(pending.codeVerifier).digest()))
  })

  for (const [ageMs, kept] of [[9 * 60_000, true], [10 * 60_000 + 1000, false]]) {
    it(`a ${Math.floor(ageMs / 60_000)}-minute-old pending login is ${kept ? 'kept — the server allows 8' : 'refused'}`, async () => {
      const server = nonceEchoingServer()
      const login = loginWith(server.fetch)
      await login.start()
      const q = new URL(env.assigned[0]).searchParams
      server.nonces.push(q.get('nonce'))
      const key = `synthigy.login:${q.get('state')}`
      env.storage.setItem(key, JSON.stringify({ ...JSON.parse(env.storage.getItem(key)), createdAt: Date.now() - ageMs }))
      installBrowserKeepingStore(`${CB}?code=the-code&state=${q.get('state')}`)

      if (kept) assert.equal((await login.complete()).user.xid, 'x-alice')
      else await assert.rejects(login.complete(), (e) => e.code === 'LOGIN_STATE_UNKNOWN')
      login.removeUser()
    })
  }

  it('complete exchanges as a public client and returns the user; state is one-shot', async () => {
    const server = nonceEchoingServer()
    const login = loginWith(server.fetch)
    await login.start({ returnTo: '/after' })
    const q = new URL(env.assigned[0]).searchParams
    server.nonces.push(q.get('nonce'))
    installBrowserKeepingStore(`${CB}?code=the-code&state=${q.get('state')}`)
    const loaded = []
    login.on('userLoaded', (u) => loaded.push(u.xid))

    const { user, returnTo } = await login.complete()
    assert.equal(user.xid, 'x-alice')
    assert.equal(returnTo, '/after')
    assert.equal(login.token, 'at-1-1')
    assert.deepEqual(loaded, ['x-alice'])
    const { form, init } = server.calls[0]
    assert.deepEqual(form, { grant_type: 'authorization_code', code: 'the-code', redirect_uri: CB,
      client_id: 'spa', code_verifier: form.code_verifier })
    assert.equal(init.credentials, 'omit')
    assert.equal(init.headers.Authorization, undefined)
    assert.equal(globalThis.location.href, `${APP}/cb`, 'callback params stripped from the URL')
    assert.equal(env.storage.size(), 0)

    installBrowserKeepingStore(`${CB}?code=the-code&state=${q.get('state')}`)
    await assert.rejects(login.complete(), (e) => e.code === 'LOGIN_STATE_UNKNOWN')
    login.removeUser()
  })

  it('complete with no response in the URL is null; an IdP error surfaces as its OAuth code', async () => {
    const login = loginWith(async () => json(500, {}))
    assert.equal(await login.complete(), null)
    await login.start()
    const state = new URL(env.assigned[0]).searchParams.get('state')
    installBrowserKeepingStore(`${CB}?error=access_denied&error_description=nope&state=${state}`)
    await assert.rejects(login.complete(),
      (e) => e.code === 'access_denied' && e.category === 'auth' && e.retryable === false)
  })

  it('nonce mismatch is refused', async () => {
    const server = tokenServer(async () => json(200, { access_token: 'a', id_token: jwt({ xid: 'x', nonce: 'wrong' }) }))
    const login = loginWith(server.fetch)
    await login.start()
    const state = new URL(env.assigned[0]).searchParams.get('state')
    installBrowserKeepingStore(`${CB}?code=c&state=${state}`)
    await assert.rejects(login.complete(), (e) => e.code === 'LOGIN_NONCE_MISMATCH')
  })

  it('cancel drops the pending login and recovers where the visitor was', async () => {
    const login = loginWith(async () => json(500, {}))
    await login.start({ returnTo: '/back' })
    const state = new URL(env.assigned[0]).searchParams.get('state')
    installBrowserKeepingStore(`${CB}?error=access_denied&state=${state}`)
    assert.deepEqual(login.cancel(), { returnTo: '/back' })
    assert.equal(env.storage.size(), 0)
  })

  it('renew goes through a hidden prompt=none iframe, one renewal at a time', async () => {
    const server = nonceEchoingServer('renewed')
    const login = loginWith(server.fetch)
    env.onFrame = (frame) => {
      const src = new URL(frame.src)
      assert.equal(src.searchParams.get('prompt'), 'none')
      server.nonces.push(src.searchParams.get('nonce'))
      setTimeout(() => env.message({
        origin: APP, source: frame.contentWindow,
        data: { source: 'synthigy-login', url: `${CB}?code=silent&state=${src.searchParams.get('state')}` },
      }), 0)
    }
    const a = login.renew()
    const b = login.renew()
    assert.equal(a, b, 'concurrent callers share one renewal')
    const user = await a
    assert.equal(user.xid, 'x-alice')
    assert.equal(login.token, 'renewed-1')
    assert.equal(env.frames.length, 1)
    assert.ok(env.frames[0].removed)
    login.removeUser()
  })

  it('renew rejects a foreign state and times out, reporting silentRenewError', async () => {
    const login = loginWith(async () => json(500, {}), { silentTimeoutMs: 20 })
    const errors = []
    login.on('silentRenewError', (e) => errors.push(e.code))
    answerFrames({ state: 'someone-else' })
    await assert.rejects(login.renew(), (e) => e.code === 'LOGIN_STATE_UNKNOWN')
    env.onFrame = () => {}
    await assert.rejects(login.renew(), (e) => e.code === 'SILENT_TIMEOUT' && e.category === 'auth')
    assert.deepEqual(errors, ['LOGIN_STATE_UNKNOWN', 'SILENT_TIMEOUT'])
  })

  it('a 401 on the client renews through the provider and retries with the new token', async () => {
    const nonces = []
    const seen = []
    let n = 0
    const fetch = async (url, init = {}) => {
      if (url.endsWith('/oauth/token')) {
        n += 1
        return json(200, { access_token: `t${n}`, expires_in: 3600, id_token: jwt({ xid: 'x', nonce: nonces.shift() }) })
      }
      seen.push(init.headers.Authorization)
      return init.headers.Authorization === 'Bearer t2'
        ? json(200, { results: [{ ok: true, data: [{ name: 'A' }] }] })
        : json(401, {})
    }
    const login = loginWith(fetch)
    env.onFrame = (frame) => {
      const src = new URL(frame.src)
      nonces.push(src.searchParams.get('nonce'))
      setTimeout(() => env.message({ origin: APP, source: frame.contentWindow,
        data: { source: 'synthigy-login', url: `${CB}?code=c&state=${src.searchParams.get('state')}` } }), 0)
    }
    await login.renew()
    assert.equal(login.token, 't1')

    const client = createClient({ endpoint: ENGINE, tokenProvider: login.tokenProvider(), fetch })
    const rows = await client.search('building', null, { name: null })
    assert.deepEqual(rows, [{ name: 'A' }])
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2'])
    login.removeUser()
  })
})

describe('silentCallback', () => {
  it('answers the parent from inside the renewal iframe, and does nothing in a top window', () => {
    installBrowser(`${CB}?code=c&state=s1`)
    assert.equal(silentCallback(), false, 'top window')
    const posted = []
    globalThis.window.parent = { postMessage: (data, origin) => posted.push({ data, origin }) }
    assert.equal(silentCallback(), true)
    assert.deepEqual(posted, [{ data: { source: 'synthigy-login', url: `${CB}?code=c&state=s1` }, origin: APP }])
  })
})

// Navigate (the callback) without losing sessionStorage — the same tab.
function installBrowserKeepingStore(href) {
  const storage = env.storage
  const assigned = env.assigned
  installBrowser(href)
  env.storage = storage
  env.assigned = assigned
}

describe('createBrowserLogin loadUserInfo', () => {
  it('loadUserInfo merges /oauth/userinfo into the user, refusing a different sub', async () => {
    const run = async (infoSub) => {
      installBrowser()
      const nonces = []
      const server = tokenServer(async (url, init) => {
        if (url.endsWith('/oauth/token')) {
          return json(200, { access_token: 'at', expires_in: 3600, id_token: jwt({ sub: 'alice', xid: 'x-alice', nonce: nonces.shift() }) })
        }
        if (url.endsWith('/oauth/userinfo')) {
          assert.equal(init.headers.Authorization, 'Bearer at')
          return json(200, { sub: infoSub, name: 'Alice A.' })
        }
        return json(404, {})
      })
      const login = loginWith(server.fetch, { loadUserInfo: true })
      await login.start()
      const q = new URL(env.assigned[0]).searchParams
      nonces.push(q.get('nonce'))
      installBrowserKeepingStore(`${CB}?code=c&state=${q.get('state')}`)
      try { return await login.complete() } finally { login.removeUser() }
    }
    const { user } = await run('alice')
    assert.equal(user.name, 'Alice A.')
    assert.equal(user.xid, 'x-alice')
    await assert.rejects(run('mallory'), (e) => e.code === 'USERINFO_SUB_MISMATCH')
  })
})
