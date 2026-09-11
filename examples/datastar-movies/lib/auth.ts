// @ts-nocheck — infra plumbing (auth/session, icon rendering); not part of the SDK-facing surface. Type later.
/**
 * OIDC authorization-code flow for the datastar-movies demo.
 *
 * Architecture: this is a BFF (backend-for-frontend) — the browser never
 * sees a token. The login flow goes:
 *
 *   1. browser GET /login
 *   2. server 302 → Synthigy /oauth/authorize?response_type=code&...
 *   3. user logs in on Synthigy
 *   4. browser GET /auth/callback?code=...&state=...
 *   5. server POST /oauth/token (code, client_id, client_secret)
 *   6. server stores tokens in an in-memory session keyed by cookie
 *   7. server 302 → returnTo
 *
 * The cookie is HttpOnly + SameSite=Lax. Tokens stay server-side.
 *
 * For a demo this uses an in-memory Map for sessions — restart the
 * process and everyone logs in again. Production: swap for Postgres /
 * Redis. The shape of `Session` is stable.
 */

import { randomBytes, createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const SESSION_COOKIE = "datastar_movies_sid"
const SESSION_TTL_MS = 8 * 60 * 60 * 1000  // 8h

// File-backed session store so dev restarts don't kick the user out.
// Tokens are sensitive — keep this file outside any committed tree.
const SESSION_FILE = process.env.DATASTAR_MOVIES_SESSION_FILE
  ?? "/tmp/datastar-movies-sessions.json"

function loadSessions() {
  try {
    const raw = readFileSync(SESSION_FILE, "utf8")
    const { sessions: s = [] } = JSON.parse(raw)
    return new Map(s)
  } catch { return new Map() }
}

let savePending = false
function saveSessions() {
  if (savePending) return
  savePending = true
  // Debounce writes — a burst of session ops shouldn't fsync a dozen times.
  setImmediate(() => {
    savePending = false
    try {
      writeFileSync(SESSION_FILE,
        JSON.stringify({ sessions: [...sessions.entries()] }))
    } catch (e) {
      console.warn("[auth] session save failed:", e?.message)
    }
  })
}

// sessionId → { tokens, user, returnTo, expiresAt }
const sessions = loadSessions()
// state → { codeVerifier, returnTo, expiresAt }   for in-flight logins (NOT persisted — short-lived)
const pendingLogins = new Map()

// Drop expired sessions on boot.
{
  const now = Date.now()
  let dropped = 0
  for (const [k, v] of sessions) if (!v?.expiresAt || v.expiresAt < now) { sessions.delete(k); dropped++ }
  if (dropped) saveSessions()
  console.log(`[auth] loaded ${sessions.size} session(s) from ${SESSION_FILE}${dropped ? ` (dropped ${dropped} expired)` : ""}`)
}

setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const [k, v] of sessions)      if (v.expiresAt < now) { sessions.delete(k); changed = true }
  for (const [k, v] of pendingLogins) if (v.expiresAt < now) pendingLogins.delete(k)
  if (changed) saveSessions()
}, 60_000).unref()

// ──────────────────────────────────────────────────────────────────────────
// Cookies
// ──────────────────────────────────────────────────────────────────────────

function parseCookies(req) {
  const out = {}
  const header = req.headers.cookie
  if (!header) return out
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function setSessionCookie(res, sessionId) {
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`)
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

// ──────────────────────────────────────────────────────────────────────────
// Session lookup
// ──────────────────────────────────────────────────────────────────────────

export function getSession(req) {
  const { [SESSION_COOKIE]: sid } = parseCookies(req)
  if (!sid) return null
  const sess = sessions.get(sid)
  if (!sess) return null
  if (sess.expiresAt < Date.now()) { sessions.delete(sid); saveSessions(); return null }
  return sess
}

// ──────────────────────────────────────────────────────────────────────────
// OIDC code flow — kick off + callback
// ──────────────────────────────────────────────────────────────────────────

function base64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function makePKCE() {
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

export function startLogin(opts) {
  const state = base64url(randomBytes(24))
  const pkce = makePKCE()
  pendingLogins.set(state, {
    codeVerifier: pkce.verifier,
    returnTo: opts.returnTo || "/",
    expiresAt: Date.now() + 5 * 60 * 1000,
  })
  const url = new URL(`${opts.endpoint}/oauth/authorize`)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", opts.clientId)
  url.searchParams.set("redirect_uri", opts.redirectUri)
  url.searchParams.set("scope", opts.scope || "openid email profile")
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

export async function completeLogin(opts) {
  const { code, state } = opts
  const pending = pendingLogins.get(state)
  if (!pending) throw new AuthError("Login state expired or unknown", 400)
  pendingLogins.delete(state)

  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri:  opts.redirectUri,
    client_id:     opts.clientId,
    client_secret: opts.clientSecret,
    code_verifier: pending.codeVerifier,
  })
  const resp = await fetch(`${opts.endpoint}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new AuthError(`Token exchange failed (${resp.status}): ${text}`, 500)
  }
  const tokens = await resp.json()

  // Synthigy puts the username in the id_token's `sub` claim (NOT the
  // xid — see synthigy.oidc:185, synthigy.oauth.token:232). We need the
  // xid for `actingAs` on /data calls, so resolve it from the username.
  // Caller passes `resolveUser` (typically `(name) =>
  // sdk.get('User', {name}, {xid, name})`) so this module stays free of
  // SDK dependency direction.
  const username = decodeIdTokenSub(tokens.id_token)
  let user = { name: username, xid: null, scopes: (tokens.scope || "").split(" ").filter(Boolean) }
  if (opts.resolveUser && username) {
    try {
      const resolved = await opts.resolveUser(username)
      if (resolved?.xid) user = { ...user, xid: resolved.xid, name: resolved.name ?? username }
    } catch (_e) { /* fall back to name-only — actingAs will be omitted */ }
  }

  const sid = base64url(randomBytes(24))
  sessions.set(sid, {
    sid,
    tokens,                                  // { access_token, refresh_token, expires_in, id_token }
    user,
    issuedAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  })
  saveSessions()
  return { sid, returnTo: pending.returnTo }
}

export function logout(req) {
  const { [SESSION_COOKIE]: sid } = parseCookies(req)
  if (sid) { sessions.delete(sid); saveSessions() }
  return sid
}

// Drop a known-bad session (stale xid, deleted user, etc.) without
// requiring the request — used by handlers that detect mid-request
// that the cached session.user.xid no longer resolves server-side.
export function dropSession(sid) {
  if (sid && sessions.has(sid)) { sessions.delete(sid); saveSessions() }
}

// ──────────────────────────────────────────────────────────────────────────
// Response helpers
// ──────────────────────────────────────────────────────────────────────────

export function applyLogin(res, { sid, returnTo }) {
  setSessionCookie(res, sid)
  res.writeHead(302, { Location: returnTo })
  res.end()
}

export function applyLogout(res, to = "/") {
  clearSessionCookie(res)
  res.writeHead(302, { Location: to })
  res.end()
}

export function requireSession(req, res, returnTo) {
  const sess = getSession(req)
  if (sess) return sess
  const url = new URL(returnTo, "http://placeholder/")
  res.writeHead(302, { Location: `/login?returnTo=${encodeURIComponent(url.pathname + url.search)}` })
  res.end()
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

export class AuthError extends Error {
  status: number
  constructor(msg: string, status: number) { super(msg); this.status = status }
}

function decodeIdTokenSub(idToken) {
  if (!idToken || typeof idToken !== "string") return null
  const parts = idToken.split(".")
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
    return payload.sub ?? null
  } catch { return null }
}
