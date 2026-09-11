/**
 * Live Movies demo — exercises the bare `watch()` primitive end-to-end.
 *
 * Demonstrates:
 *   1. Snapshot a Movie + its current ratings via /data.
 *   2. Open ONE Watch covering the movie + every rating xid.
 *   3. Open a SECOND, unrelated Watch (the current user). Both fuse onto
 *      one SSE + one consolidated POST /data/subscription/set.
 *   4. React to record/update (apply `after` directly, no refetch),
 *      relation/link (fetch new child + grow the watch set).
 *   5. Drive a few writes ourselves to see events arrive; demonstrate
 *      `muteRequest` to suppress the echo of our own optimistic write.
 *
 * Run from `sdk/js/`:
 *     node examples/movies-live.mjs
 *
 * Requires a Synthigy server at localhost:7887 with the Movies ERD
 * deployed.
 * Falls back to a static empty token (works in dev mode with
 * SYNTHIGY_IAM_ALLOW_PUBLIC=true).
 */

import { connect, disconnect, search, get, sync, watch } from "../src/index.js"

const ENDPOINT = process.env.SYNTHIGY_ENDPOINT ?? "http://localhost:7887"
const TOKEN    = process.env.SYNTHIGY_TOKEN ?? ""

// Connect once as this process's single client; then call the bare verbs.
connect({
  endpoint: ENDPOINT,
  token: TOKEN,
  keyFormat: "kebab",
})

// ────────────────────────────────────────────────────────────────────────────
// 1. Snapshot the movie we want to watch.
// ────────────────────────────────────────────────────────────────────────────

const movie = await search(
  "Movie",
  { _limit: 1 },
  {
    xid: null,
    title: null,
    "release-year": null,
    ratings: {
      xid: null,
      value: null,
      timestamp: null,
    },
  },
).then((rows) => rows[0])

if (!movie) {
  console.error("No movies found. Deploy the Movies dataset first.")
  process.exit(1)
}

console.log(`Snapshot: ${movie.title} (${movie["release-year"]}) — ${movie.ratings?.length ?? 0} ratings`)

// ────────────────────────────────────────────────────────────────────────────
// 2. Build a local cache the watch will keep current.
// ────────────────────────────────────────────────────────────────────────────

const cache = new Map()
cache.set(movie.xid, movie)
for (const r of movie.ratings ?? []) cache.set(r.xid, r)

// ────────────────────────────────────────────────────────────────────────────
// 3. Open the movie-page watch.
// ────────────────────────────────────────────────────────────────────────────

const ac = new AbortController()
const moviePage = watch(
  {
    records: [movie.xid, ...(movie.ratings ?? []).map((r) => r.xid)],
  },
  { signal: ac.signal },
)

// 4. Open a SECOND watch on the same client. The multiplexer fuses both
//    onto ONE SSE + ONE setSubscriptions POST. We don't need a real user
//    xid here; the point is to demonstrate that opening many watches is
//    cheap (no extra HTTP, no extra SSE).
const me = watch({ records: [movie.xid] }, { signal: ac.signal })

// ────────────────────────────────────────────────────────────────────────────
// 5. Consume the movie-page watch.
// ────────────────────────────────────────────────────────────────────────────

async function consumeMoviePage() {
  for await (const ev of moviePage.events) {
    // Watch events carry `record` (record/*) or `data: [subscribed, other]`
    // (relation/*) — never fromXid/toXid/relation (those are /history fields).
    switch (ev.type) {
      case "record/update": {
        const local = cache.get(ev.record)
        if (local) {
          Object.assign(local, ev.after) // direct patch — no refetch
          console.log(
            `~ update ${ev.record} by ${ev.actor ?? "?"}: ${ev.changed?.join(", ")}`,
          )
        }
        break
      }
      case "record/insert":
        console.log(`+ insert ${ev.record}`)
        break
      case "record/delete":
        cache.delete(ev.record)
        console.log(`- delete ${ev.record}`)
        break
      case "relation/link": {
        // data[0] is always our subscribed endpoint (the movie); data[1] is
        // the other side — the newly-linked UserRating. Fetch it + extend the
        // watch set so future updates to that rating flow in too.
        const [, ratingXid] = ev.data
        const r = await get(
          "UserRating",
          { xid: ratingXid },
          { xid: null, value: null, timestamp: null },
        )
        if (r) {
          cache.set(r.xid, r)
          moviePage.add([r.xid]) // SDK debounces a single setSubscriptions POST
          console.log(`+ new rating ${r.xid} value=${r.value}`)
        }
        break
      }
      case "relation/unlink": {
        const [subscribed, other] = ev.data
        console.log(`- unlink ${subscribed}→${other}`)
        break
      }
      case "connection/resumed":
        console.log("⟳ connection resumed; consider refreshing your cache")
        break
      case "schema/changed":
        console.log("⟳ schema deploy detected; attribute names refreshed")
        break
      case "subscription/rejected":
        console.error(`✗ subscription rejected: ${ev.reason}`)
        break
      case "paused":
        console.warn("⏸ buffer full — events dropped; consider 'coalesce' mode")
        break
    }
  }
}

// Drain the second watch in parallel — same data, different consumer.
// Demonstrates that two consumers can independently iterate the SDK's
// multiplexed stream without affecting each other.
async function consumeMe() {
  for await (const ev of me.events) {
    if (ev.type === "record/update") {
      console.log(`  [me] saw update on ${ev.record} (changed: ${ev.changed?.join(",")})`)
    }
  }
}

// Both consumers run independently; closing one doesn't affect the other.
const drainers = Promise.all([consumeMoviePage(), consumeMe()])

// ────────────────────────────────────────────────────────────────────────────
// 6. Drive a self-write to see an event arrive — and demonstrate muteRequest.
// ────────────────────────────────────────────────────────────────────────────

await new Promise((r) => setTimeout(r, 500)) // give SSE time to connect

const myRequestId = crypto.randomUUID()
moviePage.muteRequest(myRequestId) // suppress the echo of our own write
console.log(`→ self-write (request-id ${myRequestId.slice(0, 8)}…)`)

// In a real app you'd pipe request-id through a header; the spike just
// logs to demonstrate the mute primitive. The actual write:
try {
  await sync("Movie", {
    xid: movie.xid,
    title: movie.title, // no-op edit — server still emits an event
  })
} catch (e) {
  console.error("self-write failed:", e.message)
}

// ────────────────────────────────────────────────────────────────────────────
// 7. Idle. Press Ctrl-C to exit.
// ────────────────────────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\nshutting down…")
  ac.abort()                         // drops both watches
  await drainers.catch(() => {})
  disconnect()                       // close the single client's SSE session
  process.exit(0)
})

await drainers
