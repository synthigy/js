/**
 * datastar-movies — Synthigy SDK live-data showcase.
 *
 *   Browser (Datastar, no JS framework)
 *      ↕ HTML + SSE patches
 *   Node BFF (this file)
 *      ↕ @synthigy/sdk (watch / watchQuery / watchSqlTemplate)
 *   Synthigy server (/data, /oauth, /data/events)
 *
 * One SDK client per process → ONE SSE BFF→Synthigy regardless of how
 * many browser sessions are open. Each browser page opens ONE SSE
 * browser→BFF; the BFF translates SDK watch events into Datastar
 * element patches and pushes them down.
 *
 * Tokens NEVER touch the browser. OIDC code+PKCE flow; session is a
 * cookie-keyed in-memory record.
 *
 * Run from sdk/js/examples/datastar-movies:
 *   SYNTHIGY_CLIENT_ID=datastar-movies \
 *   SYNTHIGY_CLIENT_SECRET=… \
 *   node serve.ts
 *
 * Required env:
 *   SYNTHIGY_CLIENT_ID       OAuth client (authorization_code grant)
 *   SYNTHIGY_CLIENT_SECRET   ditto
 * Optional:
 *   SYNTHIGY_ENDPOINT        default http://localhost:7887
 *   PORT                     default 5174
 *   BASE_URL                 default http://localhost:5174  (used for redirect_uri)
 *
 * See README.md for setup (deploy Movies dataset, register OAuth client).
 */

// Demo BFF: don't let a stray rejection from an aborted watch / SSE
// teardown crash the server. Real prod code should fix the source.
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message ?? String(reason)
  const isBenignAbort = reason?.name === "AbortError"
    || /aborted/i.test(msg)
  if (isBenignAbort) {
    console.warn("[unhandledRejection] swallowed AbortError:", msg)
    return
  }
  console.error("[unhandledRejection]", reason)
})

import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { configure, client, Movie, UserRating, MovieActor, MovieGenre, Dashboard } from "./generated/ops.ts"
import type { MovieList, MovieActorList, MovieGenreList, MovieDetail } from "./generated/ops.ts"

import {
  getSession, requireSession, startLogin, completeLogin, logout,
  applyLogin, applyLogout, AuthError, dropSession,
} from "./lib/auth.ts"
import {
  sseHeaders, patchElements, patchSignals, removeElement, pipeWatch, esc,
} from "./lib/bff.ts"

// Append one line to the in-page event console (#debug-log on /movies).
// Each line is class-tagged so the CSS can color-code by event kind
// (link=green, unlink=red, changed=amber, sentinels=gray, warn=red).
function debugLine(res: ServerResponse, type: string, detail = "", warn = false) {
  const ts = new Date().toISOString().slice(11, 23)
  const kind = warn ? "warn" : classifyEvent(type)
  const html = `<span class="ev-row ev-${kind}">`
    + `<span class="ev-time">${ts}</span>`
    + `<span class="ev-type">${esc(type)}</span>`
    + `<span class="ev-detail">${esc(detail)}</span>`
    + `</span>`
  patchElements(res, { selector: "#debug-log", html, mode: "append" })
}

function classifyEvent(type: string) {
  if (type.includes("/link") || type.includes("/added") || type.includes("/insert")) return "add"
  if (type.includes("/unlink") || type.includes("/removed") || type.includes("/delete")) return "remove"
  if (type.includes("/changed") || type.includes("/update")) return "change"
  // Stream-lifecycle sentinels + snapshot replays.
  if (type === "stream/open" || type === "watch/ready" || type === "snapshot/sync"
      || type.startsWith("sentinel/")) return "info"
  return "info"
}

import { landingPage } from "./views/landing.ts"
import { moviesPage, movieRow, searchMeta, moviesPagerInner, actorChip, ACTOR_PICKER_PAGE, movieDetailPage, movieDetailCard, dashboardPage } from "./views/movies.ts"
import { actorsPage, actorRow, actorDetailPage, actorDetailCard } from "./views/actors.ts"

// Returns "stale-session" when the SDK error implies the cached
// session.user.xid (or the cached client token) is no longer valid
// server-side — the only recovery is to drop the BFF session and
// force a re-login. Returns null otherwise.
//
// Server emits typed `code` discriminants (wire-triage 2026-05-30) so
// this is a small set membership check, not a regex over message text.
// HTTP_ERROR with details containing one of the auth-class codes is
// also handled — token-exchange failures bubble up as HTTP_ERROR
// wrapping the OAuth server's error code.
const STALE_SESSION_CODES = new Set([
  "USER_NOT_FOUND",       // acting_as user is gone
  "CLIENT_NOT_FOUND",     // OAuth client is gone
  "CLIENT_INACTIVE",      // OAuth client deactivated
  "UNAUTHORIZED",         // token rejected
])
function classifySdkError(e: any) {
  if (STALE_SESSION_CODES.has(e?.code)) return "stale-session"
  // Token-exchange failures surface as HTTP_ERROR; the OAuth server's
  // own error code rides on `e.details`.
  if (e?.code === "HTTP_ERROR"
      && typeof e?.details === "string"
      && /invalid_client|invalid_grant/.test(e.details)) {
    return "stale-session"
  }
  return null
}

// Bounce to /login after dropping the bad session — leaves a banner
// query-string so the login page (or the next /movies render) can
// say *why* the user got kicked out.
function bounceToLogin(req: IncomingMessage, res: ServerResponse, returnTo: string, reason: string) {
  const sid = logout(req)           // also clears file-store entry
  if (sid) dropSession(sid)         // belt-and-suspenders for callers that pass req but expect server-side cleanup
  applyLogout(res, `/login?returnTo=${encodeURIComponent(returnTo)}&reason=${encodeURIComponent(reason)}`)
}

const HERE          = dirname(fileURLToPath(import.meta.url))
const ENDPOINT      = process.env.SYNTHIGY_ENDPOINT ?? "http://localhost:7887"
const CLIENT_ID     = process.env.SYNTHIGY_CLIENT_ID
const CLIENT_SECRET = process.env.SYNTHIGY_CLIENT_SECRET
const PORT          = Number(process.env.PORT ?? 5174)
const BASE_URL      = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "")
const REDIRECT_URI  = `${BASE_URL}/auth/callback`

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("SYNTHIGY_CLIENT_ID and SYNTHIGY_CLIENT_SECRET are required.")
  console.error("See README.md for how to register an OAuth client.")
  process.exit(1)
}

// ──────────────────────────────────────────────────────────────────────────
// SDK — one client per process. Watches multiplex onto its single SSE.
// ──────────────────────────────────────────────────────────────────────────

configure({
  endpoint:     ENDPOINT,
  clientId:     CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  // Pin the upstream SSE open for the lifetime of the BFF so events
  // aren't lost between browser sessions.
  keepAlive:    true,
})


// ──────────────────────────────────────────────────────────────────────────
// Router — tiny hand-rolled (Node http, no framework dep).
// ──────────────────────────────────────────────────────────────────────────

type Params = Record<string, string>
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params) => unknown
type Route = { method: string; pattern: string | RegExp; handler: Handler }

const routes: Route[] = []
const route = (method: string, pattern: string | RegExp, handler: Handler) =>
  routes.push({ method, pattern, handler })

function matchRoute(method: string, url: URL): { handler: Handler; params: Params } | null {
  for (const r of routes) {
    if (r.method !== method) continue
    if (typeof r.pattern === "string") {
      if (r.pattern === url.pathname) return { handler: r.handler, params: {} }
    } else {
      const m = url.pathname.match(r.pattern)
      if (m) return { handler: r.handler, params: m.groups ?? {} }
    }
  }
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// Pages — HTML
// ──────────────────────────────────────────────────────────────────────────

route("GET", "/", async (req, res) => {
  const user = getSession(req)?.user
  send(res, 200, "text/html", landingPage({ user }))
})

const MOVIES_SINCE = 1995   // floor matches the live /stream/movies watch
const PER_PAGE = 20

route("GET", "/movies", async (req, res) => {
  const sess = requireSession(req, res, "/movies"); if (!sess) return
  const url    = new URL(req.url ?? "/", BASE_URL)
  const term   = (url.searchParams.get("q") || "").trim()
  const page    = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1)
  const q       = term ? `%${term}%` : "%"          // always passed; "%" = match all
  const offset  = (page - 1) * PER_PAGE

  let initial: MovieList[] = [], actors: MovieActorList[] = [], genres: MovieGenreList[] = [], total = 0, pageError: string | null = null
  try {
    // List rows + a typed filtered count — both XSQL ops. Count is a typed
    // sql-template (Movie.count, @returns total:int); ?q="%" default = match all,
    // so no host-built SQL and no raw client() escape hatch.
    let countRows
    ;[initial, actors, genres, countRows] = await Promise.all([
      Movie.list({ since: MOVIES_SINCE, q, limit: PER_PAGE, offset }, { actingAs: sess.user.xid }),
      MovieActor.list({ limit: ACTOR_PICKER_PAGE, offset: 0 }, { actingAs: sess.user.xid }),
      MovieGenre.list({ limit: 100 }, { actingAs: sess.user.xid }),
      Movie.count({ since: MOVIES_SINCE, q }, { actingAs: sess.user.xid }),
    ])
    total = countRows?.[0]?.total ?? 0   // typed number — no coercion
    console.log(`[/movies] page=${page} term="${term}" got ${initial.length}/${total}`)
  } catch (e) {
    console.error(`[/movies] search failed:`, e.message, e.details || "")
    if (classifySdkError(e) === "stale-session") {
      return bounceToLogin(req, res, "/movies", "session-expired")
    }
    pageError = `${e.message}${e.details ? " — " + e.details : ""}`
  }
  send(res, 200, "text/html", moviesPage({
    user: sess.user, initial, actors, genres, error: pageError,
    term, page, total, perPage: PER_PAGE,
  }))
})

// Debounced live search — patches ONLY the list fragments (no full reload).
// The ty-input fires a 400ms-debounced CustomEvent; Datastar @get's here and
// we answer with patch-elements for #movies / #movies-meta / #movies-pager.
// We also re-point the live stream (replacing #movie-stream aborts the old SSE
// via its req.on("close")) and sync the URL so reload/back/tab-switch match.
route("GET", "/movies-search", async (req, res) => {
  const sess = getSession(req); if (!sess) return send(res, 401, "text/plain", "")
  const url  = new URL(req.url ?? "/", BASE_URL)
  const term = (url.searchParams.get("q") || "").trim()
  const q    = term ? `%${term}%` : "%"
  sseHeaders(res)
  try {
    const [rows, countRows] = await Promise.all([
      Movie.list({ since: MOVIES_SINCE, q, limit: PER_PAGE, offset: 0 }, { actingAs: sess.user.xid }),
      Movie.count({ since: MOVIES_SINCE, q }, { actingAs: sess.user.xid }),
    ])
    const total = countRows?.[0]?.total ?? 0
    const pages = Math.max(1, Math.ceil(total / PER_PAGE))
    patchElements(res, { selector: "#movies", mode: "inner",
      html: rows.map((m) => movieRow(m)).join("")
        || `<li class="empty-panel" style="padding:18px 22px">No movies match “${esc(term)}”.</li>` })
    patchElements(res, { selector: "#movies-meta", mode: "inner", html: searchMeta(term, total) })
    patchElements(res, { selector: "#movies-pager", mode: "inner", html: moviesPagerInner(term, 1, pages) })
    const qs = term ? `?q=${encodeURIComponent(term)}` : ""
    patchElements(res, { selector: "#movie-stream", mode: "outer",
      html: `<div id="movie-stream" data-init="@get('/stream/movies${qs}')"></div>` })
    patchElements(res, { selector: "body", mode: "append",
      html: `<div data-init="history.replaceState(null,'','/movies${qs}')"></div>` })
  } catch (e) {
    console.error(`[/movies-search] q="${term}" failed:`, e.message)
  }
  res.end()
})

route("GET", /^\/movies\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  const sess = requireSession(req, res, `/movies/${xid}`); if (!sess) return
  // Movie.detail() uses get — sdk.search with { xid } filter doesn't work
  // (server "Character cannot be cast to Map$Entry" on that path).
  // Actor + genre lists ride along to populate the edit modal's pickers.
  let movie = null, actors: MovieActorList[] = [], genres: MovieGenreList[] = []
  try {
    ;[movie, actors, genres] = await Promise.all([
      Movie.detail({ xid }, { actingAs: sess.user.xid }),
      MovieActor.list({ limit: ACTOR_PICKER_PAGE, offset: 0 }, { actingAs: sess.user.xid }),
      MovieGenre.list({ limit: 100 }, { actingAs: sess.user.xid }),
    ])
  } catch (e) {
    console.error(`[/movies/${xid}] get failed:`, e.message, e.details || "")
    if (classifySdkError(e) === "stale-session") {
      return bounceToLogin(req, res, `/movies/${xid}`, "session-expired")
    }
    return send(res, 500, "text/html",
      `<h1>Movie fetch failed</h1><pre>${esc(e.message)}\n${esc(e.details || "")}</pre>`)
  }
  if (!movie) return send(res, 404, "text/html", "<h1>Not found</h1>")
  send(res, 200, "text/html", movieDetailPage({ user: sess.user, movie, actors, genres }))
})

route("GET", "/dashboard", async (req, res) => {
  const sess = requireSession(req, res, "/dashboard"); if (!sess) return
  send(res, 200, "text/html", dashboardPage({ user: sess.user }))
})

const ACTORS_PER_PAGE = 40

route("GET", "/actors", async (req, res) => {
  const sess = requireSession(req, res, "/actors"); if (!sess) return
  let initial: MovieActorList[] = []
  try {
    initial = await MovieActor.list({ limit: ACTORS_PER_PAGE, offset: 0 }, { actingAs: sess.user.xid })
  } catch (e) {
    console.error(`[/actors] list failed:`, e.message)
    if (classifySdkError(e) === "stale-session")
      return bounceToLogin(req, res, "/actors", "session-expired")
  }
  send(res, 200, "text/html", actorsPage({ user: sess.user, initial, pageSize: ACTORS_PER_PAGE }))
})

route("GET", /^\/actors\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  const sess = requireSession(req, res, `/actors/${xid}`); if (!sess) return
  let actor = null
  try {
    actor = await MovieActor.detail({ xid }, { actingAs: sess.user.xid })
  } catch (e) {
    console.error(`[/actors/${xid}] get failed:`, e.message)
    if (classifySdkError(e) === "stale-session")
      return bounceToLogin(req, res, `/actors/${xid}`, "session-expired")
    return send(res, 500, "text/html", `<h1>Actor fetch failed</h1><pre>${esc(e.message)}</pre>`)
  }
  if (!actor) return send(res, 404, "text/html", "<h1>Not found</h1>")
  send(res, 200, "text/html", actorDetailPage({ user: sess.user, actor }))
})


// ──────────────────────────────────────────────────────────────────────────
// SSE streams — one per page kind. Each opens a watch + pipes events.
// ──────────────────────────────────────────────────────────────────────────

route("GET", "/stream/movies", async (req, res) => {
  const _t0 = Date.now()
  const sess = getSession(req); if (!sess) return send(res, 401, "text/plain", "")
  sseHeaders(res)
  console.log(`[stream/movies] OPEN`)
  req.on("close", () => {
    console.log(`[stream/movies] CLOSE after ${Date.now()-_t0}ms`)
  })

  // Track the SAME window the page is showing — the list orders by
  // release_year (immutable under rating), so paged-live only ever fires
  // query/changed (in-place), never cross-page add/remove.
  const surl   = new URL(req.url ?? "/", BASE_URL)
  const term   = (surl.searchParams.get("q") || "").trim()
  const page   = Math.max(1, parseInt(surl.searchParams.get("page") || "1", 10) || 1)
  const q      = term ? `%${term}%` : "%"
  const offset = (page - 1) * PER_PAGE

  debugLine(res, "stream/open", `watching Movie page ${page}${term ? ` q="${term}"` : ""} as actingAs=${sess.user.xid ?? "(none)"}`)

  const live = Movie.watchList({ since: MOVIES_SINCE, q, limit: PER_PAGE, offset }, { actingAs: sess.user.xid })
  try {
    await live.ready()
  } catch (e) {
    console.error(`[stream/movies] watch ready failed:`, e.message, e.details || "")
    const kind = classifySdkError(e)
    patchElements(res, {
      selector: "#movies",
      html: `<li id="stream-error" style="background:#3a1212;color:#ffb4b4;border:1px solid #ff4040;padding:14px;border-radius:6px;line-height:1.4;">`
        + `<strong>Live data unavailable.</strong> ${esc(e.message)}`
        + (e.details ? `<br><code style="opacity:.8">${esc(e.details)}</code>` : "")
        + (kind === "stale-session"
            ? `<br><br><a href="/logout" data-on-click="@post('/logout')" style="color:#ffb4b4;text-decoration:underline;">Log out and sign in again</a>`
            : "")
        + `</li>`,
      mode: "inner",
    })
    debugLine(res, "watch/error", `${e.message}${e.details ? " — " + e.details : ""}`, true)
    return res.end()
  }
  debugLine(res, "watch/ready", `${live.list().length} rows in initial set; awaiting events…`)

  patchElements(res, { selector: "#movies", html: live.list().map((m) => movieRow(m)).join(""), mode: "inner" })
  debugLine(res, "snapshot/sync", `replayed ${live.list().length} rows`)

  await pipeWatch(req, res, live, (ev) => {
    const xid = (ev as any).record?.xid ?? (ev as any).recordXid ?? ""
    console.log(`[stream/movies] EVT ${ev.type} ${xid}`)
    debugLine(res, ev.type, `${xid} actor=${ev.actor ?? "?"} txid=${ev.txid ?? "?"}`)
    if (ev.type === "query/added") {
      patchElements(res, { selector: "#movies", html: movieRow(ev.record as MovieList, { fresh: true }), mode: "append" })
    } else if (ev.type === "query/removed") {
      removeElement(res, `#movie-${ev.recordXid}`)
    } else if (ev.type === "query/changed") {
      patchElements(res, { selector: `#movie-${(ev as any).record.xid}`, html: movieRow((ev as any).record, { fresh: true }), mode: "outer" })
    }
  }, {
    onSentinel: (s) => {
      debugLine(res, `sentinel/${s.type}`, JSON.stringify(s).slice(0, 200), true)
    },
  })
})

route("GET", /^\/stream\/movies\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  const sess = getSession(req); if (!sess) return send(res, 401, "text/plain", "")
  sseHeaders(res)

  const live = Movie.watchDetail({ xid }, { actingAs: sess.user.xid })
  try {
    await live.ready()
  } catch (e) {
    console.error(`[stream/movies/${xid}] watch ready failed:`, e.message)
    return res.end()
  }
  if (!live.records.size) return res.end()

  await pipeWatch(req, res, live, (ev) => {
    if (ev.type === "query/changed") {
      patchElements(res, { selector: `#movie-${xid}`, html: movieDetailCard(ev.record as MovieDetail), mode: "outer" })
    }
  })
})

route("GET", "/stream/dashboard", async (req, res) => {
  const sess = getSession(req); if (!sess) return send(res, 401, "text/plain", "")
  sseHeaders(res)

  const live = Dashboard.watchStats({ actingAs: sess.user.xid })

  live.ready().then(() => {
    const s = live.first
    if (!s) return
    patchElements(res, { selector: "#counter-movies-val",  html: esc(String(s.total_movies  ?? "…")) })
    patchElements(res, { selector: "#counter-ratings-val", html: esc(String(s.total_ratings ?? "…")) })
    patchElements(res, { selector: "#counter-avg-val",     html: esc(s.avg_rating != null ? `${s.avg_rating.toFixed(2)} ★` : "—") })
    patchElements(res, { selector: "#counter-actors-val",  html: esc(String(s.total_actors  ?? "…")) })
  }).catch(() => {})

  await pipeWatch(req, res, live, (ev) => {
    if (ev.type === "result/changed") {
      const s = (ev as any).after[0]
      if (!s) return
      patchElements(res, { selector: "#counter-movies-val",  html: esc(String(s.total_movies  ?? 0)) })
      patchElements(res, { selector: "#counter-ratings-val", html: esc(String(s.total_ratings ?? 0)) })
      patchElements(res, { selector: "#counter-avg-val",     html: esc(s.avg_rating != null ? `${s.avg_rating.toFixed(2)} ★` : "—") })
      patchElements(res, { selector: "#counter-actors-val",  html: esc(String(s.total_actors  ?? 0)) })
    }
  })
})

// Infinite-scroll load-more (pure pagination, no watch). Same technique as the
// modal picker: ty-scroll-container fires `nearend`, the handler gates a sync
// flag, we append the next page and re-arm the cursor via patchSignals.
route("GET", "/actors-more", async (req, res) => {
  const sess = getSession(req); if (!sess) return send(res, 401, "text/plain", "")
  const url    = new URL(req.url ?? "/", BASE_URL)
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0)
  sseHeaders(res)
  try {
    const batch = await MovieActor.list({ limit: ACTORS_PER_PAGE, offset }, { actingAs: sess.user.xid })
    if (batch.length)
      patchElements(res, { selector: "#actors", html: batch.map(actorRow).join(""), mode: "append" })
    patchSignals(res, {
      actorsOffset: offset + batch.length,
      actorsMore: batch.length === ACTORS_PER_PAGE,
    })
  } catch (e) {
    console.error(`[/actors-more] offset=${offset} failed:`, e.message)
    patchSignals(res, { actorsMore: false })
  }
  res.end()
})

// New-movie modal actor picker: server-side search + infinite scroll.
// offset 0 = replace the list (initial / new search term); offset>0 = append
// the next page. patchSignals advances the cursor and re-arms `_pickerMore`
// (false when the last page came up short → scrolling stops).
route("GET", "/actors-picker", async (req, res) => {
  const sess   = getSession(req); if (!sess) return send(res, 401, "text/plain", "")
  const url    = new URL(req.url ?? "/", BASE_URL)
  const term   = (url.searchParams.get("q") || "").trim()
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0)
  const q      = term ? `%${term}%` : "%"
  sseHeaders(res)
  try {
    const batch = await MovieActor.list({ limit: ACTOR_PICKER_PAGE, offset, q }, { actingAs: sess.user.xid })
    const chips = batch.map(actorChip).join("")
    if (offset === 0)
      patchElements(res, { selector: "#picker-list", mode: "inner",
        html: chips || `<p class="empty-panel" style="margin:0;grid-column:1/-1">No actors match.</p>` })
    else if (chips)
      patchElements(res, { selector: "#picker-list", mode: "append", html: chips })
    patchSignals(res, {
      _pickerOffset: offset + batch.length,
      _pickerMore: batch.length === ACTOR_PICKER_PAGE,
    })
  } catch (e) {
    console.error(`[/actors-picker] q="${term}" offset=${offset} failed:`, e.message)
  }
  res.end()
})

route("GET", /^\/stream\/actors\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  const sess = getSession(req); if (!sess) return send(res, 401, "text/plain", "")
  sseHeaders(res)
  const live = MovieActor.watchDetail({ xid }, { actingAs: sess.user.xid })
  await live.ready()
  const actor = live.records.get(xid) ?? [...live.records.values()][0]
  if (actor) patchElements(res, { selector: `#actor-${xid}`, html: actorDetailCard(actor), mode: "outer" })
  await pipeWatch(req, res, live, (ev) => {
    if (ev.type === "query/changed") {
      const a = live.records.get(xid) ?? [...live.records.values()][0]
      if (a) patchElements(res, { selector: `#actor-${xid}`, html: actorDetailCard(a), mode: "outer" })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Write — POST /movies/:xid/rate
//
// Form-encoded submit from `<form method="POST">`. Reads `rateValue`
// from the body, calls UserRating.stack(…), then 302s back to the
// movie page where the live watch will pick up the new rating.
// ──────────────────────────────────────────────────────────────────────────

// Datastar @post from the detail rate-form / the list "trigger" button. The
// write lands a rating; the UI doesn't need patches in the response — the
// list/detail watch re-renders the affected row. So we answer with an empty
// SSE (datastar is happy, nothing to patch).
route("POST", /^\/movies\/(?<xid>[A-Za-z0-9_-]+)\/rate$/, async (req, res, { xid }) => {
  const sess = getSession(req); if (!sess) return sseRun(res, "window.location='/login'")
  const body = await readJsonOrForm(req)
  const value = Number(body.rateValue ?? body.value)
  if (!Number.isFinite(value) || value <= 0) return sseRun(res, "alert('Pick a rating between 0.5 and 5.')")

  try {
    await UserRating.stack([{ value, movie: { xid } }], { actingAs: sess.user.xid })
    sseHeaders(res); res.end()   // watch handles the UI update
  } catch (e) {
    console.error(`[/rate] failed:`, e.message, e.details || "")
    sseRun(res, `alert(${JSON.stringify("Rating failed: " + e.message)})`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// Write — POST /movies  (create new movie + optional cast)
// ──────────────────────────────────────────────────────────────────────────

// One-shot Datastar SSE: open the stream, run a single expression on the client
// via a patched-in `data-init` element, close. Datastar's only server→client
// events are patch-elements/-signals (no built-in redirect), so navigation and
// error alerts after an @post submit ride on this.
function sseRun(res: ServerResponse, expr: string) {
  sseHeaders(res)
  patchElements(res, { selector: "body", mode: "append", html: `<div data-init="${esc(expr)}"></div>` })
  res.end()
}
// xid-string arrays (from Datastar `$actors`/`$genres` signals) → sync payload.
const toRel = (xids: unknown) =>
  (Array.isArray(xids) ? xids.filter((x): x is string => typeof x === "string") : []).map((xid) => ({ xid }))

route("POST", "/movies", async (req, res) => {
  const sess = getSession(req); if (!sess) return sseRun(res, "window.location='/login'")
  const body = await readJsonOrForm(req)
  const title = String(body.title ?? "").trim()
  if (!title) return sseRun(res, "alert('Title is required.')")
  const data = {
    title,
    ...(body.release_year ? { release_year: Number(body.release_year) } : {}),
    actors: toRel(body.actors),
    genres: toRel(body.genres),
  }
  try {
    // Relations as { xid } links — MovieWrite types them as ({xid}|MovieActorWrite)[],
    // so the link form is accepted directly, no cast.
    await Movie.sync(data, { actingAs: sess.user.xid })
    sseRun(res, "$_modalOpen = false; $title = ''; $release_year = null; $actors = []; $genres = []")
  } catch (e) {
    console.error(`[POST /movies] failed:`, e.message, e.details || "")
    if (classifySdkError(e) === "stale-session") return sseRun(res, "window.location='/login?reason=session-expired'")
    sseRun(res, `alert(${JSON.stringify("Create failed: " + e.message)})`)
  }
})

// Edit — POST /movies/:xid. Same sync payload + xid; relations are sent in full
// (sync REPLACES link-sets, so an empty list unlinks everything).
route("POST", /^\/movies\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  const sess = getSession(req); if (!sess) return sseRun(res, "window.location='/login'")
  const body = await readJsonOrForm(req)
  const title = String(body.title ?? "").trim()
  if (!title) return sseRun(res, "alert('Title is required.')")
  const data = {
    xid,
    title,
    release_year: body.release_year ? Number(body.release_year) : null,
    actors: toRel(body.actors),
    genres: toRel(body.genres),
  }
  try {
    await Movie.sync(data, { actingAs: sess.user.xid })
    sseRun(res, "$_modalOpen = false")
  } catch (e) {
    console.error(`[POST /movies/${xid}] failed:`, e.message, e.details || "")
    if (classifySdkError(e) === "stale-session") return sseRun(res, "window.location='/login?reason=session-expired'")
    sseRun(res, `alert(${JSON.stringify("Save failed: " + e.message)})`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// OIDC routes
// ──────────────────────────────────────────────────────────────────────────

route("GET", "/login", async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const returnTo = url.searchParams.get("returnTo") || "/"
  const authUrl = startLogin({
    endpoint:    ENDPOINT,
    clientId:    CLIENT_ID,
    redirectUri: REDIRECT_URI,
    returnTo,
  })
  res.writeHead(302, { Location: authUrl }); res.end()
})

route("GET", "/auth/callback", async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) return send(res, 400, "text/plain", "missing code or state")
  try {
    const { sid, returnTo } = await completeLogin({
      endpoint:     ENDPOINT,
      clientId:     CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri:  REDIRECT_URI,
      code, state,
      // Synthigy's id_token `sub` is the username, not the xid. The BFF
      // needs the xid to act on the user's behalf, so we resolve via /data
      // immediately after token exchange (and cache in the session).
      resolveUser: (name: string) => client().get("User", { name }, { xid: null, name: null }),
    })
    applyLogin(res, { sid, returnTo })
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500
    send(res, status, "text/plain", e.message)
  }
})

route("POST", "/logout", async (req, res) => {
  logout(req)
  applyLogout(res, "/")
})

// GET variant so error banners ("Log out and sign back in") and old
// browser bookmarks can clear a busted session with a plain anchor.
route("GET", "/logout", async (req, res) => {
  logout(req)
  applyLogout(res, "/")
})

// ──────────────────────────────────────────────────────────────────────────
// Static
// ──────────────────────────────────────────────────────────────────────────

route("GET", /^\/public\//, async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const filename = url.pathname.replace(/^\/public\//, "")
  const path = resolve(HERE, "public", filename)
  if (!path.startsWith(resolve(HERE, "public"))) return send(res, 403, "text/plain", "")
  try {
    const buf = await readFile(path)
    const ext = extname(path).toLowerCase()
    const ct = ext === ".css" ? "text/css"
             : ext === ".js"  ? "application/javascript"
             :                  "application/octet-stream"
    send(res, 200, ct, buf)
  } catch { send(res, 404, "text/plain", "not found") }
})

// Serve the Tyrell components bundle from the installed dependency (no CDN).
// dist/tyrell.js is a self-contained ESM bundle; tyrell.css is the stylesheet.
const TYRELL_DIST = resolve(HERE, "node_modules", "tyrell-components", "dist")
route("GET", /^\/vendor\/tyrell\//, async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const filename = url.pathname.replace(/^\/vendor\/tyrell\//, "")
  const path = resolve(TYRELL_DIST, filename)
  if (!path.startsWith(TYRELL_DIST)) return send(res, 403, "text/plain", "")
  try {
    const buf = await readFile(path)
    const ct = extname(path).toLowerCase() === ".css" ? "text/css" : "application/javascript"
    send(res, 200, ct, buf)
  } catch { send(res, 404, "text/plain", "not found") }
})

// ──────────────────────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer) {
  // Force browsers to fetch fresh HTML/CSS so my edits aren't shadowed
  // by stale page caches. Demo BFF only — don't ship this to prod as-is.
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  })
  res.end(body)
}

async function readJsonOrForm(req: IncomingMessage) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString("utf8")
  const ct = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
  if (ct === "application/json") return JSON.parse(raw || "{}")
  if (ct === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(raw))
  }
  // Datastar @post sends JSON by default — try JSON, fall back to raw.
  try { return JSON.parse(raw) } catch { return { _raw: raw } }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const m = matchRoute(req.method ?? "GET", url)
  if (!m) return send(res, 404, "text/plain", "not found")
  try {
    await m.handler(req, res, m.params)
  } catch (e) {
    console.error("handler error:", e)
    if (!res.headersSent) send(res, 500, "text/plain", "internal error")
  }
})

server.listen(PORT, () => {
  console.log(`
  datastar-movies BFF
    listening : ${BASE_URL}
    upstream  : ${ENDPOINT}
    client_id : ${CLIENT_ID}
    redirect  : ${REDIRECT_URI}

  open ${BASE_URL} in two browser tabs to see the magic.
`)
})
