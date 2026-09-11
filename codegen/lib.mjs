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
