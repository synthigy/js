import { layout } from "./layout.ts";
import { esc } from "../lib/bff.ts";
import { icon as renderIcon } from "../lib/icons.ts";
import type { MovieList, MovieDetail, MovieActorList, MovieGenreList } from "../generated/ops.ts";

// Projection sub-shapes (the nested types the generated row types expose).
type Genre = NonNullable<MovieList["genres"]>[number];
type DetailRating = NonNullable<MovieDetail["movie_ratings"]>[number];
type DetailActor = NonNullable<MovieDetail["actors"]>[number];
// The cast renderer handles a richer actor than the detail query selects today —
// extra fields are optional (always undefined under the current selection).
type CastActor = DetailActor & {
  avatar?: string | null; death_year?: number | null;
  place_of_birth?: string | null; gender?: string | null; popularity?: number | null;
};

// ──────────────────────────────────────────────────────────────────────────
// Movies list — whole row clickable, Tyrell ty-tag for every chip.
// ──────────────────────────────────────────────────────────────────────────

// Shared fragment builders — used by the page AND the /movies-search
// debounced endpoint so the patched HTML can't drift from the rendered HTML.
export function moviesQs(term: string, p: number) {
  const s = new URLSearchParams({
    ...(term ? { q: term } : {}),
    ...(p > 1 ? { page: String(p) } : {}),
  }).toString();
  return s ? "?" + s : "";
}
export function searchMeta(term: string, total: number) {
  return `${term ? `<a class="movies-search-clear" href="/movies">clear</a> · ` : ""}${total} match${total === 1 ? "" : "es"}`;
}
const PAGER_BTN = "pager-btn inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-lg border text-[0.88rem] no-underline";
export function moviesPagerInner(term: string, page: number, pages: number) {
  if (pages <= 1) return "";
  const href = (p: number) => `/movies${moviesQs(term, p)}`;
  return /* html */ `
    ${
      page > 1
        ? `<a class="${PAGER_BTN}" href="${href(page - 1)}">${renderIcon("arrow-left", { size: "sm" })} Prev</a>`
        : `<span class="${PAGER_BTN} disabled">${renderIcon("arrow-left", { size: "sm" })} Prev</span>`
    }
    <span class="pager-status">Page ${page} of ${pages}</span>
    ${
      page < pages
        ? `<a class="${PAGER_BTN}" href="${href(page + 1)}">Next ${renderIcon("arrow-right", { size: "sm" })}</a>`
        : `<span class="${PAGER_BTN} disabled">Next ${renderIcon("arrow-right", { size: "sm" })}</span>`
    }`;
}

export function moviesPage({
  user,
  initial,
  actors = [],
  genres = [],
  error,
  term = "",
  page = 1,
  total = 0,
  perPage = 20,
}: {
  user: any; initial: MovieList[]; actors?: MovieActorList[]; genres?: MovieGenreList[];
  error?: string | null; term?: string; page?: number; total?: number; perPage?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return layout({
    title: "Movies",
    user,
    // Stream tracks the CURRENT page/search window — every page is live.
    stream: `/stream/movies${moviesQs(term, page)}`,
    content: /* html */ `
      <section class="movies-head grid grid-cols-[1fr_auto] items-end gap-6 mb-[18px] max-[860px]:grid-cols-1 max-[860px]:gap-4">
        <div>
          <h1 class="m-0 mb-1.5 text-[1.45rem] font-bold tracking-[-0.02em]">Top-rated movies</h1>
          <p class="hint m-0">
            Live — this page tracks its own window via
            <code>Movie.watchList({ q, limit, offset })</code>. Rate any visible
            movie and its row updates in place.
          </p>
        </div>
        <div class="flex flex-col items-end gap-1.5 whitespace-nowrap max-[860px]:items-start">
          <ty-button
            flavor="primary"
            size="sm"
            data-on:click="$_modalOpen = true">
            ${renderIcon("plus", { slot: "start", size: "sm" })}
            Add movie
          </ty-button>
        </div>
      </section>

      <div class="flex items-center gap-2.5 mb-4">
        <ty-input id="movie-search" class="flex-1 max-w-[420px]" type="search" value="${esc(term)}"
                  placeholder="Search movies by title…" autocomplete="off"
                  debounce="400"
                  data-on:input="@get('/movies-search?q=' + encodeURIComponent(evt.detail.value || ''))">
          ${renderIcon("search", { slot: "start", size: "sm" })}
        </ty-input>
        <span id="movies-meta" class="movies-search-count ml-auto">${searchMeta(term, total)}</span>
      </div>

      ${
        error
          ? `<div class="movies-error" style="background:#3a1212;color:#ffb4b4;border:1px solid #ff4040;padding:14px 16px;border-radius:6px;margin:12px 0;line-height:1.5;">
        <strong>Initial fetch failed.</strong> ${esc(error)}
        <br><a href="/logout" style="color:#ffb4b4;text-decoration:underline;">Log out and sign back in</a> if this looks session-related.
      </div>`
          : ""
      }

      <ul id="movies" class="movies list-none p-0 m-0 rounded-lg border overflow-hidden">
        ${initial.map((m) => movieRow(m)).join("")}
      </ul>

      <nav id="movies-pager" class="flex items-center justify-center gap-[18px] mt-5 mb-2">${moviesPagerInner(term, page, pages)}</nav>

      <aside id="debug-ribbon" class="debug-ribbon ty-content">
        <header class="ribbon-header">
          <span class="ribbon-title">
            <span class="ribbon-dot"></span>
            event console
          </span>
          <span class="ribbon-meta">/data/events</span>
        </header>
        <pre id="debug-log" class="ribbon-log"></pre>
      </aside>

      ${movieModal({ actors, genres })}
    `,
  });
}

export function movieRow(m: MovieList, { fresh = false }: { fresh?: boolean } = {}) {
  // Count + average come from the DB via _count/_agg (aliased "ratings") — no
  // per-rating rows shipped to the BFF, no JS reduce. Detail view still pulls rows.
  const count = m._count?.ratings ?? 0;
  const actorCount = m._count?.actors ?? 0;
  const avgVal = (m._agg?.ratings as any)?.avg?.value;
  const avg = avgVal != null ? Number(avgVal).toFixed(2) : null;
  const year = m.release_year;
  const genres = (m.genres ?? []).slice(0, 3);
  const flashClass = fresh ? `flash-${count % 2 === 0 ? "a" : "b"}` : "";

  return /* html */ `<li id="movie-${esc(m.xid)}" class="movie relative">
    <a class="movie-link grid grid-cols-[minmax(0,1fr)_auto] gap-6 items-center px-[22px] py-3.5 relative no-underline max-[860px]:grid-cols-1 max-[860px]:gap-2" href="/movies/${esc(m.xid)}">
      <div class="min-w-0">
        <div class="truncate font-medium text-base leading-[1.3] mb-1.5">${esc(m.title ?? "(untitled)")}</div>
        <div class="movie-meta flex flex-wrap items-center gap-1.5 text-[0.82rem]">
          ${year ? `<span class="movie-year text-[0.78rem] font-medium tabular-nums mr-0.5">${esc(String(year))}</span>` : ""}
          ${genres.map((g) => genreTag(g)).join("")}
        </div>
      </div>
      <div class="movie-stats inline-flex items-center gap-2 px-1.5 py-1 rounded-md whitespace-nowrap ${flashClass}">
        ${
          actorCount > 0
            ? `<ty-tag size="sm" flavor="neutral" title="${actorCount} cast member${actorCount === 1 ? "" : "s"}">
               ${renderIcon("users", { slot: "start", size: "xs" })}
               <span class="tabular-nums font-semibold">${actorCount}</span>
             </ty-tag>`
            : ""
        }
        ${
          avg
            ? `<ty-tag size="sm" flavor="rating">
               ${renderIcon("star", { slot: "start", size: "xs" })}
               <span class="tabular-nums font-semibold">${esc(avg)}</span>
             </ty-tag>
             <span class="movie-stats-count text-[0.78rem] font-medium tabular-nums min-w-6 text-right">${count}</span>`
            : `<ty-tag size="sm" flavor="neutral">no ratings</ty-tag>`
        }
      </div>
    </a>
  </li>`;
}

export function movieDetailCard(movie: MovieDetail) {
  const genres = movie.genres ?? [];
  const actors = (movie.actors ?? []).slice().sort(byActorName);
  const ratings = (movie.movie_ratings ?? []).slice().sort(byRatingTimeDesc);
  const avg = ratings.length
    ? (
        ratings.reduce((a, r) => a + (r.value ?? 0), 0) / ratings.length
      ).toFixed(2)
    : null;

  return /* html */ `<section id="movie-${esc(movie.xid)}" class="movie-detail max-w-[920px]">
    <div class="flex items-center justify-between mb-4">
      <a class="back-link inline-flex items-center gap-1 text-[0.84em] tracking-[0.02em]" href="/movies">
        ${renderIcon("arrow-left", { size: "sm" })}
        all movies
      </a>
      <ty-button flavor="neutral" size="sm"
                 data-on:click="$_modalOpen = true">
        ${renderIcon("pencil", { slot: "start", size: "sm" })}
        Edit
      </ty-button>
    </div>

    <article class="detail-card rounded-xl mb-8 border overflow-hidden">
      <div class="pt-[26px] px-7 pb-[22px]">
        <h1 id="movie-title" class="m-0 mb-3.5 text-[2rem] font-bold tracking-[-0.025em] leading-[1.1]">${esc(movie.title ?? "(untitled)")}</h1>
        <div class="flex flex-wrap items-center gap-2 mb-[22px]">
          <span class="detail-score-inline inline-flex items-baseline gap-1 px-3 py-1 rounded-lg border font-bold tabular-nums">
            ${renderIcon("star", { size: "sm" })}
            <span class="text-[1.1rem] tracking-[-0.01em]">${avg ?? "—"}</span>
            <span class="detail-score-divider text-[0.8rem] mx-px font-normal">/</span>
            <span class="detail-score-max text-[0.9rem] font-semibold">5</span>
          </span>
          <span class="detail-meta-sep mx-0.5 select-none">·</span>
          <span class="detail-rating-count inline-flex items-center gap-1 tabular-nums">
            ${renderIcon("users", { size: "xs" })}
            ${ratings.length} rating${ratings.length === 1 ? "" : "s"}
          </span>
          <span class="detail-meta-sep mx-0.5 select-none">·</span>
          ${
            movie.release_year
              ? `<span class="detail-year text-[0.92rem] font-medium tabular-nums" id="movie-year">${esc(movie.release_year)}</span>`
              : `<span class="detail-year detail-year-empty text-[0.92rem] font-medium">year unknown</span>`
          }
          ${
            genres.length
              ? `<span class="detail-meta-sep mx-0.5 select-none">·</span>
               <span class="inline-flex flex-wrap gap-1 items-center">${genres.map((g) => genreTag(g)).join("")}</span>`
              : ""
          }
        </div>
        <form class="rate-form flex items-center gap-2.5 flex-wrap"
              data-signals="{rateValue: 4.0}"
              data-on:submit__prevent="@post('/movies/${esc(movie.xid)}/rate')">
          <span class="rate-form-label mr-1.5">Add your rating</span>
          <ty-input class="flex-[0_0_110px]" type="number" label=""
                    value="4.0" min="0.5" max="5.0" step="0.5"
                    data-on:input="$rateValue = evt.detail.value">
            ${renderIcon("star", { slot: "start", size: "sm" })}
            <ty-button slot="end" flavor="primary" type="submit" size="sm">
              ${renderIcon("send", { slot: "start", size: "sm" })}
              Submit
            </ty-button>
          </ty-input>
        </form>
      </div>
      <div class="detail-card-footer flex items-center justify-between gap-3 px-7 py-[11px] flex-wrap">
        <ty-copy value="${esc(movie.xid)}" size="sm">
          <span class="detail-id-label mr-1">xid</span>
          <code class="detail-id-value px-1.5 py-0.5 rounded">${esc(movie.xid)}</code>
        </ty-copy>
        <span class="detail-card-hint">edits propagate live via <code>watchDetail()</code></span>
      </div>
    </article>

    <section class="mb-8">
      <h2 class="section-title m-0 mb-3.5 flex items-center gap-2 text-[0.78rem]">
        ${renderIcon("users", { size: "sm" })}
        Cast <span class="section-count px-[9px] py-0.5 rounded-full ml-1">${actors.length}</span>
      </h2>
      ${
        actors.length
          ? /* html */ `<div class="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-3.5">
            ${actors.slice(0, 24).map(actorCard).join("")}
          </div>`
          : `<p class="empty-panel m-0 px-[22px] py-[18px] rounded-lg">No cast credited in the dataset for this title.</p>`
      }
    </section>

    <section class="mb-8">
      <h2 class="section-title m-0 mb-3.5 flex items-center gap-2 text-[0.78rem]">
        ${renderIcon("star", { size: "sm" })}
        Ratings <span class="section-count px-[9px] py-0.5 rounded-full ml-1">${ratings.length}</span>
      </h2>
      ${
        ratings.length
          ? /* html */ `<ul id="ratings" class="ratings list-none p-0 m-0 rounded-lg border overflow-hidden">
            ${ratings.map(ratingRow).join("")}
          </ul>`
          : `<p class="empty-panel m-0 px-[22px] py-[18px] rounded-lg">No ratings yet — be the first.</p>`
      }
    </section>
  </section>`;
}

export function movieDetailPage({ user, movie, actors = [], genres = [] }: {
  user: any; movie: MovieDetail; actors?: MovieActorList[]; genres?: MovieGenreList[];
}) {
  return layout({
    title: movie.title ?? "Movie",
    user,
    stream: `/stream/movies/${encodeURIComponent(movie.xid)}`,
    content: movieDetailCard(movie) + movieModal({ movie, actors, genres }),
  });
}

// Single actor card — linked to actor detail if xid is present.
function actorCard(a: CastActor) {
  const initials = initialsOf(a.name);
  const stripe = initialColor(initials);
  const bio = buildActorBio(a);
  const inner = /* html */ `<div class="pt-[18px] px-3 pb-3.5 text-center" title="${esc(bio.tooltip)}">
      <div class="cast-avatar" style="background:${stripe.bg};color:${stripe.fg};margin:0 auto 12px">
        ${
          a.avatar
            ? `<img src="${esc(a.avatar)}" alt="${esc(a.name ?? "")}">`
            : `<span class="cast-initials">${esc(initials)}</span>`
        }
      </div>
      <div class="truncate font-semibold text-[0.92rem] mb-[3px]">${esc(a.name ?? "Unknown")}</div>
      ${bio.subtitle ? `<div class="cast-meta truncate">${esc(bio.subtitle)}</div>` : ""}
    </div>`;
  return a.xid
    ? `<a class="cast-card block no-underline rounded-[10px] border" href="/actors/${esc(a.xid)}">${inner}</a>`
    : `<div class="cast-card rounded-[10px] border">${inner}</div>`;
}

function buildActorBio(a: CastActor) {
  const subtitleParts = [];
  const tipParts = [a.name ?? "Unknown"];
  if (a.birth_year) {
    const life = `${a.birth_year}${a.death_year ? `–${a.death_year}` : ""}`;
    subtitleParts.push(life);
    tipParts.push(`Lived ${life}`);
  }
  if (a.nationality) {
    subtitleParts.push(a.nationality);
    tipParts.push(`Nationality: ${a.nationality}`);
  }
  if (a.place_of_birth) tipParts.push(`Born in ${a.place_of_birth}`);
  if (a.gender) tipParts.push(`Gender: ${a.gender}`);
  if (a.popularity != null) tipParts.push(`Popularity: ${a.popularity}`);
  return {
    subtitle: subtitleParts.join(" · "),
    tooltip: tipParts.join(" · "),
  };
}

// One rating line with rater avatar + name + timestamp.
export function ratingRow(r: DetailRating) {
  const rater = r.created_by?.name ?? "anonymous";
  const value =
    typeof r.value === "number" ? r.value.toFixed(1) : (r.value ?? "?");
  const initials = initialsOf(rater);
  const stripe = initialColor(initials);
  return /* html */ `<li id="rating-${esc(r.xid)}" class="rating grid grid-cols-[76px_1fr_auto] gap-4 items-center px-[18px] py-[11px] max-[860px]:grid-cols-[auto_1fr]">
    <ty-tag size="sm" flavor="rating">
      ${renderIcon("star", { slot: "start", size: "xs" })}
      ${esc(value)}
    </ty-tag>
    <span class="rating-rater inline-flex items-center gap-2 text-[0.86rem]">
      <span class="rating-avatar" style="background:${stripe.bg};color:${stripe.fg}">${esc(initials)}</span>
      <span class="rating-rater-name font-medium">${esc(rater)}</span>
    </span>
    <time class="rating-ts tabular-nums whitespace-nowrap text-[0.78rem] max-[860px]:col-span-full max-[860px]:text-right" datetime="${esc(r.created_on ?? "")}">${esc(formatTs(r.created_on))}</time>
  </li>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function initialsOf(name: string | null | undefined) {
  if (!name) return "?";
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0][0] ?? "?";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

// Avatar colours come straight from Tyrell's flavour palette — a vivid flavour
// fill + a near-white initial — so they re-theme with --ty-brand-hue like the
// rest of the page instead of being hardcoded hex.
const AVATAR_FLAVORS = ["primary", "secondary", "success", "warning", "danger"];
function initialColor(initials: string) {
  let h = 0;
  const s = String(initials || "?");
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const f = AVATAR_FLAVORS[Math.abs(h) % AVATAR_FLAVORS.length];
  return {
    bg: `var(--ty-color-${f})`,
    fg: "oklch(0.99 0.012 var(--ty-brand-hue))",
  };
}

// Map genre name to a Tyrell flavor. ty-tag supports the six built-in
// flavors out of the box, no custom CSS needed.
// Genre tags stay subtle (neutral) — the icon carries the identity. The only
// highlight is the selected genre in the picker (primary), handled in the
// picker's click logic.
function genreFlavor(_name?: string) {
  return "neutral";
}

function byActorName(a: CastActor, b: CastActor) {
  return String(a.name ?? "").localeCompare(String(b.name ?? ""));
}
function byRatingTimeDesc(a: DetailRating, b: DetailRating) {
  return String(b.created_on ?? "").localeCompare(String(a.created_on ?? ""));
}
function formatTs(iso: string | null | undefined) {
  if (!iso) return "";
  const s = String(iso);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s;
}

// ──────────────────────────────────────────────────────────────────────────
// New-movie modal
// ──────────────────────────────────────────────────────────────────────────

export const ACTOR_PICKER_PAGE = 50;

// One selectable cast chip — pure client-side Datastar: clicking toggles the
// actor's xid in the `$actors` signal (instant, no network). `data-attr-selected`
// reflects membership reactively; CSS floats selected chips to the top of the
// picker (`.actor-tag[selected]{order:-1}`) so picked cast stays visible with
// their avatars — no separate token box, no per-click round-trip.
// (xids are nanoid-safe inside the single-quoted expression.)
export function actorChip(a: MovieActorList) {
  const initials = initialsOf(a.name);
  const stripe = initialColor(initials);
  const name = a.name ?? "?";
  const x = esc(a.xid);
  return /* html */ `<ty-tag class="actor-tag" pill size="md" value="${x}"
    data-attr:selected="$actors.includes('${x}')"
    data-on:click="$actors = $actors.includes('${x}') ? $actors.filter(v => v !== '${x}') : $actors.concat(['${x}'])">
    <span slot="start" class="tag-av" style="background:${stripe.bg};color:${stripe.fg}">${esc(initials)}</span>
    ${esc(name)}
  </ty-tag>`;
}

// Per-genre lucide icon (all verified present in Tyrell's icon set).
const GENRE_ICONS = {
  Action: "zap",
  Adventure: "compass",
  Animation: "sparkles",
  Children: "baby",
  Comedy: "laugh",
  Crime: "fingerprint",
  Documentary: "camera",
  Drama: "drama",
  Fantasy: "wand-sparkles",
  "Film-Noir": "moon",
  Horror: "ghost",
  IMAX: "maximize",
  Musical: "music",
  Mystery: "puzzle",
  Romance: "heart",
  "Sci-Fi": "rocket",
  Thriller: "skull",
  War: "swords",
  Western: "tent",
};
function genreIcon(name: string | null | undefined) {
  return (GENRE_ICONS as Record<string, string>)[name ?? ""] || "film";
}

// Display-only genre tag (movie list + detail) — coloured by its flavour, with
// its category icon in the start slot.
export function genreTag(g: Genre, size = "xs") {
  const name = g.name ?? "";
  return /* html */ `<ty-tag size="${esc(size)}" flavor="${genreFlavor(name)}">${renderIcon(genreIcon(name), { slot: "start", size: "xs" })}${esc(name)}</ty-tag>`;
}

// A selectable genre — Datastar toggles its xid in `$genres`; flavor + selected
// reflect membership reactively (primary when picked, neutral otherwise). Small
// fixed set, no token box needed — the chip itself is the selected state.
export function genreChip(g: Genre) {
  const name = g.name ?? "?";
  const x = esc(g.xid);
  return /* html */ `<ty-tag class="genre-tag" pill size="sm" value="${x}"
    data-attr:flavor="$genres.includes('${x}') ? 'primary' : 'neutral'"
    data-attr:selected="$genres.includes('${x}')"
    data-on:click="$genres = $genres.includes('${x}') ? $genres.filter(v => v !== '${x}') : $genres.concat(['${x}'])">
    ${renderIcon(genreIcon(name), { slot: "start", size: "xs" })}
    ${esc(name)}
  </ty-tag>`;
}

export function movieModal({ movie, actors = [], genres = [] }: {
  movie?: MovieDetail | null; actors?: MovieActorList[]; genres?: MovieGenreList[];
} = {}) {
  const editing = !!movie?.xid;
  const sorted = actors
    .slice()
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  const action = editing ? `/movies/${esc(movie!.xid)}` : "/movies";
  // Selection lives in Datastar signals (xid arrays). On submit, @post serializes
  // every signal as a JSON body; the server reads title/release_year/actors/genres.
  // Initial picked tokens are server-rendered (Datastar has no client-side loop).
  const signals = {
    title: movie?.title ?? "",
    release_year: movie?.release_year ?? null,
    actors: (movie?.actors ?? []).map((a) => a.xid),
    genres: (movie?.genres ?? []).map((g) => g.xid),
    // Infinite-scroll paging. nearend fires repeatedly while parked at the
    // bottom; the handler flips _pickerMore→false synchronously before @get so
    // duplicate fires are gated, and the server flips it back when the page lands.
    _actorSearch: "",
    _pickerOffset: sorted.length,
    _pickerMore: sorted.length === ACTOR_PICKER_PAGE,
  };
  // Edit mode: render the current cast FIRST (deduped) so pre-selected actors
  // are present + `selected` + floated to the top, even if they're not on the
  // picker's first page. No token box, no round-trip.
  const initActors = movie?.actors ?? [];
  const initSet = new Set(initActors.map((a) => a.xid));
  const pickerChips = [
    ...initActors.map(actorChip),
    ...sorted.filter((a) => !initSet.has(a.xid)).map(actorChip),
  ].join("");
  return /* html */ `
<ty-modal id="new-movie-dialog" data-signals="{_modalOpen: false}"
          data-attr:open="$_modalOpen"
          data-on:close="$_modalOpen = false" data-on:cancel="$_modalOpen = false">
  <form class="movie-form ty-floating flex flex-col w-[min(640px,calc(100vw-32px))] max-h-[calc(100dvh-64px)] overflow-hidden rounded-[14px] border"
        data-signals="${esc(JSON.stringify(signals))}"
        data-indicator="saving"
        data-on:submit__prevent="@post('${action}')">
    <div class="dialog-header flex items-center justify-between px-6 pt-5 pb-4 border-b shrink-0">
      <h2 class="m-0 text-[1.1rem]">
        ${renderIcon("film", { size: "sm" })}
        ${editing ? "Edit movie" : "Add new movie"}
      </h2>
    </div>

    <div class="dialog-body px-6 py-5 overflow-y-auto flex-1 flex flex-col gap-5">
      <div class="flex gap-3.5">
        <div class="flex flex-col gap-[7px] flex-[2]">
          <label class="form-label text-[0.88rem] font-medium" for="nmd-title">Title <span class="form-required">*</span></label>
          <ty-input id="nmd-title" required value="${esc(movie?.title ?? "")}"
                    placeholder="e.g. The Shawshank Redemption" autocomplete="off"
                    data-bind:title__event.input.change>
          </ty-input>
        </div>
        <div class="flex flex-col gap-[7px] flex-1">
          <label class="form-label text-[0.88rem] font-medium" for="nmd-year">Year</label>
          <ty-input id="nmd-year" type="number" value="${movie?.release_year ?? ""}"
                    placeholder="1994" min="1888" max="2030"
                    data-bind:release_year__event.input.change>
          </ty-input>
        </div>
      </div>

      <div class="flex flex-col gap-[7px]">
        <label class="form-label text-[0.88rem] font-medium">
          Genres <span class="cast-count" data-text="$genres.length ? '(' + $genres.length + ')' : ''"></span>
          <span class="form-field-hint font-normal">— click to toggle</span>
        </label>
        <div id="genre-list" class="flex flex-wrap gap-1.5">
          ${genres.map(genreChip).join("")}
        </div>
      </div>

      <div class="flex flex-col gap-[7px]">
        <label class="form-label text-[0.88rem] font-medium">
          Cast <span class="cast-count" data-text="$actors.length ? '(' + $actors.length + ')' : ''"></span>
          <span class="form-field-hint font-normal">— search & click to add</span>
        </label>
        <ty-input id="actor-search" class="block my-2" placeholder="Search actors by name…" autocomplete="off" debounce="300"
                  data-on:input="$_actorSearch = (evt.detail.value || ''); @get('/actors-picker?offset=0&q=' + $_actorSearch)">
          ${renderIcon("search", { slot: "start", size: "sm" })}
        </ty-input>
        <ty-scroll-container class="picker-scroll block rounded-lg border" max-height="240px" shadow custom-scrollbar
                             data-on:nearend="$_pickerMore && (($_pickerMore = false), @get('/actors-picker?offset=' + $_pickerOffset + '&q=' + $_actorSearch))">
          <div id="picker-list" class="flex flex-wrap gap-2 p-1.5">
            ${pickerChips}
          </div>
        </ty-scroll-container>
      </div>
    </div>

    <div class="dialog-footer flex justify-end gap-2.5 px-6 py-4 border-t shrink-0">
      <ty-button type="button" flavor="neutral" size="sm"
                 data-on:click="$_modalOpen = false">
        Cancel
      </ty-button>
      <ty-button type="submit" flavor="primary" size="sm" data-attr:loading="$saving">
        ${renderIcon(editing ? "send" : "plus", { slot: "start", size: "sm" })}
        ${editing ? "Save changes" : "Create movie"}
      </ty-button>
    </div>
  </form>
</ty-modal>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Dashboard (unchanged)
// ──────────────────────────────────────────────────────────────────────────

export function dashboardPage({ user }: { user: any }) {
  return layout({
    title: "Dashboard",
    user,
    stream: "/stream/dashboard",
    content: /* html */ `
      <section class="dashboard">
        <h1 class="m-0 mb-1.5 text-[1.5rem] font-bold tracking-[-0.02em]">
          ${renderIcon("chart-column", { size: "md" })}
          Live counters
        </h1>
        <p class="hint mb-6">
          All four tiles run as one <code>Dashboard.watchStats()</code> — a single SQL
          template, one watch, one BFF→Synthigy SSE.
        </p>

        <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
          ${counterTile({ id: "counter-movies-val", label: "Movies", icon: "film" })}
          ${counterTile({ id: "counter-ratings-val", label: "Ratings", icon: "star" })}
          ${counterTile({ id: "counter-avg-val", label: "Avg rating", icon: "trending-up" })}
          ${counterTile({ id: "counter-actors-val", label: "Actors", icon: "users" })}
        </div>
      </section>
    `,
  });
}

function counterTile({ id, label, icon }: { id: string; label: string; icon: string }) {
  return /* html */ `<div class="counter p-[22px] rounded-lg border text-center">
    <div class="counter-icon mb-2.5">
      ${renderIcon(icon, { size: "md" })}
    </div>
    <span class="label block mb-1.5">${esc(label)}</span>
    <span class="value block" id="${esc(id)}">…</span>
  </div>`;
}
