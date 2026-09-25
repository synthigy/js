#!/usr/bin/env node
// Unified codegen tool:
//   node codegen.mjs <xsql...> [outDir]     — describe + gen TS (saves ops.ir.json)
//   node codegen.mjs check <xsql...>         — re-describe, diff, exit 1 on drift
//   node codegen.mjs pull [endpoint] [out]   — pull schema.json (wraps pull.mjs)
//
// Config via env: SYNTHIGY_ENDPOINT, SYNTHIGY_CLIENT_ID, SYNTHIGY_CLIENT_SECRET

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { TS, tsScalar, pascal, camel } from './lib.mjs'
import { PLATFORM_AUDIENCE } from '../src/index.js'

let tsVersion = null
try {
  tsVersion = createRequire(import.meta.url)('typescript/package.json').version
} catch {}

const here = path.dirname(new URL(import.meta.url).pathname)

// ── args + flags ──────────────────────────────────────────────────────────────
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
synthigy-codegen — generate TypeScript types from XSQL operations

Usage:
  codegen.mjs [flags] <a.xsql> [b.xsql ...] [outDir]   generate TS from one or more xsql files
  codegen.mjs check   [flags] <a.xsql> [b.xsql ...]    re-describe, diff IR, exit 1 on drift
  codegen.mjs pull    [endpoint] [out]                  pull schema.json only

Flags:
  --pull               force schema refresh before generating
  --keys snake|camel   field key casing in generated types (default: snake)
  --no-writes          omit sync / stack / delete methods
  --schema <path>      explicit schema.json path (skips auto-pull)

Environment:
  SYNTHIGY_ENDPOINT        server URL (required when a server is needed)
  SYNTHIGY_CLIENT_ID       OAuth client ID
  SYNTHIGY_CLIENT_SECRET   OAuth client secret
  SYNTHIGY_AUDIENCE        client_credentials audience, when the server requires one

Examples:
  node codegen.mjs movies.xsql src/generated/        first run auto-pulls schema
  node codegen.mjs --pull movies.xsql src/generated/ force schema refresh + generate
  node codegen.mjs check movies.xsql                 CI drift check
  node codegen.mjs pull http://localhost:7887         pull schema only
`.trim())
  process.exit(0)
}

// Flags (--key val / --flag) extracted first; positionals drive existing logic.
const flags = { keys: 'snake', writes: true, schemaOverride: null, pull: false }
const pos   = []
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if      (a === '--keys'     && process.argv[i+1]) { flags.keys           = process.argv[++i]; continue }
  else if (a === '--no-writes')                     { flags.writes         = false;             continue }
  else if (a === '--schema'   && process.argv[i+1]) { flags.schemaOverride = path.resolve(process.argv[++i]); continue }
  else if (a === '--pull')                          { flags.pull           = true;              continue }
  pos.push(a)
}

const VALID_KEYS = new Set(['snake', 'camel'])
if (!VALID_KEYS.has(flags.keys)) {
  console.error(`--keys must be snake or camel (got: ${flags.keys})`)
  process.exit(1)
}

const checkMode = pos[0] === 'check'
const pullMode  = pos[0] === 'pull'

if (pullMode) {
  execFileSync(process.execPath, [path.join(here, 'pull.mjs'), ...pos.slice(1)],
    { stdio: 'inherit', env: process.env })
  process.exit(0)
}

// Positionals: last non-.xsql arg is outDir; everything before it (files or dirs)
// is input. check mode has no outDir — every positional is input.
const rawPos  = checkMode ? pos.slice(1) : pos
const lastPos = rawPos[rawPos.length - 1]
const hasExplicitOut = !checkMode && rawPos.length > 1 && !lastPos.endsWith('.xsql')
const outArg  = hasExplicitOut ? lastPos : undefined
const xsqlArgs = hasExplicitOut ? rawPos.slice(0, -1) : rawPos

if (!xsqlArgs.length) {
  console.error('usage: node codegen.mjs [flags] <file.xsql|dir> [...] [outDir]   (dirs searched recursively)')
  console.error('       node codegen.mjs check <file.xsql|dir> [...]')
  console.error('       node codegen.mjs pull [endpoint] [schema.json]')
  console.error('flags: --pull                force schema refresh')
  console.error('       --keys snake|camel    field casing (default: snake)')
  console.error('       --no-writes           omit sync/stack/delete methods')
  console.error('       --schema <path>       explicit schema.json path')
  process.exit(1)
}

const isDir = p => fs.existsSync(p) && fs.statSync(p).isDirectory()
const xsqlPaths = xsqlArgs.flatMap(a => {
  const p = path.resolve(a)
  if (isDir(p))
    return fs.readdirSync(p, { recursive: true })
      .map(f => f.split(path.sep).join('/'))
      .filter(f => f.endsWith('.xsql') && fs.statSync(path.join(p, f)).isFile())
      .sort()
      .map(f => path.join(p, f))
  return [p]
})
if (!xsqlPaths.length) { console.error('no .xsql files found'); process.exit(1) }
const firstArg  = path.resolve(xsqlArgs[0])
const xsqlDir   = isDir(firstArg) ? firstArg : path.dirname(firstArg)   // IR + schema.json home
const irPath    = path.join(xsqlDir, 'ops.ir.json')
const outDir    = checkMode
  ? null
  : outArg ? path.resolve(outArg) : path.join(xsqlDir, 'generated')

// Schema path: explicit override > local schema.json (next to first xsql).
// Auto-pull happens below once ENDPOINT is known.
const localSchemaPath = path.join(xsqlDir, 'schema.json')
const schemaPath = flags.schemaOverride ?? localSchemaPath

// Key transform: applies to field names in generated TS only.
// XSQL source + wire format are always snake; the SDK re-cases results at runtime.
const toKey = flags.keys === 'camel' ? camel : s => s

// ── describe ─────────────────────────────────────────────────────────────────
const ENDPOINT = process.env.SYNTHIGY_ENDPOINT
function endpoint() {
  if (ENDPOINT) return ENDPOINT
  console.error('NO_ENDPOINT: no endpoint — set SYNTHIGY_ENDPOINT (run under `synthigy exec`)')
  process.exit(1)
}
const { SYNTHIGY_CLIENT_ID, SYNTHIGY_CLIENT_SECRET, SYNTHIGY_AUDIENCE } = process.env

// Auto-pull schema if missing or --pull requested (saved next to .xsql, cached for future runs).
if (!flags.schemaOverride && (flags.pull || !fs.existsSync(schemaPath))) {
  execFileSync(process.execPath,
    [path.join(here, 'pull.mjs'), endpoint(), schemaPath],
    { stdio: 'inherit', env: process.env })
}

if (!fs.existsSync(schemaPath)) {
  console.error(`schema.json not found — set SYNTHIGY_ENDPOINT + credentials`)
  process.exit(1)
}

async function token() {
  if (!SYNTHIGY_CLIENT_ID) return ''
  const r = await fetch(`${endpoint()}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials',
      client_id: SYNTHIGY_CLIENT_ID, client_secret: SYNTHIGY_CLIENT_SECRET,
      // describe is a platform-API call like any other, so it mints for the
      // platform audience. Hand-rolled here rather than going through the
      // client, so the default has to be named explicitly.
      audience: SYNTHIGY_AUDIENCE || PLATFORM_AUDIENCE }),
  })
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`)
  return (await r.json()).access_token
}

// Merge all xsql files — ops are independent, names must be unique across files.
// `@workspace` is buffer-scoped and must precede the first op, so only the
// first file's survives the merge — left in place it lands INSIDE the
// preceding file's last op and the server rejects that op at run time.
const dropWorkspace = (src) => src.split('\n').filter(l => !/^@workspace\b/.test(l)).join('\n')
const source = xsqlPaths
  .map((p, i) => { const src = fs.readFileSync(p, 'utf8'); return i === 0 ? src : dropWorkspace(src) })
  .join('\n\n')
// describe parses each file on its own — concatenated, file 1's buffer
// @namespace would leak into every later file and theirs would be dropped.
const sources = xsqlPaths.map(p => ({
  path: path.relative(xsqlDir, p).split(path.sep).join('/'),
  source: fs.readFileSync(p, 'utf8'),
}))
// Contract between the .xsql sources on disk and the saved IR: the IR carries
// the hash of the sources it was described from. Mismatch = the IR is stale.
const sourceHash = createHash('sha256').update(source).digest('hex')

// check mode fails FAST and OFFLINE when the sources drifted from the saved IR —
// no backend/credentials needed to catch "edited .xsql, forgot codegen".
// A hash match still goes through the live describe-diff below when a server is
// configured: same sources can yield a different IR after a model change.
if (checkMode && fs.existsSync(irPath)) {
  const saved = JSON.parse(fs.readFileSync(irPath, 'utf8'))
  if (saved.sourceHash && saved.sourceHash !== sourceHash) {
    console.error(`sources drifted from saved IR — run: synthigy-gen ${xsqlArgs.join(' ')}`)
    process.exit(1)
  }
  if (saved.sourceHash && !['SYNTHIGY_ENDPOINT', 'SYNTHIGY_TOKEN', 'SYNTHIGY_CLIENT_ID'].some(k => process.env[k])) {
    console.log('ok — sourceHash matches saved IR (offline; set SYNTHIGY_* env for a live describe-diff)')
    process.exit(0)
  }
}

// Describe: use the cached IR only when it matches the sources on disk
// (avoids needing credentials on every run). Stale/legacy-unhashed IR
// auto-refreshes; NEVER emit from an IR that disagrees with the sources.
let ir
const cached = !flags.pull && !checkMode && fs.existsSync(irPath)
  ? JSON.parse(fs.readFileSync(irPath, 'utf8')) : null
if (cached && cached.sourceHash === sourceHash) {
  ir = cached
  console.log(`using cached IR (${ir.operations?.length ?? 0} ops, in sync with sources) — use --pull to refresh`)
} else {
  if (cached)
    console.log(cached.sourceHash
      ? 'sources changed since IR pull — refreshing'
      : 'saved IR predates source hashing — refreshing')
  try {
    const tok = await token()
    const resp = await fetch(`${endpoint()}/data`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tok && { authorization: `Bearer ${tok}` }) },
      body: JSON.stringify({ operations: [{ op: 'describe', sources }] }),
    })
    if (!resp.ok) throw new Error(`describe ${resp.status}: ${await resp.text()}`)
    const body = await resp.json()
    const r0   = (body.results ?? body.result ?? [body.data ?? body])[0] ?? body
    // A describe that fails answers 200 with {ok:false, error} in the result.
    // Reading .operations off that yields "not iterable" and throws the
    // server's diagnostic away — which is the only thing that says WHICH
    // attribute the templates got wrong.
    const err = r0?.error ?? (r0?.ok === false ? { message: 'describe failed' } : null)
    if (err) throw new Error(err.message ?? JSON.stringify(err))
    ir = r0.result ?? r0.data ?? r0
    if (!Array.isArray(ir?.operations))
      throw new Error(`describe returned no operations: ${JSON.stringify(ir).slice(0, 200)}`)
  } catch (e) {
    console.error(cached
      ? `sources changed since IR pull and describe failed (${e.message}) — run under \`synthigy exec\` or revert the .xsql edit`
      : `describe failed: ${e.message}`)
    process.exit(1)
  }
  ir = { sourceHash, ...ir }
}

// ── check mode ────────────────────────────────────────────────────────────────
if (checkMode) {
  if (!fs.existsSync(irPath)) {
    console.error(`no saved IR at ${irPath} — run: node codegen.mjs ${xsqlArgs.join(' ')}`)
    process.exit(1)
  }
  const savedIr = JSON.parse(fs.readFileSync(irPath, 'utf8'))
  const freshStr = JSON.stringify(ir, null, 2)
  if (JSON.stringify(savedIr, null, 2) === freshStr) {
    console.log(`ok — IR unchanged (${ir.operations?.length ?? 0} ops)`)
    process.exit(0)
  }
  // identity = (namespace ?? entity, name) — bare names repeat across entities
  // (movie/list, user_rating/list), so a name-only match diffs the wrong pairs.
  const opId    = o => o.batch ? `@batch ${o.name}` : `${(o.namespace ?? o.entity ?? '').toLowerCase()}/${o.name.toLowerCase()}`
  const added   = ir.operations.filter(o => !savedIr.operations?.find(s => opId(s) === opId(o)))
  const removed = savedIr.operations?.filter(o => !ir.operations.find(s => opId(s) === opId(o))) ?? []
  const changed = ir.operations.filter(o => {
    const s = savedIr.operations?.find(s => opId(s) === opId(o))
    return s && JSON.stringify(s) !== JSON.stringify(o)
  })
  if (added.length)   console.log(`+ added:   ${added.map(opId).join(', ')}`)
  if (removed.length) console.log(`- removed: ${removed.map(opId).join(', ')}`)
  if (changed.length) console.log(`~ changed: ${changed.map(opId).join(', ')}`)
  console.error(`IR drifted — run: node codegen.mjs ${xsqlArgs.join(' ')}`)
  process.exit(1)
}

// ── save IR ───────────────────────────────────────────────────────────────────
fs.writeFileSync(irPath, JSON.stringify(ir, null, 2) + '\n')

// ── gen ───────────────────────────────────────────────────────────────────────
// Identity (namespace / name), @watch, and sql-template @returns results all come
// from the IR now — the canonical XSQL parser owns them. No XSQL re-parsing here.
const schema  = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
// Installed from npm -> import the package by name; a relative path out of
// node_modules is correct only for one install layout. Inside this repo the
// relative path is still what works, since there is no package to resolve.
const sdkRoot = path.join(here, '..')
const sdkSrc  = sdkRoot.includes(`${path.sep}node_modules${path.sep}`)
  ? '@synthigy/sdk'
  : path.relative(outDir, path.join(sdkRoot, 'src')) + '/index.js'
const ent     = (n) => schema.entities[n] ?? {}
const visited = new Set()

// The server owns pretty-name derivation:
// entity/attribute/relation `skins` in the pulled schema are the contract, not a hint.
// Falls back to the local splitter only for names with no schema entry (op/namespace
// identifiers, which are snake-authored code with no display label to preserve).
const entityPascal = (n) => ent(n).skins?.pascal ?? pascal(n)
const alias = (n) => `_${entityPascal(n)}`

function projectionType(entityName, fields) {
  visited.add(entityName)
  const A       = alias(entityName)
  // scalars become a Pick over the entity; relations + aggregate maps become
  // extra object members. `_count`/`_agg` (kind "map") must NOT enter the Pick —
  // they aren't entity attributes — so filter them out of scalars.
  const scalars = fields.filter(f => f.kind !== 'relation' && f.kind !== 'map').map(f => toKey(f.key))
  const rels    = fields.filter(f => f.kind === 'relation')
  const maps    = fields.filter(f => f.kind === 'map')
  const pick    = scalars.length ? `Pick<${A}, ${scalars.map(k => JSON.stringify(k)).join(' | ')}>` : null
  const relLines = rels.map(r => {
    const target = ent(entityName).relations?.[r.key]?.to ?? r.key   // schema lookup stays snake
    const inner  = projectionType(target, r.fields)
    const t      = r.cardinality === 'many' ? `(${inner})[]` : `(${inner})`
    return `  ${toKey(r.key)}?: ${t}`
  })
  // _count → Record<string, number>; _agg → Record<string, unknown> (honest maps,
  // not a precise nested type — the wire keys are alias-dependent).
  const mapLines = maps.map(m => `  ${m.key}?: Record<string, ${TS[m.value] ?? 'unknown'}>`)
  const objLines = [...relLines, ...mapLines]
  if (!objLines.length) return pick ?? '{}'
  return `${pick ? pick + ' & ' : ''}{\n${objLines.join('\n')}\n}`
}

// Escape a string for use inside a TS template literal.
const xsqlLiteral = (s) => '`' + s.replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'

// Build a wire selection object from IR fields — used by watchQuery / sdk.get.
function fieldsToSel(fields) {
  const obj = {}
  for (const f of fields) {
    if (f.kind === 'map') continue   // _count/_agg have no plain wire-selection form
    obj[f.key] = f.kind === 'relation' ? fieldsToSel(f.fields) : null
  }
  return obj
}

function paramsBody(params) {
  if (!params?.length) return null
  return params.map(p => `  ${p.name}${p.optional ? '?' : ''}: ${TS[p.type] ?? 'string'}${p.array ? '[]' : ''}`).join('\n')
}

// sql-template result type — a flat object from the IR's `result.fields` (which
// the server synthesized from @returns). No fields / no @returns → Record<unknown>.
// `nullable === false` ⇒ non-null column; otherwise nullable (`| null`).
function plainResultType(result) {
  if (!result?.fields?.length) return 'Record<string, unknown>'
  const lines = result.fields.map(f =>
    `  ${toKey(f.key)}: ${TS[f.type] ?? 'unknown'}${f.nullable === false ? '' : ' | null'}`)
  return `{\n${lines.join('\n')}\n}`
}

// Group every read + sql-template op by its declared @namespace (the OOP facade /
// FP module). Identity is (namespace, name) — both come from the IR; the emitter
// does only case-transforms, no string surgery.
const writeData = flags.keys === 'camel'
  ? '(Array.isArray(data) ? data.map(d => _toSnake(d)) : _toSnake(data))'
  : 'data'
// ── Layer 1 (model, 1:1) + Layer 2 (XSQL op overlay) ────────────────────────
// Layer 1: EVERY entity in the IAM-filtered schema → a base namespace with
// sync/stack/delete (typed via `${E}Write`). Layer 2: declared XSQL ops add their
// typed read/sql-template/watch methods onto the matching @namespace. They merge:
// `Movie` ends up with writes (from the model) AND its declared reads.
const allEntities = Object.keys(schema.entities).sort()
const entityByPascal = {}
for (const n of allEntities) entityByPascal[entityPascal(n)] = n

// namespace registry: NS(pascal) → { writeEntity(snake|null), typeAliases[], readMethods[] }
const nsMap = {}
const nsOf = (NS) => (nsMap[NS] ??= { writeEntity: entityByPascal[NS] ?? null, typeAliases: [], readMethods: [] })

// Layer 1 — seed a base namespace for every entity (write methods emitted below).
for (const n of allEntities) nsOf(entityPascal(n))

// Layer 2 — overlay declared ops as typed methods on their @namespace.
// Mutations are Layer-1 territory (schema-derived Entity.sync/stack/delete) —
// never emitted from XSQL. Skip LOUDLY, never silently.
const MUTATE_VERBS = new Set(['sync', 'stack', 'delete'])
const genOps  = []   // generated reads, for @batch member resolution
const batches = []
for (const op of ir.operations) {
  if (op.batch) {
    batches.push(op)
    continue
  }
  if (MUTATE_VERBS.has(op.op)) {
    console.warn(`skipped @${op.op} ${op.name} — mutations are generated from the schema; use ${entityPascal(op.entity ?? '<Entity>')}.${op.op}(data)`)
    continue
  }
  // Namespace defaults to the op's ROOT ENTITY (the model is the source of truth) —
  // `@search list` over `movie` → Movie.list(). @namespace is only needed when there
  // is no root entity (a raw sql-template) or to deliberately group elsewhere.
  const nsName = op.namespace ?? op.entity
  if (!nsName)
    throw new Error(`op "${op.name}": a sql-template with no root entity needs @namespace`)
  const NS = entityPascal(nsName)
  const g  = nsOf(NS)
  const isSql       = op.op === 'sql-template'
  const pb          = paramsBody(op.params)
  const allOptional = !op.params?.length || op.params.every(p => p.optional)
  const Type        = `${NS}${pascal(op.name)}`   // MovieList, MovieGenreList, DashboardStats…
  const ParamsT     = pb ? `${Type}Params` : null
  const pArg        = ParamsT ? `params${allOptional ? '?' : ''}: ${ParamsT}, opts?: ExecOpts` : `opts?: ExecOpts`
  const pPass       = op.params?.length ? `params ?? {}` : '{}'
  const ret         = op.op === 'get' ? `Promise<${Type} | null>` : `Promise<${Type}[]>`
  const methodName  = camel(op.name)

  genOps.push({ op, Type })
  if (ParamsT) g.typeAliases.push(`export type ${ParamsT} = {\n${pb}\n}`)
  g.typeAliases.push(`export type ${Type} = ${isSql ? plainResultType(op.result) : projectionType(op.entity, op.result.fields)}`)
  if (!isSql) g.typeAliases.push(`export const ${Type}Sel = ${JSON.stringify(fieldsToSel(op.result.fields), null, 2)} as const`)

  // @description → JSDoc on the generated method (multiline-safe).
  const jsdoc = op.description
    ? `  /**\n${op.description.split('\n').map(l => `   * ${l.replace(/\*\//g, '* /')}`).join('\n')}\n   */\n`
    : ''
  g.readMethods.push(jsdoc + (isSql
    ? `  ${methodName}(${pArg}): Promise<${Type}[]> {\n    return _client.sqlTemplate<${Type}>(${xsqlLiteral(op.source)}, ${pPass}, opts)\n  }`
    : `  ${methodName}(${pArg}): ${ret} {\n    return _client.query<${Type}>(${xsqlLiteral(`@${op.op} ${op.name}\n` + op.source)}, ${pPass}, { op: ${JSON.stringify(op.op)}, ...opts })\n  }`))
  if (op.watch) g.readMethods.push(isSql
    ? `  watch${pascal(methodName)}(${pArg}): SqlTemplateWatch<${Type}> {\n    return _client.watchSqlTemplate<${Type}>(${xsqlLiteral(op.source)}, ${pPass}, { entities: ${JSON.stringify(Array.isArray(op.watch) ? op.watch : [])}, searchOpts: opts })\n  }`
    : `  watch${pascal(methodName)}(${pArg}): QueryWatch<${Type}> {\n    return _client.watchQuery.xsql<${Type}>(${xsqlLiteral(`@${op.op} ${op.name}\n` + op.source)}, ${pPass}, { entity: ${JSON.stringify(op.entity)}, op: ${JSON.stringify(op.op)}, searchOpts: opts })\n  }`)
}

// @batch <name>: <m1> <m2> → one exported function, ONE exec round trip. Results
// are keyed by member name (qualified ns/name when a bare name repeats); a failed
// member is a SynthigyError VALUE in its slot, never a batch-wide throw. Params
// are one flat object shared by every member — the Python generator's rules.
const opIdentity = o => `${(o.namespace ?? o.entity ?? '').toLowerCase()}/${o.name.toLowerCase()}`
function resolveMember(batchName, ref) {
  const i  = ref.lastIndexOf('/')
  const ns = i >= 0 ? ref.slice(0, i).toLowerCase() : null
  const nm = ref.slice(i + 1).toLowerCase()
  const matches = genOps.filter(({ op }) => op.name.toLowerCase() === nm &&
    (ns === null || (op.namespace ?? op.entity ?? '').toLowerCase() === ns))
  if (!matches.length)
    throw new Error(`@batch ${batchName} references unknown/ungenerated op ${ref}`)
  if (ns === null && matches.length > 1)
    throw new Error(`@batch ${batchName} — ${ref} is ambiguous: ${matches.map(m => opIdentity(m.op)).join(', ')} — qualify the reference`)
  return matches[0]
}
const batchChunks = []
for (const b of batches) {
  const members = b.members.map(ref => resolveMember(b.name, ref))
  const merged = new Map()
  for (const { op } of members)
    for (const p of op.params ?? []) {
      const seen = merged.get(p.name)
      if (!seen) merged.set(p.name, { ...p })
      else if (!p.optional) seen.optional = false
    }
  const params = [...merged.values()]
  const names  = members.map(({ op }) => op.name.toLowerCase())
  const key    = ({ op }) => names.filter(n => n === op.name.toLowerCase()).length > 1 ? opIdentity(op) : op.name
  const fn     = camel(b.name)
  const B      = pascal(b.name)
  const pb     = paramsBody(params)
  const allOpt = params.every(p => p.optional)
  const lines  = []
  if (pb) lines.push(`export type ${B}BatchParams = {\n${pb}\n}`)
  lines.push(`export type ${B}Batch = {\n${members.map(m =>
    `  ${JSON.stringify(key(m))}: ${m.op.op === 'get' ? `${m.Type} | null` : `${m.Type}[]`} | SynthigyError`).join('\n')}\n}`)
  const ops = members.map(({ op }) => op.op === 'sql-template'
    ? `    op.sqlTemplate(${xsqlLiteral(op.source)}, p),`
    : `    op.query(${xsqlLiteral(`@${op.op} ${op.name}\n` + op.source)}, p, ${JSON.stringify(op.op)}),`)
  const res = members.map((m, i) => `    ${JSON.stringify(key(m))}: _batchResult(r[${i}], ${JSON.stringify(m.op.op)}) as ${B}Batch[${JSON.stringify(key(m))}],`)
  lines.push(`/**
 * Batch: ${b.members.join(' + ')} — ONE request. Results are keyed by member; a
 * failed member is a SynthigyError value in its slot, not a throw. Params are one
 * object shared by every member.
 */
export async function ${fn}(${pb ? `params${allOpt ? '?' : ''}: ${B}BatchParams, ` : ''}opts?: ExecOpts): Promise<${B}Batch> {
  const p = ${pb ? 'params ?? {}' : '{}'}
  const r = await _client.exec([
${ops.join('\n')}
  ], opts)
  return {
${res.join('\n')}
  }
}`)
  batchChunks.push(lines.join('\n\n'))
}
if (batchChunks.length) batchChunks.unshift(`function _batchResult(r: OperationResult, verb: string): unknown {
  if (!r?.ok) return new SynthigyError(r?.error?.message ?? 'operation failed', r?.error?.code ?? 'OPERATION_FAILED')
  return verb === 'get' ? (r.data ?? null) : (r.data ?? [])
}`)

// Emit one chunk per namespace: projection types + the object (reads + writes).
const nsChunks = []
for (const NS of Object.keys(nsMap).sort()) {
  const g  = nsMap[NS]
  const we = g.writeEntity
  // Writes are SILENT by default — the server answers { count }. `returning`
  // opts in to the echo, and the return type follows it: the `O extends
  // { returning: true }` conditional resolves per call site, so a default call
  // has no `.xid` and a returning call has no `.count`.
  const retT = `O extends { returning: true } ? Echo<D> : WriteCount`
  const gen  = `D extends ${NS}Write | ${NS}Write[], O extends WriteOpts | undefined = undefined`
  const wd   = `${writeData} as Record<string,unknown> | Record<string,unknown>[]`
  const writeMethods = (flags.writes && we) ? [
    `  sync<${gen}>(data: D, opts?: O): Promise<${retT}> {\n    return _client.sync<${retT}>(${JSON.stringify(we)}, ${wd}, opts)\n  }`,
    `  stack<${gen}>(data: D, opts?: O): Promise<${retT}> {\n    return _client.stack<${retT}>(${JSON.stringify(we)}, ${wd}, opts)\n  }`,
    `  delete(xid: string, opts?: ExecOpts): Promise<unknown> {\n    return _client.delete(${JSON.stringify(we)}, { xid }, opts)\n  }`,
  ] : []
  const methods = [...g.readMethods, ...writeMethods]
  nsChunks.push([
    ...g.typeAliases,
    // entity-backed namespaces: `Movie` is also the read row type. Facades (Dashboard) value-only.
    ...(we ? [`export type ${NS} = ${alias(we)}`] : []),
    `export const ${NS} = {\n${methods.join(',\n')}\n}`,
  ].join('\n\n'))
}

// schema.ts — read + write interface for EVERY entity in the model
const scalarType = (attr) => {
  const base = tsScalar(attr)
  return attr.nullable === false ? base : `${base} | null`
}
const schemaChunks = []
for (const name of allEntities) {                  // 1:1 with the model — every entity
  const e    = ent(name)
  const rels = e.relations ?? {}
  // schema-attached field key, from the same skins contract as entityPascal — falls
  // back to the local splitter only when this field has no schema entry.
  const key  = (skinned, k) => skinned?.skins?.[flags.keys] ?? toKey(k)
  const lines  = ['  xid: string']     // READ shape — every field present
  const wlines = ['  xid?: string']    // WRITE shape — all optional; xid set = update target
  for (const [k, a] of Object.entries(e.attributes ?? {})) {
    if (k === 'xid') continue   // identity already emitted above (non-null); skip the nullable attribute dup
    if (rels[k]) continue
    lines.push(`  ${key(a, k)}: ${scalarType(a)}`)
    const wt = tsScalar(a, true)       // write scalar (e.g. hashed → string, not never)
    if (wt !== 'never') wlines.push(`  ${key(a, k)}?: ${a.nullable === false ? wt : `${wt} | null`}`)
  }
  for (const [k, r] of Object.entries(rels)) {
    if (!schema.entities[r.to]) continue           // relation target filtered out of schema → skip
    lines.push(`  ${key(r, k)}?: ${r.cardinality === 'many' ? `${entityPascal(r.to)}[]` : entityPascal(r.to)}`)
    // WRITE relation: a LINK to an existing record ({ xid }) OR a nested write.
    // This is the FK-reference the wire actually accepts — not the full read entity.
    const link = `{ xid: string } | ${entityPascal(r.to)}Write`
    wlines.push(`  ${key(r, k)}?: ${r.cardinality === 'many' ? `(${link})[]` : link}`)
  }
  schemaChunks.push(`export interface ${entityPascal(name)} {\n${lines.join('\n')}\n}`)
  if (flags.writes) schemaChunks.push(`export interface ${entityPascal(name)}Write {\n${wlines.join('\n')}\n}`)
}

// ops.ts — import every entity's read type (aliased) + write type from schema.ts.
const aliasImports = allEntities.flatMap(n =>
  flags.writes ? [`${entityPascal(n)} as ${alias(n)}`, `${entityPascal(n)}Write`] : [`${entityPascal(n)} as ${alias(n)}`]
).join(', ')
const inputNames = xsqlPaths.map(p => path.basename(p)).join(', ')
const OPS_HDR_COMMENT = `// AUTO-GENERATED from ${inputNames}. Do not edit.\n`
const OPS_HDR_CODE = `import type { SynthigyClient, ClientConfig, ExecOpts, WriteOpts, QueryWatch, SqlTemplateWatch${batchChunks.length ? ', OperationResult' : ''} } from "${sdkSrc}"
import { connect${batchChunks.length ? ', op, SynthigyError' : ''} } from "${sdkSrc}"
import type { ${aliasImports} } from "./schema.js"

/** What a write answers by default — writes are silent unless \`returning\`. */
export type WriteCount = { count: number }

/** What a write answers under \`{ returning: true }\`, cardinality-mirrored. */
export type Echo<D> = D extends any[] ? (D[number] & { xid: string })[] : D & { xid: string }

let _client: SynthigyClient

/**
 * Call once at startup. Installs the process-wide SDK client via \`connect\` —
 * the SAME single client the bare verbs (\`search\`, \`sync\`, …) run on — and
 * points every generated method at it. One process, one client, one token
 * cache, one SSE. Reconnect by calling again (destroys the previous client).
 */
export function configure(config: ClientConfig = {}): void {
  _client = connect(${flags.keys === 'camel' ? '{ ...config, keyFormat: \'camel\' }' : 'config'})
}

/** Return the underlying SDK client — use for calls not covered by generated ops. */
export function client(): SynthigyClient { return _client }
${flags.keys === 'camel' && flags.writes ? `
// Wire writes always use snake_case — transform before sending.
const _toSnake = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(_toSnake)
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => [k.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(), _toSnake(val)]))
  return v
}` : ''}
`
const SCHEMA_HDR = `// AUTO-GENERATED — entity types from /schema ${schema.version ?? ''}. Do not edit.\n`

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'schema.ts'), SCHEMA_HDR + schemaChunks.join('\n\n') + '\n')
fs.writeFileSync(path.join(outDir, 'ops.ts'),    OPS_HDR_COMMENT + OPS_HDR_CODE + [...nsChunks, ...batchChunks].join('\n\n') + '\n')

// Gate, not a builder: VALIDATE the generated TS and FAIL LOUD if it doesn't
// type-check — never ship broken/stale output silently (the old emit-and-swallow
// shipped a stale ops.js once). No .js emitted: consumers import the .ts source
// (Node 23+ type-stripping / a bundler); the type-only `./schema.js` import erases
// at runtime.
// Locate tsc through the SAME resolution that found the `typescript` module
// above, so a hoisted install — the normal consumer layout — is found. A path
// built from `here` only exists when typescript is nested under this package.
const tscBin = (() => {
  try {
    const lib = createRequire(import.meta.url).resolve('typescript')
    const bin = path.join(path.dirname(lib), '..', 'bin', 'tsc')
    if (fs.existsSync(bin)) return bin
  } catch {}
  for (const c of [path.join(here, '..', 'node_modules', '.bin', 'tsc'),
                   path.join(process.cwd(), 'node_modules', '.bin', 'tsc')]) {
    if (fs.existsSync(c)) return c
  }
  return null
})()

// `--ignoreConfig` needs TypeScript 6. On 5.x the flag is itself an error, and
// naming files explicitly already makes tsc skip tsconfig.json, so it is left off.
const tscMajor = Number.parseInt(tsVersion ?? '0', 10) || 0
if (tscBin) {
  try {
    execFileSync(tscBin, [
      ...(tscMajor >= 6 ? ['--ignoreConfig'] : []),
      '--module', 'nodenext', '--moduleResolution', 'nodenext',
      '--target', 'es2022', '--strict', '--skipLibCheck', '--noEmit',
      path.join(outDir, 'ops.ts'),
      path.join(outDir, 'schema.ts'),
    ], { stdio: 'pipe' })
  } catch (e) {
    process.stderr.write('codegen: generated TS failed to type-check (not shipped):\n')
    process.stderr.write((e.stdout ?? e.stderr ?? '').toString())
    process.exit(1)
  }
} else {
  process.stderr.write('codegen: tsc not found — skipping the type-check gate (npm install -D typescript).\n')
}
const flagSummary = [flags.keys !== 'snake' && `keys=${flags.keys}`, !flags.writes && 'no-writes'].filter(Boolean).join(' ')
const opCount = ir.operations.filter(o => !o.batch).length
const inputSummary = xsqlPaths.map(p => path.basename(p)).join(' + ')
console.log(`${inputSummary} → ${allEntities.length} entities (full model), ${Object.keys(nsMap).length} namespaces, ${opCount} ops${batches.length ? `, ${batches.length} batches` : ''}${flagSummary ? ` [${flagSummary}]` : ''} → ${outDir}`)
