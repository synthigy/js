import { layout } from "./layout.ts"
import { esc } from "../lib/bff.ts"
import { icon } from "../lib/icons.ts"
import type { MovieActorList, MovieActorDetail } from "../generated/ops.ts"
type ActorMovie = NonNullable<MovieActorDetail["movies"]>[number]

export function actorsPage({ user, initial, pageSize = 40 }: { user: any; initial: MovieActorList[]; pageSize?: number }) {
  const hasMore = initial.length === pageSize
  return layout({
    title: "Actors",
    user,
    // No watch — actors are reference data. Infinite scroll = pure pagination,
    // same technique as the modal picker: the <ty-scroll-container> fires
    // `nearend`; the handler flips actorsMore→false synchronously (gating
    // duplicate fires) and @gets the next page, which the server appends and
    // re-arms via patch-signals. (Viewport `intersect` is unreliable inside a
    // bounded scroll container — that's why we use the container's own event.)
    content: /* html */ `
      <section class="mb-[18px]">
        <h1 class="m-0 text-[1.45rem] font-bold tracking-[-0.02em]">${icon("users", { size: "md" })} Actors</h1>
        <p class="hint m-0">
          Infinite scroll via <code>MovieActor.list({ limit, offset })</code> in a
          <code>&lt;ty-scroll-container&gt;</code> — pages fetched on demand and
          concatenated. No live watch (reference data).
        </p>
      </section>
      <ty-scroll-container class="block px-3" max-height="calc(100vh - 310px)" shadow custom-scrollbar
                           data-signals="${esc(JSON.stringify({ actorsOffset: initial.length, actorsMore: hasMore }))}"
                           data-on:nearend="$actorsMore && (($actorsMore = false), @get('/actors-more?offset=' + $actorsOffset))">
        <div id="actors" class="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3.5 py-0.5 pb-6">
          ${initial.map(actorRow).join("")}
        </div>
      </ty-scroll-container>
    `,
  })
}

export function actorRow(a: MovieActorList) {
  const initials = initialsOf(a.name)
  const stripe   = initialColor(initials)
  const meta = [a.birth_year, a.nationality].filter(Boolean).join(" · ")
  return /* html */ `<a id="actor-${esc(a.xid)}" class="actor-card flex flex-col items-center gap-2.5 pt-5 px-3.5 pb-4 rounded-xl border no-underline" href="/actors/${esc(a.xid)}">
    <div class="actor-card-avatar" style="background:${stripe.bg};color:${stripe.fg}">
      ${esc(initials)}
    </div>
    <div class="text-[0.9rem] font-semibold text-center leading-[1.3] line-clamp-2">${esc(a.name ?? "(unknown)")}</div>
    ${meta ? `<div class="actor-card-meta text-[0.75rem] text-center tabular-nums">${esc(meta)}</div>` : ""}
  </a>`
}

export function actorDetailCard(actor: MovieActorDetail) {
  const movies  = (actor.movies ?? []).slice().sort((a, b) => (b.release_year ?? 0) - (a.release_year ?? 0))
  const initials = initialsOf(actor.name)
  const stripe   = initialColor(initials)

  return /* html */ `<section id="actor-${esc(actor.xid)}" class="movie-detail max-w-[920px]">
    <a class="back-link inline-flex items-center gap-1 mb-4 text-[0.84em] tracking-[0.02em]" href="/actors">
      ${icon("arrow-left", { size: "sm" })}
      all actors
    </a>

    <article class="detail-card rounded-xl mb-8 border overflow-hidden">
      <div class="flex gap-5 items-start pt-[26px] px-7 pb-[22px]">
        <div class="cast-avatar shrink-0" style="width:72px;height:72px;font-size:22px;margin:0;background:${stripe.bg};color:${stripe.fg}">
          ${esc(initials)}
        </div>
        <div class="min-w-0">
          <h1 id="actor-name" class="m-0 mb-3.5 text-[2rem] font-bold tracking-[-0.025em] leading-[1.1]">${esc(actor.name ?? "(unknown)")}</h1>
          <div class="flex flex-wrap items-center gap-2 mb-[22px]">
            ${actor.birth_year ? `<span class="detail-year text-[0.92rem] font-medium tabular-nums">${esc(String(actor.birth_year))}</span>` : ""}
            ${actor.nationality ? `<span class="detail-meta-sep mx-0.5 select-none">·</span>
              <ty-tag size="xs" flavor="neutral">${esc(actor.nationality)}</ty-tag>` : ""}
          </div>
        </div>
      </div>
      <div class="detail-card-footer flex items-center justify-between gap-3 px-7 py-[11px] flex-wrap">
        <ty-copy value="${esc(actor.xid)}" size="sm">
          <span class="detail-id-label mr-1">xid</span>
          <code class="detail-id-value px-1.5 py-0.5 rounded">${esc(actor.xid)}</code>
        </ty-copy>
        <span class="detail-card-hint">edits propagate live via <code>MovieActor.watchDetail()</code></span>
      </div>
    </article>

    <section class="mb-8">
      <h2 class="section-title m-0 mb-3.5 flex items-center gap-2 text-[0.78rem]">
        ${icon("film", { size: "sm" })}
        Filmography <span class="section-count px-[9px] py-0.5 rounded-full ml-1">${movies.length}</span>
      </h2>
      ${movies.length
        ? /* html */ `<ul id="actor-movies" class="movies list-none p-0 m-0 rounded-lg border overflow-hidden">
            ${movies.map(filmographyRow).join("")}
          </ul>`
        : `<p class="empty-panel m-0 px-[22px] py-[18px] rounded-lg">No movies in the dataset for this actor.</p>`}
    </section>
  </section>`
}

function filmographyRow(m: ActorMovie) {
  const ratings = m.movie_ratings ?? []
  const avg = ratings.length
    ? (ratings.reduce((a, r) => a + (r.value ?? 0), 0) / ratings.length).toFixed(1)
    : null
  return /* html */ `<li id="actor-movie-${esc(m.xid)}" class="movie relative">
    <a class="movie-link grid grid-cols-[minmax(0,1fr)_auto] gap-6 items-center px-[22px] py-3.5 relative no-underline max-[860px]:grid-cols-1 max-[860px]:gap-2" href="/movies/${esc(m.xid)}">
      <div class="min-w-0">
        <div class="truncate font-medium text-base leading-[1.3] mb-1.5">${esc(m.title ?? "(untitled)")}</div>
        <div class="movie-meta flex flex-wrap items-center gap-1.5 text-[0.82rem]">
          ${m.release_year ? `<span class="movie-year text-[0.78rem] font-medium tabular-nums mr-0.5">${esc(String(m.release_year))}</span>` : ""}
        </div>
      </div>
      <div class="movie-stats inline-flex items-center gap-2 px-1.5 py-1 rounded-md whitespace-nowrap">
        ${avg
          ? `<ty-tag size="sm" flavor="rating">
               ${icon("star", { slot: "start", size: "xs" })}
               <span class="tabular-nums font-semibold">${esc(avg)}</span>
             </ty-tag>
             <span class="movie-stats-count text-[0.78rem] font-medium tabular-nums min-w-6 text-right">${ratings.length}</span>`
          : `<ty-tag size="sm" flavor="neutral">no ratings</ty-tag>`}
      </div>
    </a>
  </li>`
}

export function actorDetailPage({ user, actor }: { user: any; actor: MovieActorDetail }) {
  return layout({
    title: actor.name ?? "Actor",
    user,
    stream: `/stream/actors/${encodeURIComponent(actor.xid)}`,
    content: actorDetailCard(actor),
  })
}

// ── helpers (duplicated from movies.mjs to keep views independent) ────────────

function initialsOf(name: string | null | undefined) {
  if (!name) return "?"
  const words = String(name).trim().split(/\s+/).filter(Boolean)
  if (!words.length) return "?"
  const first = words[0][0] ?? "?"
  const last  = words.length > 1 ? words[words.length - 1][0] ?? "" : ""
  return (first + last).toUpperCase()
}

// Avatar colours from Tyrell's flavour palette (vivid fill + near-white initial)
// so they re-theme with --ty-brand-hue. Mirrors views/movies.mjs.
const AVATAR_FLAVORS = ["primary", "secondary", "success", "warning", "danger"]
function initialColor(initials: string) {
  let h = 0
  const s = String(initials || "?")
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  const f = AVATAR_FLAVORS[Math.abs(h) % AVATAR_FLAVORS.length]
  return { bg: `var(--ty-color-${f})`, fg: "oklch(0.99 0.012 var(--ty-brand-hue))" }
}
