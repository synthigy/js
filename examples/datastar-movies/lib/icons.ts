// @ts-nocheck — infra plumbing (auth/session, icon rendering); not part of the SDK-facing surface. Type later.
/**
 * Server-side icon helper.
 *
 * `<ty-icon>` accepts any SVG as a child — no registry, no JS bootstrap,
 * no network round-trip per icon. So we just inline the SVG into the
 * server-rendered HTML.
 *
 * The SVG strings come from Tyrell's icon subpath
 * (`tyrell-components/icons/lucide` — ready-to-inline `<svg>` strings). Swap
 * to `icons/heroicons/*`, `icons/material/*`, etc. the same way.
 *
 * Usage in templates:
 *
 *   ${icon("film")}                       // default size
 *   ${icon("star", { size: "sm" })}
 *   ${icon("star", { size: "xs", slot: "start" })}
 *   ${icon("arrow-left", { class: "extra" })}
 */

import * as L from "tyrell-components/icons/lucide"

// kebab-case ⇒ lucide camelCase export name.
const NAME_OVERRIDES = {
  "chart-column":     "chartColumn",
  "log-in":           "logIn",
  "log-out":          "logOut",
  "shield-check":     "shieldCheck",
  "arrow-left":       "arrowLeft",
  "trending-up":      "trendingUp",
  "send":             "sendHorizontal",
  "list":             "layoutList",
  "place-of-birth":   "mapPin",
  "search":           "searchIcon",
}

function kebabToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function lookup(name) {
  if (!name) return null
  const key = NAME_OVERRIDES[name] ?? kebabToCamel(name)
  return L[key] ?? null
}

/**
 * Render a Tyrell-wrapped SVG icon.
 * @param {string} name  kebab-case icon name (e.g. "arrow-left")
 * @param {object} [opts] forwarded as attributes on the <ty-icon>:
 *                        size, slot, class, style, title, ...
 */
export function icon(name, opts = {}) {
  const svg = lookup(name)
  if (!svg) {
    // Fall back to a small placeholder so missing icons don't break
    // layout — and a console warning so it's noticed in dev.
    console.warn(`[icons] missing icon: ${name}`)
    return `<ty-icon ${attrString(opts)} title="missing: ${escAttr(name)}">${MISSING_SVG}</ty-icon>`
  }
  return `<ty-icon ${attrString(opts)}>${svg}</ty-icon>`
}

function attrString(opts) {
  const out = []
  for (const [k, v] of Object.entries(opts)) {
    if (v == null || v === false) continue
    if (v === true) { out.push(k); continue }
    out.push(`${k}="${escAttr(v)}"`)
  }
  return out.join(" ")
}

function escAttr(v) {
  return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

// Plain "?" inside a circle — used when a requested icon doesn't exist.
const MISSING_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
