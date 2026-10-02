import fs from 'node:fs'

// Shared codegen primitives for the TS emitters — one home for the scalar-type
// map + casing so the read and write emitters can't drift apart.

// scalar/enum/ref type → TS. `write` flips the read-only asymmetry: a `hashed`
// field is write-only — `never` in a read result, but a plain `string` you set
// on input.
export const TS = {
  int: 'number', float: 'number', string: 'string', boolean: 'boolean',
  timestamp: 'string', uuid: 'string', json: 'unknown', transit: 'unknown',
  encrypted: 'string',
  // `?name:order` — a "column [asc|desc], …" spec string; the server
  // validates columns against the param's restriction set at bind time.
  order: 'string',
}
export const tsScalar = (attr, write = false) => {
  if (!attr) return 'unknown'
  if (attr.type === 'enum') return (attr.enum ?? []).map((v) => JSON.stringify(v)).join(' | ') || 'string'
  if (attr.type === 'hashed') return write ? 'string' : 'never' // write-only: input string, never read
  return TS[attr.type] ?? 'string' // reference types (type === entity name) → FK id string
}

// casing
export const words = (s) => s.split(/[-_\s]+/).filter(Boolean)
export const pascal = (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1)).join('')
export const camel = (s) => { const p = pascal(s); return p[0].toLowerCase() + p.slice(1) }
// snake_case — the wire-native form. Valid TS identifier, no quoting, and the
// server's DEFAULT response casing, so generated reads need no key_format walk.
export const snake = (s) => words(s).join('_')
// kebab wire keys aren't valid TS identifiers → keep verbatim, quote when needed.
export const tsKey = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k))

// One line on `write` when the schema's deploy stamp is older than the model at
// /.well-known/synthigy. Silent on any failure: generation stays offline-capable.
export async function warnStaleSchema(endpoint, schemaPath, write = (s) => console.error(s)) {
  if (!endpoint || !fs.existsSync(schemaPath)) return
  let local, remote
  try {
    local = JSON.parse(fs.readFileSync(schemaPath, 'utf8')).datasets ?? {}
    const r = await fetch(`${endpoint.replace(/\/$/, '')}/.well-known/synthigy`,
      { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return
    remote = (await r.json()).datasets ?? {}
  } catch {
    return
  }
  const instant = (s) => (Number.isNaN(Date.parse(s)) ? s : Date.parse(s))
  const changed = Object.keys(remote).filter((id) => instant(local[id]?.['deployed-at']) !== instant(remote[id]))
    .concat(Object.keys(local).filter((id) => !(id in remote)))
  if (changed.length) {
    write(`warning: ${schemaPath} is stale against ${endpoint} (${changed.length} datasets changed since the pull) — re-run with --pull`)
  }
}
