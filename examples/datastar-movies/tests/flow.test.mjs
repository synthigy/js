/**
 * Backend flow tests — confirm Synthigy + the Datastar BFF agree.
 *
 * These replay the EXACT operations the BFF performs for each frontend
 * interaction: Datastar @post sends `$title`/`$release_year`/`$actors`/`$genres`
 * (the last two are xid-string arrays); the BFF maps them with `toRel` and calls
 * `Movie.sync`. We do the same here and assert the server did the right thing —
 * no browser/OAuth session needed.
 *
 * Run:  (env from .envrc)  node --test tests/
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { configure, client, Movie } from "../generated/ops.ts"

configure({
  endpoint:     process.env.SYNTHIGY_ENDPOINT ?? "http://localhost:7887",
  clientId:     process.env.SYNTHIGY_CLIENT_ID,
  clientSecret: process.env.SYNTHIGY_CLIENT_SECRET,
})

const PREFIX = "__flowtest__"
const toRel  = (xids) => xids.map((xid) => ({ xid }))   // mirrors serve.ts toRel()
const created = []

async function makeMovie(data) {
  const r = await Movie.sync(data)
  const xid = r?.xid ?? r
  created.push(xid)
  return xid
}
const byTitle = (t) =>
  client().search("Movie", { title: { _eq: t } }, { xid: null, title: null, release_year: null })
const detail = (xid) =>
  client().query(`movie (xid = ?xid:string)\n  xid\n  title\n  release_year`, { xid }, { op: "get", entity: "movie" })
async function castOf(xid) {
  const m = await client().query(`movie (xid = ?xid:string)\n  xid\n  ->actors\n    xid\n    name`,
    { xid }, { op: "get", entity: "movie" })
  return (m?.actors ?? []).map((a) => a.name).sort()
}

let actors = []   // [{xid,name}, …] real reference data
before(async () => {
  actors = await client().query(`movie_actor (_limit ?n:int=3, _order_by name asc)\n  xid\n  name`,
    { n: 3 }, { op: "search", entity: "movie_actor" })
  assert.ok(actors.length >= 3, "need ≥3 actors in the dataset to run the cast tests")
})
after(async () => {
  for (const xid of created) { try { await Movie.delete(xid) } catch {} }
})

// ── create ──────────────────────────────────────────────────────────────────
test("create persists title, year and the picked cast", async () => {
  const xid = await makeMovie({
    title: PREFIX + "create", release_year: 2099,
    actors: toRel([actors[0].xid, actors[1].xid]),
  })
  const d = await detail(xid)
  assert.equal(d.title, PREFIX + "create")
  assert.equal(d.release_year, 2099)
  assert.deepEqual(await castOf(xid), [actors[0].name, actors[1].name].sort())
})

// ── THE BUG: edit must target by xid, never by title ─────────────────────────
test("edit targets by xid — duplicate titles stay distinct, no row created", async () => {
  const T = PREFIX + "dup"
  const a = await makeMovie({ title: T, release_year: 2001, actors: toRel([actors[0].xid]) })
  const b = await makeMovie({ title: T, release_year: 2002, actors: toRel([actors[1].xid]) })
  assert.equal((await byTitle(T)).length, 2, "two movies legitimately share a title")

  // Edit A — exactly the BFF's POST /movies/:xid payload (xid + full relations).
  await Movie.sync({ xid: a, title: T, release_year: 2099, actors: toRel([actors[2].xid]), genres: [] })

  assert.equal((await byTitle(T)).length, 2, "edit did NOT create a duplicate (would be 3 if keyed by title)")
  assert.equal((await detail(a)).release_year, 2099, "edited movie A changed")
  assert.equal((await detail(b)).release_year, 2002, "sibling movie B untouched")
  assert.deepEqual(await castOf(a), [actors[2].name], "A cast replaced by xid")
  assert.deepEqual(await castOf(b), [actors[1].name], "B cast untouched")
})

// ── edit replaces relation sets (not append) ─────────────────────────────────
test("edit replaces the cast set rather than appending", async () => {
  const xid = await makeMovie({ title: PREFIX + "replace", release_year: 2099, actors: toRel([actors[0].xid, actors[1].xid]) })
  assert.equal((await castOf(xid)).length, 2)
  await Movie.sync({ xid, title: PREFIX + "replace", release_year: 2099, actors: toRel([actors[2].xid]), genres: [] })
  assert.deepEqual(await castOf(xid), [actors[2].name], "set replaced, not merged")
})

test("edit with an empty cast clears all links", async () => {
  const xid = await makeMovie({ title: PREFIX + "clear", release_year: 2099, actors: toRel([actors[0].xid]) })
  assert.equal((await castOf(xid)).length, 1)
  await Movie.sync({ xid, title: PREFIX + "clear", release_year: 2099, actors: [], genres: [] })
  assert.deepEqual(await castOf(xid), [], "empty array unlinked everything")
})

// ── picker token round-trip (what POST /actors-picker/tokens does) ───────────
test("token lookup by xid set returns the right names", async () => {
  const xids = [actors[0].xid, actors[2].xid]
  const found = await client().search("movie_actor", { xid: { _in: xids } }, { xid: null, name: null })
  assert.deepEqual(found.map((a) => a.name).sort(), [actors[0].name, actors[2].name].sort())
})
