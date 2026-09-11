/**
 * Datastar / SSE helpers for this Node BFF.
 *
 * The SDK is a data client — it knows nothing about Datastar or HTML. These
 * helpers translate SDK watch events into Datastar element/signal patches and
 * are specific to *this* frontend choice, so they live with the BFF, not in
 * @synthigy/sdk. Params are structurally typed so this stays node-type-free.
 */

type Writable = { write(chunk: string): void }
type Responder = Writable & { writeHead(status: number, headers: Record<string, string>): void }
type WatchEvent = { type: string; [k: string]: unknown }

export function sseHeaders(res: Responder): void {
  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache, no-transform",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",
  })
  res.write(": connected\n\n")
}

type PatchMode = "inner" | "outer" | "append" | "prepend" | "remove" | "before" | "after"

export function patchElements(
  res: Writable,
  { selector, html = "", mode = "inner" }: { selector: string; html?: string; mode?: PatchMode },
): void {
  res.write("event: datastar-patch-elements\n")
  res.write(`data: selector ${selector}\n`)
  res.write(`data: mode ${mode}\n`)
  const lines = html.length ? html.split("\n") : [""]
  for (const line of lines) res.write(`data: elements ${line}\n`)
  res.write("\n")
}

export function patchSignals(res: Writable, signals: Record<string, unknown>): void {
  res.write("event: datastar-patch-signals\n")
  res.write(`data: signals ${JSON.stringify(signals)}\n`)
  res.write("\n")
}

export function replaceOuter(res: Writable, selector: string, html: string): void {
  patchElements(res, { selector, html, mode: "outer" })
}

export function appendChild(res: Writable, selector: string, html: string): void {
  patchElements(res, { selector, html, mode: "append" })
}

export function removeElement(res: Writable, selector: string): void {
  patchElements(res, { selector, html: "", mode: "remove" })
}

export interface PipeWatchOpts {
  heartbeatMs?: number
  onSentinel?: (ev: WatchEvent) => void
}

/**
 * Pipe a Watch / QueryWatch / SqlTemplateWatch into the response.
 * Closes the watch when the client disconnects or the iterator drains.
 * `render` receives data events; sentinel events go to `opts.onSentinel`.
 */
export async function pipeWatch(
  req: { on(event: "close", cb: () => void): void },
  res: Writable & { end(): void },
  watch: { events: AsyncIterable<WatchEvent>; close(): void },
  render: (ev: WatchEvent) => void,
  opts: PipeWatchOpts = {},
): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? 1_000
  const onSentinel = opts.onSentinel
  let alive = true

  const hb = setInterval(() => {
    if (!alive) return
    try { res.write(": hb\n\n") } catch { alive = false }
  }, heartbeatMs)
  hb.unref?.()

  req.on("close", () => { alive = false; try { watch.close() } catch {} })

  try {
    for await (const ev of watch.events) {
      if (!alive) break
      if (ev.type === "connection/resumed"
          || ev.type === "schema/changed"
          || ev.type === "subscription/rejected"
          || ev.type === "paused") {
        if (onSentinel) onSentinel(ev)
        continue
      }
      // Legacy sentinel shape (no slash in type)
      if (typeof ev?.type === "string" && !ev.type.includes("/")) {
        if (onSentinel) onSentinel(ev)
        continue
      }
      try { render(ev) } catch (e: any) {
        console.error("render error:", e?.message)
      }
    }
  } finally {
    clearInterval(hb)
    try { watch.close() } catch {}
    try { res.end() } catch {}
  }
}

export function esc(s: unknown): string {
  if (s == null) return ""
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
