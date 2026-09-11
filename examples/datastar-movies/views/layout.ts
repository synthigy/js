import { esc } from "../lib/bff.ts"
import { icon } from "../lib/icons.ts"

/**
 * Page shell. Tyrell components + Datastar, both from CDN — zero
 * browser-side build step.
 *
 *   Tyrell components: <ty-button>, <ty-input>, <ty-tag>, <ty-icon>,
 *                      <ty-dropdown>, <ty-modal>, etc.
 *                      Form-associated, shadow-DOM-isolated, native events.
 *   Datastar         : data-on-load / data-on:click / @post / @get — opens
 *                      SSE, applies patch-elements + patch-signals as they
 *                      arrive from the BFF.
 *
 * The `data-init="@get('…/stream')"` directive on a child opens the
 * per-page SSE stream and applies patches into the rendered page.
 *
 * Typography: Fraunces (variable serif, opsz + SOFT axes) for display,
 * DM Sans for UI, JetBrains Mono for the event console.
 */
// Tracks BFF process start time. Shown in the topbar so the user can
// confirm the rendering process is alive and not a cached page.
const BFF_START = new Date().toISOString().replace("T", " ").slice(0, 19)

export type LayoutProps = { title: string; user: any; content: string; stream?: string }
export function layout({ title, user, content, stream }: LayoutProps) {
  const renderedAt = new Date().toISOString().slice(11, 23)
  return /* html */ `<!DOCTYPE html>
<html lang="en" class="dark" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · datastar-movies</title>

  <!-- Tyrell components — served from the installed dependency, not a CDN.
       tyrell-brand.css is the OKLCH brand layer (loaded after tyrell.css);
       the whole palette is seeded from --ty-brand-hue (set in style.css). -->
  <link rel="stylesheet" href="/vendor/tyrell/tyrell.css">
  <link rel="stylesheet" href="/vendor/tyrell/tyrell-brand.css">
  <script type="module" src="/vendor/tyrell/tyrell.js"></script>

  <!-- No-FOUC reveal: style.css keeps <body> invisible until .ty-ready is set.
       tyrell.js (a deferred module) registers the components after first paint,
       so we wait for them to be defined, then reveal the fully-upgraded page in
       one fade — no visible snap from un-upgraded to upgraded tags. -->
  <script>
    (function () {
      var reveal = function () { document.documentElement.classList.add("ty-ready"); };
      if (window.customElements) {
        Promise.all(["ty-button", "ty-tag", "ty-input"].map(function (n) {
          return customElements.whenDefined(n);
        })).then(reveal);
      }
      setTimeout(reveal, 2000); // safety net if a component never registers
    })();
  </script>

  <!-- Fonts: clean sans for body + mono for the event console -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap">

  <!-- Icons are inlined as <svg> children of <ty-icon> by the BFF in
       lib/icons.mjs — no client-side registration script, no JS
       bootstrap, no flash of missing icon. Any SVG source can be
       swapped in (lucide, heroicons, custom) by changing lib/icons.mjs. -->

  <!-- Datastar: SSE-driven reactivity -->
  <script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.1/bundles/datastar.js"></script>

  <!-- Tailwind (Play CDN) for spacing/layout utilities. Preflight OFF so its
       base reset can't fight Tyrell's component styles or style.css. -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { corePlugins: { preflight: false } }</script>

  <link rel="stylesheet" href="/public/style.css?v=${Date.now()}">
</head>
<body class="ty-canvas">
  <header class="topbar ty-content flex items-center px-6 py-3 gap-8 sticky top-0 z-[100] border-b">
    <a class="brand flex items-center gap-2 font-semibold text-[1.02rem] tracking-[-0.01em]" href="/">
      ${icon("film", { size: "md" })}
      <span>datastar-movies</span>
    </a>
    <nav class="flex gap-0.5 flex-1 ml-2">
      <a class="nav-link flex items-center gap-1.5 px-[11px] py-1.5 rounded-[5px] text-[0.9rem] font-medium" href="/movies">
        ${icon("list", { size: "sm" })}
        Movies
      </a>
      <a class="nav-link flex items-center gap-1.5 px-[11px] py-1.5 rounded-[5px] text-[0.9rem] font-medium" href="/actors">
        ${icon("users", { size: "sm" })}
        Actors
      </a>
      <a class="nav-link flex items-center gap-1.5 px-[11px] py-1.5 rounded-[5px] text-[0.9rem] font-medium" href="/dashboard">
        ${icon("chart-column", { size: "sm" })}
        Dashboard
      </a>
    </nav>
    <script>
      // Highlight the current section (also matches detail sub-paths like
      // /movies/:xid → Movies). The nav <a>s above are already parsed here.
      (function () {
        var p = location.pathname;
        document.querySelectorAll(".topbar nav a").forEach(function (a) {
          var h = a.getAttribute("href");
          if (h && h !== "/" && (p === h || p.indexOf(h + "/") === 0)) a.setAttribute("aria-current", "page");
        });
      })();
    </script>
    <div class="build-badge" title="BFF started ${esc(BFF_START)} · page rendered ${esc(renderedAt)}">
      <span class="build-badge-dot"></span>
      <span class="build-badge-text">build ${esc(BFF_START)} · rendered ${esc(renderedAt)}</span>
    </div>
    <div class="user flex items-center gap-2.5">
      ${user
        ? `<ty-tag size="sm" flavor="neutral">
             ${icon("user", { slot: "start", size: "sm" })}
             ${esc(user.name ?? user.xid?.slice(0, 8) ?? "?")}
           </ty-tag>
           <form method="POST" action="/logout" style="display:inline">
             <ty-button size="sm" flavor="neutral" type="submit">
               ${icon("log-out", { slot: "start", size: "sm" })}
               log out
             </ty-button>
           </form>`
        : `<a href="/login" style="text-decoration:none">
             <ty-button size="sm" flavor="primary">
               ${icon("log-in", { slot: "start", size: "sm" })}
               log in
             </ty-button>
           </a>`}
    </div>
  </header>

  ${stream ? `<div id="movie-stream" data-init="@get('${esc(stream)}')"></div>` : ""}

  <main class="max-w-[1100px] mx-auto px-6 pt-9 pb-24">
    ${content}
  </main>

  <footer class="border-t px-6 py-4 text-center text-[0.8em]">
    <span>spike for <a href="https://synthigy.dev/sdk">synthigy.dev/sdk</a> · one SSE per page · BFF holds tokens · components by tyrell, reactivity by datastar</span>
  </footer>
</body>
</html>`
}
