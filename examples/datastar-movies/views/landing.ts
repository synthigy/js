import { layout } from "./layout.ts"
import { esc } from "../lib/bff.ts"
import { icon } from "../lib/icons.ts"

// Layout/spacing = Tailwind utilities inline (preflight off, Play CDN).
// Colours stay Tyrell: the `.hero/.card/.note` classes in style.css carry
// only background/border/text tokens + hover effects.
export function landingPage({ user }: { user: any }) {
  return layout({
    title: "Home",
    user,
    content: /* html */ `
      <section class="hero ty-elevated mt-6 mb-12 px-10 py-9 rounded-lg border">
        <div class="flex gap-2 mb-[18px]">
          <ty-tag flavor="primary" size="sm">
            ${icon("zap", { slot: "start", size: "sm" })}
            Live data
          </ty-tag>
          <ty-tag flavor="success" size="sm">
            ${icon("shield-check", { slot: "start", size: "sm" })}
            No browser SDK
          </ty-tag>
          <ty-tag flavor="neutral" size="sm">
            ${icon("server", { slot: "start", size: "sm" })}
            BFF holds tokens
          </ty-tag>
        </div>
        <h1 class="m-0 mb-3 text-[1.7rem] font-bold tracking-[-0.02em]">Live data, zero browser SDK.</h1>
        <p class="hero-text m-0 mb-4 max-w-[60ch]">
          This demo is a Node BFF using <code>@synthigy/sdk</code> against the
          <code>/data</code> endpoint. The browser sees nothing but HTML and SSE
          patches — no API keys, no JWT, no JSON wrangling.
        </p>
        ${user
          ? `<p class="m-0"><strong>You're logged in</strong> as <code>${esc(user.xid)}</code>.</p>`
          : `<a href="/login" class="no-underline">
               <ty-button flavor="primary">
                 ${icon("log-in", { slot: "start", size: "sm" })}
                 Log in to start
               </ty-button>
             </a>`}
      </section>

      <section class="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4 mb-12">
        ${cardLink("/movies", "list", "Live movies list",
          "Top-rated movies in real time. Add a rating in one tab, watch the list reshuffle in another.",
          "Movie.watchList()")}
        ${cardLink("/movies", "film", "Live movie detail",
          "Edit a title in the console, watch it patch in any open detail tab. Ratings append live.",
          "Movie.watchDetail()")}
        ${cardLink("/actors", "users", "Live actors",
          "Browse the cast, click through to filmography. Edits propagate live.",
          "MovieActor.watchList()")}
        ${cardLink("/dashboard", "chart-column", "Live dashboard",
          "Four counters driven by one SQL template watch — one SSE from BFF to server, regardless of open tabs.",
          "Dashboard.watchStats()")}
      </section>

      <section class="note ty-content p-[22px] rounded-md border">
        <h3 class="m-0 mb-3 text-[0.95rem]">
          ${icon("info", { size: "sm" })}
          What's going on under the hood
        </h3>
        <ul class="note-list m-0 pl-5">
          <li class="my-1.5">One <code>@synthigy/sdk</code> client per BFF process.</li>
          <li class="my-1.5">One SSE from BFF → Synthigy <code>/data/events</code>, regardless of how many browser tabs are open.</li>
          <li class="my-1.5">Each page opens one SSE from browser → BFF; BFF translates SDK watch events into Datastar element patches.</li>
          <li class="my-1.5">Login is OIDC authorization-code with PKCE. Tokens stay server-side.</li>
        </ul>
      </section>
    `,
  })
}

function cardLink(href: string, ico: string, title: string, body: string, tag: string) {
  return /* html */ `<a class="card ty-elevated block p-[22px] rounded-md border" href="${href}">
    <div class="card-icon mb-3">${icon(ico, { size: "lg" })}</div>
    <h2 class="block m-0 mb-2 text-[1.05rem]">${esc(title)}</h2>
    <p class="card-text m-0 mb-3 text-[0.92em]">${esc(body)}</p>
    <ty-tag size="sm" flavor="neutral">${esc(tag)}</ty-tag>
  </a>`
}
