/**
 * Synthigy Data API Client SDK
 *
 * Thin, zero-dependency client for Synthigy's /data endpoint.
 * Handles service-identity token acquisition (client credentials) and
 * user impersonation via `acting_as`.
 *
 * Intentionally out of scope — leave to the user's chosen libraries:
 *   - OAuth2 authorization-code redirect (framework concern)
 *   - ID-token JWT verification (pick `jose`, `jsonwebtoken`, etc.)
 *   - HTTP pooling / retry / backoff (wrap `fetch` as you see fit)
 *
 * @example
 * ```js
 * import { createClient } from '@synthigy/sdk'
 *
 * const client = createClient({
 *   endpoint: 'https://synthigy.example.com',
 *   clientId: 'my-service',
 *   clientSecret: process.env.SYNTHIGY_CLIENT_SECRET
 * })
 *
 * // Entity names match your ERD model: 'User', 'user', 'user_role', 'UserRole'
 * const users = await client.search('User', {
 *   active: eq(true),
 *   _limit: 10
 * }, {
 *   name: null,
 *   email: null,
 *   roles: rel({ name: null })
 * }, { actingAs: req.session.userEuuid })
 * ```
 */

import { watch as _watch, watchSchema as _watchSchema, getMultiplexer, Watch, SchemaWatch, WatchError } from './watch.js'
import { watchQuery as _watchQuery, watchSqlTemplate as _watchSqlTemplate, QueryWatch, SqlTemplateWatch } from './watch-query.js'

export { Watch, SchemaWatch, WatchError, QueryWatch, SqlTemplateWatch }

// ============================================================================
// Operators — helper functions for building where clauses
// ============================================================================

export const eq = (v) => ({ _eq: v })
export const neq = (v) => ({ _neq: v })
export const gt = (v) => ({ _gt: v })
export const gte = (v) => ({ _ge: v })
export const lt = (v) => ({ _lt: v })
export const lte = (v) => ({ _le: v })
export const in_ = (...v) => ({ _in: v.flat() })
export const nin = (...v) => ({ _nin: v.flat() })
export const like = (v) => ({ _like: v })
export const ilike = (v) => ({ _ilike: v })
export const isNull = () => ({ _is_null: true })
export const isNotNull = () => ({ _is_not_null: true })

// Boolean composers — combine where clauses.
//   and({ active: eq(true) }, { age: gt(18) })  →  { _and: [...] }
export const and = (...clauses) => ({ _and: clauses.flat() })
export const or = (...clauses) => ({ _or: clauses.flat() })
export const not = (clause) => ({ _not: clause })

// ============================================================================
// Selection helpers
// ============================================================================

/**
 * Relation selection helper for complex cases (args, alias, multiple).
 *
 * For simple relations, just pass an object — the SDK wraps it automatically:
 *   { roles: { name: null } }  →  { roles: [{ selections: { name: null } }] }
 *
 * Use rel() when you need args, alias, or multiple occurrences:
 *   { roles: rel({ name: null }, { _limit: 5 }) }
 *   { roles: [
 *       rel({ name: null }, { _where: { active: { _eq: true } } }, "activeRoles"),
 *       rel({ name: null }, { _where: { active: { _eq: false } } }, "archived")
 *   ]}
 *
 * @param {Object} selections - Attribute selections for the relation
 * @param {Object} [args] - Optional filter arguments for the relation
 * @param {string} [alias] - Optional alias for the field
 * @returns {Object} Selection config object; use as-is or in an array for multiple
 */
export function rel(selections, args, alias) {
  const config = { selections: normalizeSelection(selections) }
  if (args) config.args = args
  if (alias) config.alias = alias
  return config
}

/**
 * Normalize a selection for the wire format.
 *
 * Accepts multiple shorthand forms:
 *
 *   Scalars:
 *     null, true        → null (include field)
 *
 *   Array of strings (flat selection):
 *     ['name', 'email'] → { name: null, email: null }
 *
 *   Object shorthand (relation):
 *     { roles: { name: true } }
 *     → { roles: [{ selections: { name: null } }] }
 *
 *   Explicit array (relation with args/alias/multiple):
 *     { roles: [{ selections: { name: null }, args: {...} }] }
 *     → passed through, nested selections normalized
 *
 * All forms can be mixed at any nesting level.
 *
 * Join semantics are the SERVER's: absent `_join` is LEFT (a selection is
 * a projection and never drops parents; relation args filter the related
 * rows). The client injects nothing — pass `args: { _join: 'inner' }`
 * explicitly when the relation's existence should scope its parent.
 */
/**
 * Ensure an XSQL operation DOCUMENT (STRICT wire: XSQL travels only as
 * {op: 'xsql', xsql: <document>}). Sources already starting with `@` pass
 * through — their @verb is authoritative; bare rooted bodies get a
 * synthetic `@<op> _q` header.
 */
function xsqlDocument(source, op) {
  return source.trimStart().startsWith('@') ? source : `@${op} _q\n${source}`
}

function normalizeSelection(selection) {
  if (selection === null || selection === undefined) return selection
  if (selection === true) return null

  // Array of strings → expand to object
  if (Array.isArray(selection)) {
    if (selection.length > 0 && typeof selection[0] === 'string') {
      const expanded = {}
      for (const field of selection) expanded[field] = null
      return expanded
    }
    // Array of rel() configs — normalize nested selections
    return selection.map(config => ({
      ...config,
      ...(config.selections ? { selections: normalizeSelection(config.selections) } : {}),
    }))
  }

  if (typeof selection !== 'object') return selection

  const normalized = {}
  for (const [key, value] of Object.entries(selection)) {
    if (value === null || value === undefined || value === true) {
      // Scalar field
      normalized[key] = null
    } else if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === 'string') {
        // Array of strings as flat selection shorthand
        normalized[key] = [{ selections: normalizeSelection(value) }]
      } else {
        // Array of rel() configs — normalize nested selections
        normalized[key] = value.map(config => ({
          ...config,
          ...(config.selections ? { selections: normalizeSelection(config.selections) } : {}),
        }))
      }
    } else if (typeof value === 'object') {
      if ('selections' in value) {
        // rel() config object — wrap in array
        normalized[key] = [{ ...value, selections: normalizeSelection(value.selections) }]
      } else {
        // Plain shorthand object → wrap as [{ selections: ... }]
        normalized[key] = [{ selections: normalizeSelection(value) }]
      }
    } else {
      normalized[key] = value
    }
  }
  return normalized
}

// ============================================================================
// Tree Composition — nest flat tree/search-tree results
// ============================================================================

/**
 * Read the parent-id off a record using the named FK relation.
 *
 * Accepts either shape:
 *   { father: { xid: "...", ... } }  ← relation included in selection
 *   { father: "..." }                ← or just the id string (rare)
 *   { father: null } or { father: undefined }
 *
 * Works on kebab, snake, or camel casings of the relation name.
 */
function parentId(record, on) {
  if (!record) return null
  // Try a few key-case variants so callers don't have to care
  const variants = [on, on.replace(/-/g, '_'), on.replace(/_/g, '-')]
  for (const k of variants) {
    if (k in record) {
      const v = record[k]
      if (v === null || v === undefined) return null
      if (typeof v === 'object') return v.xid ?? v.euuid ?? v._eid ?? null
      return v
    }
  }
  return null
}

function recordId(record) {
  return record?.xid ?? record?.euuid ?? record?._eid ?? null
}

/**
 * Compose a flat list of records into a single tree rooted at `rootId`.
 *
 * Typical use after `client.getTree(entity, root, on, selection)`:
 *
 *   const flat = await client.getTree('Human', howard, 'father',
 *     { first_name: null, father: { xid: null } })
 *   const tree = composeTree(flat, { on: 'father', rootId: howard })
 *   // → { xid, first_name, _children: [ {..., _children: [...]}, ... ] }
 *
 * Each record must include the parent-FK relation in the selection so the
 * composer can link children to parents. Each child gets attached under the
 * constant `children` key (regardless of which relation we walked).
 *
 * @param {Array<Object>} records - Flat result list (from getTree/searchTree)
 * @param {Object} opts
 * @param {string} opts.on - Relation name used to walk the tree
 * @param {string} [opts.rootId] - Root's id; if omitted, first record is root
 * @param {string} [opts.childrenKey='_children'] - Output nesting key
 * @returns {Object|null} Nested tree, or null if root isn't found
 */
// Two-pass indexing: record-by-id + parent→children-ids. Using id-level
// links avoids a snapshot bug where mutating a child's children after it's
// been copied into a parent leaves stale data in the parent.
function buildIndexes(records, on) {
  const byId = new Map()
  const kids = new Map()
  for (const r of records) {
    const id = recordId(r)
    if (id == null) continue
    byId.set(id, r)
    const pid = parentId(r, on)
    if (pid != null && pid !== id) {
      if (!kids.has(pid)) kids.set(pid, [])
      kids.get(pid).push(id)
    }
  }
  return { byId, kids }
}

function buildSubtree(byId, kids, childrenKey, id, visited) {
  if (visited.has(id)) return null        // cycle — break
  visited.add(id)
  const record = byId.get(id)
  const childIds = kids.get(id) ?? []
  const result = {
    ...record,
    [childrenKey]: childIds
      .map(cid => buildSubtree(byId, kids, childrenKey, cid, visited))
      .filter(x => x !== null),
  }
  visited.delete(id)
  return result
}

export function composeTree(records, { on, rootId, childrenKey = '_children' } = {}) {
  if (!Array.isArray(records) || records.length === 0) return null
  if (!on) throw new Error('composeTree: `on` (relation name) is required')

  const { byId, kids } = buildIndexes(records, on)
  const root = rootId ?? recordId(records[0])
  return byId.has(root) ? buildSubtree(byId, kids, childrenKey, root, new Set()) : null
}

/**
 * Compose a flat list into a forest — returns an array of trees where each
 * tree is rooted at a record whose parent isn't present in the set. Useful
 * for `search-tree` results where multiple independent ancestor chains may
 * be returned.
 *
 * @param {Array<Object>} records
 * @param {Object} opts
 * @param {string} opts.on - Relation name
 * @param {string} [opts.childrenKey='children']
 * @returns {Array<Object>}
 */
export function composeForest(records, { on, childrenKey = '_children' } = {}) {
  if (!Array.isArray(records) || records.length === 0) return []
  if (!on) throw new Error('composeForest: `on` (relation name) is required')

  const { byId, kids } = buildIndexes(records, on)
  const rootIds = []
  for (const r of records) {
    const id = recordId(r)
    if (id == null) continue
    const pid = parentId(r, on)
    if (pid == null || !byId.has(pid) || pid === id) rootIds.push(id)
  }
  return rootIds.map(id => buildSubtree(byId, kids, childrenKey, id, new Set()))
}

// ============================================================================
// Subscription descriptors
// ============================================================================

/**
 * Normalize a subscribe()/observe() descriptor argument.
 *
 *   ['xid-a', 'xid-b']                                    → {records: Set(2)}
 *   { records: ['xid-a'], operations: ['update'] }        → {records: Set(1), operations: Set(1)}
 *
 * Throws SynthigyError on bad input or the legacy entity-firehose form
 * (a plain string).
 *
 * @private
 */
function _normalizeDescriptor(arg) {
  if (typeof arg === 'string') {
    throw new SynthigyError(
      'Subscriptions are records-only. Pass an array of xids or {records: [...]} instead of an entity name.',
      'INVALID_SUBSCRIPTION'
    )
  }
  if (Array.isArray(arg)) {
    if (arg.length === 0) {
      throw new SynthigyError('records must be a non-empty array of xid strings',
                              'EMPTY_RECORDS')
    }
    return { records: new Set(arg) }
  }
  if (arg && typeof arg === 'object' && Array.isArray(arg.records)) {
    if (arg.records.length === 0) {
      throw new SynthigyError('records must be a non-empty array of xid strings',
                              'EMPTY_RECORDS')
    }
    const out = { records: new Set(arg.records) }
    if (arg.operations !== undefined) {
      if (!Array.isArray(arg.operations)) {
        throw new SynthigyError('operations must be an array of vocab strings',
                                'INVALID_OPERATIONS')
      }
      out.operations = new Set(arg.operations)
    }
    return out
  }
  throw new SynthigyError(
    'Expected an array of xids or a {records, operations?} descriptor',
    'INVALID_SUBSCRIPTION'
  )
}

/**
 * Stable string key for a normalized descriptor — sorted records +
 * sorted operations, JSON-stringified. Used as the local mirror key
 * when the caller doesn't pass an explicit `key`. Re-subscribing with
 * the same records + operations is therefore idempotent.
 *
 * @private
 */
function _descriptorKey(descriptor) {
  const records = [...descriptor.records].sort()
  const operations = descriptor.operations
    ? [...descriptor.operations].sort()
    : null
  return JSON.stringify({ records, operations })
}

// ============================================================================
// Token Manager — handles client credentials flow
// ============================================================================

class TokenManager {
  constructor({ tokenUrl, clientId, clientSecret, scope, fetch: fetchImpl }) {
    this._tokenUrl = tokenUrl
    this._clientId = clientId
    this._clientSecret = clientSecret
    this._scope = scope
    this._fetch = fetchImpl ?? globalThis.fetch.bind(globalThis)
    this._tokens = new Map()  // audience -> { token, expiresAt }
  }

  async getToken(audience) {
    const key = audience || ''

    // Return cached token if still valid (with 30s buffer)
    const cached = this._tokens.get(key)
    if (cached && Date.now() < cached.expiresAt - 30000) {
      return cached.token
    }

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this._clientId,
      client_secret: this._clientSecret,
    })
    if (this._scope) params.set('scope', this._scope)
    if (audience) params.set('audience', audience)

    const resp = await this._fetch(this._tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Token request failed (${resp.status}): ${text}`)
    }

    const data = await resp.json()
    this._tokens.set(key, {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    })
    return data.access_token
  }

  /** Drop every cached token — the next getToken() call refetches. */
  clear() {
    this._tokens.clear()
  }
}

// ============================================================================
// Supervised stdio — SYNTHIGY_SUPERVISED=1, see
// docs/plans/PLAN-EXEC-IDENTITY.md steps 2-4. The SDK never mints locally
// under this mode: the CLI/commander is the platform's stdio owner, so a
// token is asked for over JSON-RPC on the process's OWN stdio (supervise
// grammar) instead. {token, expires_in} is deliberately byte-compatible
// with robotics' request-access-token response, so this ask serves both
// parents (exec locally, the commander through a reacher agent in
// production). Node-only — a browser has neither process.stdin nor
// process.env, so this code path is only ever reached behind the
// `typeof process !== 'undefined'` guard in the constructor below.
//
// JS is single-threaded, so there's no read-race the way the Python SDK
// has (two OS threads calling readline() on the same stdin can steal each
// other's line there) — a persistent 'data' listener buffering chunks and
// splitting on '\n' is the whole story, no lock/thread machinery needed.
// Still ONE listener for the whole process lifetime (not one per ask):
// every SupervisedTokenSource shares the one supervising parent, so a
// second independent ask would just be a wasted round trip — and the
// cache lives here too, for the same reason.
// ============================================================================

const SUPERVISED_TIMEOUT_MS = 5000

class SupervisedIO {
  constructor() {
    this._pending = new Map()   // request id -> deliver(msg|null)
    this._nextId = 0
    this._tokens = new Map()    // audience -> { token, expiresAt }
    this._buffer = ''
    this._readerStarted = false
    this._writeGuarded = false
    this._writeBroken = false
  }

  _ensureReader() {
    if (this._readerStarted) return
    this._readerStarted = true
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => this._onData(chunk))
    process.stdin.on('end', () => this._onEnd())
    process.stdin.on('error', () => this._onEnd())
  }

  // Node raises stdout write failures (EPIPE — parent already gone) as an
  // async 'error' EVENT, not an exception from write() itself; an
  // unhandled 'error' event on a stream crashes the whole process. This
  // listener is the fix — once attached, a broken pipe just flips a flag
  // that future asks check, instead of taking the host process down with
  // it. Attached lazily (not at module load) so a process that never
  // touches a supervised token never installs it.
  _ensureWriteGuard() {
    if (this._writeGuarded) return
    this._writeGuarded = true
    process.stdout.on('error', () => { this._writeBroken = true })
  }

  _onData(chunk) {
    this._buffer += chunk
    let idx
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx)
      this._buffer = this._buffer.slice(idx + 1)
      this._handleLine(line)
    }
  }

  // Strict candidate test (first byte '{', then parses, then carries
  // jsonrpc:"2.0") — the same rule the parent side uses. A malformed
  // candidate line must not take the dispatcher down with it — the whole
  // body is one try/catch, never letting a bad line kill future asks.
  _handleLine(line) {
    try {
      const trimmed = line.trim()
      if (!trimmed || trimmed[0] !== '{') return
      const msg = JSON.parse(trimmed)
      if (msg.jsonrpc !== '2.0') return
      const deliver = this._pending.get(msg.id)
      if (deliver) deliver(msg)
    } catch {
      // Malformed JSON, or anything else — keep listening.
    }
  }

  // EOF, or a stdin stream error: there is no listener anymore. Flush
  // every pending ask so it fails fast instead of idling to its own
  // timeout.
  _onEnd() {
    const waiters = [...this._pending.values()]
    this._pending.clear()
    for (const deliver of waiters) deliver(null)
  }

  // Sends one JSON-RPC request, resolves with the matching response, or
  // null on timeout, parent EOF, or a write failure.
  _ask(method, params, timeoutMs) {
    this._ensureReader()
    this._ensureWriteGuard()
    const id = ++this._nextId
    return new Promise((resolve) => {
      let settled = false
      let timer
      const deliver = (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._pending.delete(id)
        resolve(v)
      }
      timer = setTimeout(() => deliver(null), timeoutMs)
      this._pending.set(id, deliver)
      if (this._writeBroken) { deliver(null); return }
      try {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n')
      } catch {
        deliver(null)
      }
    })
  }

  // Per-audience cache with a 30s pre-expiry buffer, matching
  // TokenManager's own discipline — extended process-wide (one cache) since
  // every SupervisedTokenSource in a process shares one supervising parent.
  async getToken(audience) {
    const key = audience || ''
    const cached = this._tokens.get(key)
    if (cached && Date.now() < cached.expiresAt - 30000) {
      return cached.token
    }

    const params = audience ? { audience } : {}
    const msg = await this._ask('auth.token', params, SUPERVISED_TIMEOUT_MS)

    if (!msg) {
      throw new SynthigyError(
        'Timed out waiting for auth.token from the supervising parent — ' +
        'a hung or missing parent must not hang the bot. Check the ' +
        'parent process (synthigy exec/agent, or the robotics commander) ' +
        'is still connected.', 'NO_TOKEN')
    }
    if (msg.error) {
      throw new SynthigyError(msg.error.message || 'auth.token request denied', 'NO_TOKEN')
    }
    const token = msg.result?.token
    if (!token) {
      throw new SynthigyError('auth.token response carried no token', 'NO_TOKEN')
    }
    // A malformed/non-numeric expires_in from the parent must not crash
    // the cache-expiry computation.
    const raw = msg.result?.expires_in
    const n = raw == null ? NaN : Number(raw)
    const expiresIn = Number.isFinite(n) ? n : 300
    this._tokens.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 })
    return token
  }

  clear() {
    this._tokens.clear()
  }
}

let _supervisedIO = null
function _getSupervisedIO() {
  if (!_supervisedIO) _supervisedIO = new SupervisedIO()
  return _supervisedIO
}

/**
 * Token source for SYNTHIGY_SUPERVISED=1 — asks `auth.token` over the
 * process's own stdio instead of minting locally (the CLI/commander is
 * the platform's stdio owner; this SDK never mints, per
 * PLAN-EXEC-IDENTITY step 2). Same public shape as TokenManager
 * (getToken/clear) so call sites don't care which source is installed —
 * a thin handle onto the real, process-wide SupervisedIO singleton
 * (cache and all), so multiple clients in one process share one cache
 * instead of each asking the parent independently.
 */
class SupervisedTokenSource {
  getToken(audience) {
    return _getSupervisedIO().getToken(audience)
  }

  clear() {
    _getSupervisedIO().clear()
  }
}

/** The teaching throw — PLAN-EXEC-IDENTITY step 3: the error IS the UX, no flag, no silent anonymous fallback. */
function _noTokenError() {
  return new SynthigyError(
    'no Synthigy token: set token, or clientId + clientSecret, or set ' +
    'SYNTHIGY_TOKEN, or run under `synthigy exec` (or a Synthigy agent) ' +
    'with SYNTHIGY_SUPERVISED=1 so a parent can supply one.', 'NO_TOKEN')
}

// ============================================================================
// Error
// ============================================================================

/**
 * Map from error code → category. Codes not in the table fall back to
 * `internal` at construction time.
 *
 * Categories are stable enums consumers can branch on:
 *   - auth        — token / session / IdP issues. Re-authenticate.
 *   - iam         — RBAC/RLS denial. Caller lacks permission.
 *   - validation  — caller's request shape is invalid.
 *   - not_found   — referenced entity/relation/record doesn't exist.
 *   - conflict    — constraint violation, optimistic-concurrency, etc.
 *   - rate_limit  — too many requests.
 *   - network     — transport failure (DNS, TCP, timeout, abort).
 *   - internal    — unexpected server error. Retry-safe; check logs.
 */
const ERROR_CATEGORIES = {
  // auth
  UNAUTHORIZED:               'auth',
  CLIENT_NOT_FOUND:           'auth',
  CLIENT_INACTIVE:            'auth',
  PUBLIC_CLIENT_FORBIDDEN:    'auth',
  NOT_TRUSTED:                'auth',
  USER_NOT_FOUND:             'auth',
  USER_INACTIVE:              'auth',
  PROVISION_FORBIDDEN:        'auth',
  CLAIM_INVALID:              'auth',
  NO_TOKEN:                   'auth', // client-side: no token source configured — retrying can't fix it
  // iam
  FORBIDDEN:                  'iam',
  FORBIDDEN_OP:               'iam',
  ENTITY_FORBIDDEN:           'iam',
  ENTITY_NOT_READABLE:        'iam',
  RELATION_NOT_READABLE:      'iam',
  // validation
  INVALID_BODY:               'validation',
  NO_OPERATIONS:              'validation',
  UNKNOWN_OP:                 'validation',
  UNKNOWN_OPERATOR:           'validation',
  MISSING_ON:                 'validation',
  MISSING_ROOT:               'validation',
  MISSING_RECORDS:            'validation',
  EMPTY_RECORDS:              'validation',
  MISSING_ENTITIES:           'validation',
  EMPTY_ENTITIES:             'validation',
  MISSING_RELATIONS:          'validation',
  EMPTY_RELATIONS:            'validation',
  INVALID_RELATION_NAME:      'validation',
  INVALID_SUBSCRIPTION:       'validation',
  INVALID_OPERATIONS:         'validation',
  INVALID_INTEREST:           'validation',
  EMPTY_INTEREST:             'validation',
  UNSUPPORTED_TYPE:           'validation',
  XSQL_PARSE_ERROR:           'validation',
  TEMPLATE_BAD_CTE:           'validation',
  TEMPLATE_UNBALANCED_PARENS: 'validation',
  TEMPLATE_ERROR:             'validation',
  TEMPLATE_PARAM_ERROR:       'validation',
  QUERY_NOT_SELECT:           'validation',
  PARAM_MISSING:              'validation',
  PARAM_TYPE_MISMATCH:        'validation',
  NOT_CONNECTED:              'validation', // client-side guard — retrying without connecting can't fix it
  XID_REQUIRED:               'validation',
  CLAIM_METHOD_NOT_ALLOWED:   'validation',
  PASSWORD_TOO_WEAK:          'validation',
  RETURN_URL_NOT_REGISTERED:  'validation',
  // not_found
  UNKNOWN_ENTITY:             'not_found',
  UNKNOWN_RELATION:           'not_found',
  UNKNOWN_TEMPLATE_RELATION:  'not_found',
  HISTORY_UNAVAILABLE:        'not_found', // no audit provider — retrying can't fix it
  // conflict (e.g., DB constraint violations the server translates)
  FK_VIOLATION:               'conflict',
  UNIQUE_VIOLATION:           'conflict',
  CHECK_VIOLATION:            'conflict',
  NOT_NULL_VIOLATION:         'conflict',
  // rate / capacity
  TIMEOUT:                    'rate_limit',
  // network
  NETWORK_ERROR:              'network',
  // internal — fallback
  INTERNAL_ERROR:             'internal',
  OPERATION_ERROR:            'internal',
  HTTP_ERROR:                 'internal',
}

/**
 * Codes whose category is automatically retryable. Any other code is
 * one-shot: the caller must fix something before retrying.
 */
const RETRYABLE_CATEGORIES = new Set(['network', 'rate_limit', 'internal'])

/**
 * SDK error class — every error the SDK throws is an instance.
 *
 * Always present:
 *   - .message  — human-readable description
 *   - .code     — stable string code (see ERRORS.md for the catalog)
 *   - .category — 'auth' | 'iam' | 'validation' | 'not_found' |
 *                 'conflict' | 'rate_limit' | 'network' | 'internal'
 *   - .retryable— boolean. True if the same request might succeed if retried.
 *
 * Optional, present when the server included them:
 *   - .details  — opaque payload from the server (legacy field; new
 *                 code should prefer the structured fields below)
 *   - .hint     — "Did you mean X?" suggestion for typos
 *   - .available— array of valid alternatives (e.g., relations on the entity)
 *   - .path     — JSON path into the request where validation failed
 *   - .entity   — entity name involved
 *   - .relation — relation name involved
 *   - .operator — operator name involved
 *   - .requestId— request ID for cross-correlation with server logs
 *   - .status   — HTTP status code (for transport-level errors)
 */
export class SynthigyError extends Error {
  constructor(message, code, details, extras) {
    super(message)
    this.name      = 'SynthigyError'
    this.code      = code
    this.category  = ERROR_CATEGORIES[code] ?? 'internal'
    this.retryable = RETRYABLE_CATEGORIES.has(this.category)
    if (details !== undefined) this.details = details
    if (extras) {
      if (extras.hint        !== undefined) this.hint        = extras.hint
      if (extras.available   !== undefined) this.available   = extras.available
      if (extras.path        !== undefined) this.path        = extras.path
      if (extras.entity      !== undefined) this.entity      = extras.entity
      if (extras.relation    !== undefined) this.relation    = extras.relation
      if (extras.operator    !== undefined) this.operator    = extras.operator
      if (extras.requestId   !== undefined) this.requestId   = extras.requestId
      if (extras.status      !== undefined) this.status      = extras.status
      // Source position fields — populated for XSQL_PARSE_ERROR and
      // TEMPLATE_* errors. `line`/`col` are 1-based, suitable for
      // pointing an editor at the offending token. `start`/`end` are
      // range forms (`{line, col}` each) when the error spans a token.
      // `diagnostics` is the full array from the XSQL linter.
      if (extras.line        !== undefined) this.line        = extras.line
      if (extras.col         !== undefined) this.col         = extras.col
      if (extras.start       !== undefined) this.start       = extras.start
      if (extras.end         !== undefined) this.end         = extras.end
      if (extras.diagnostics !== undefined) this.diagnostics = extras.diagnostics
    }
  }
}

/**
 * Generate a fresh request ID for X-Request-Id headers. 16 chars of
 * URL-safe random — enough entropy to not collide in a single client's
 * lifetime, short enough to read in logs.
 * @internal
 */
function _generateRequestId() {
  const buf = new Uint8Array(12)
  ;(globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(buf)
    : (() => { for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256) })())
  return Buffer.from(buf).toString('base64url')
}

/**
 * Build a SynthigyError from a server-returned error object.
 * @internal
 */
function _errorFromServer(err, status, requestId) {
  return new SynthigyError(err.message, err.code, err.details, {
    hint:        err.hint,
    available:   err.available,
    path:        err.path,
    entity:      err.entity,
    relation:    err.relation,
    operator:    err.operator,
    line:        err.line,
    col:         err.col,
    start:       err.start,
    end:         err.end,
    diagnostics: err.diagnostics,
    requestId,
    status,
  })
}

/**
 * Build a SynthigyError from a non-ok /oauth/onboard or /oauth/onboard/complete
 * response. Wire shape here is {error: "<snake_case_code>"} — a bare string,
 * unlike the {error: {code, message}} envelope /data uses — so it's handled
 * separately rather than through _errorFromServer (which would silently miss
 * the code on a string).
 * @internal
 */
async function onboardError(resp) {
  const data = await resp.json().catch(() => ({}))
  const code = (typeof data.error === 'string' ? data.error : null)
  if (code) return new SynthigyError(`onboard failed: ${code}`, code.toUpperCase(), undefined, { status: resp.status })
  return new SynthigyError(`onboard request failed (${resp.status})`, 'HTTP_ERROR', undefined, { status: resp.status })
}

// ============================================================================
// Client
// ============================================================================

class SynthigyClient {
  /**
   * @param {Object} config
   * @param {string} config.endpoint - Synthigy base URL
   * @param {string} [config.clientId] - OAuth client ID (for client credentials)
   * @param {string} [config.clientSecret] - OAuth client secret
   * @param {string} [config.token] - Static bearer token (alternative to client credentials)
   *
   * On Node, with none of the above, the constructor also falls back to —
   * when SYNTHIGY_SUPERVISED=1 — a supervised-stdio auth.token ask (the
   * pipe beats the env var: it can refresh mid-run), then the
   * SYNTHIGY_TOKEN env var (see docs/plans/PLAN-EXEC-IDENTITY.md step 3).
   * With no source at all it throws a SynthigyError whose code is
   * NO_TOKEN and whose message teaches the fix. A browser has neither
   * env vars nor a stdio parent, so it always requires an explicit source.
   * @param {string} [config.scope] - OAuth scopes
   * @param {string} [config.actingAs] - Default impersonation target — applied
   *                                     to every request unless overridden
   *                                     per-call. Useful for per-session clients.
   * @param {'kebab'|'snake'|'camel'} [config.keyFormat] - Default key-case for
   *                                     response payloads. Server defaults to
   *                                     snake_case; set "kebab" for kebab-case
   *                                     (or override per-call via opts.keyFormat).
   * @param {Function} [config.fetch] - Optional fetch implementation. Defaults
   *                                    to `globalThis.fetch`. For Node services
   *                                    that need pooled HTTP connections, pass
   *                                    `undici.fetch` with a shared `Agent`:
   *
   *     import { Agent, fetch } from "undici"
   *     const agent = new Agent({ keepAliveTimeout: 30_000, connections: 50 })
   *     const client = createClient({
   *       endpoint, clientId, clientSecret,
   *       fetch: (url, init) => fetch(url, { ...init, dispatcher: agent }),
   *     })
   */
  constructor(config) {
    this._endpoint = config.endpoint.replace(/\/$/, '')
    this._dataUrl = `${this._endpoint}/data`
    this._defaultActingAs = config.actingAs ?? null
    this._defaultKeyFormat = config.keyFormat ?? null
    this._timeout = config.timeout ?? null
    this._fetch = config.fetch ?? globalThis.fetch.bind(globalThis)
    // Stored so the OIDC helpers can authenticate code-exchange and
    // default the ID-token audience to this client's own id.
    this._clientId = config.clientId ?? null
    this._clientSecret = config.clientSecret ?? null
    // Long-lived contexts (BFFs, Node services) want the upstream SSE pinned
    // open across user-watch churn so the plug session keyed by
    // [sub, client_id] isn't torn down between watches. Replaces the
    // earlier "dummy keepalive watch" workaround.
    this._keepAlive = config.keepAlive === true
    // The platform's audience model is opt-in: a client_credentials mint
    // naming no audience resolves to the identity-only OIDC audience, which
    // /data rejects. Bound once here, applied to every mint this client makes.
    this._defaultAudience = config.audience
      ?? (typeof process !== 'undefined' ? process.env?.SYNTHIGY_AUDIENCE : undefined)
      ?? undefined

    if (config.token !== undefined && config.token !== null) {
      // Static token mode — empty string allowed for unauth / dev servers.
      this._tokenManager = null
      this._getToken = async () => config.token
    } else if (config.clientId && config.clientSecret) {
      // Client credentials mode
      this._tokenManager = new TokenManager({
        tokenUrl: `${this._endpoint}/oauth/token`,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scope: config.scope,
        fetch: this._fetch,
      })
      this._getToken = () => this._tokenManager.getToken(this._defaultAudience)
    } else if (typeof process !== 'undefined' && process.env?.SYNTHIGY_SUPERVISED === '1') {
      // The pipe beats the env var: exec injects the cached token AND
      // supervises; only the pipe refreshes mid-run.
      this._tokenManager = new SupervisedTokenSource()
      this._getToken = () => this._tokenManager.getToken(this._defaultAudience)
    } else if (typeof process !== 'undefined' && process.env?.SYNTHIGY_TOKEN) {
      // A snapshot, not a live source: exec/connect refresh and rewrite
      // the profile's cache on THEIR next run, not this process's.
      const envToken = process.env.SYNTHIGY_TOKEN
      this._tokenManager = null
      this._getToken = async () => envToken
    } else {
      throw _noTokenError()
    }

    // Local mirror of the session's subscription set. The server uses
    // full set-replacement semantics on /data/subscription/set, so the
    // SDK tracks intent here and re-sends the full set on each change.
    // Each entry is a record descriptor
    // {records: Set<string>, operations?: Set<string>}. Keyed by either
    // a caller-supplied `key` or a stable hash of the descriptor.
    this._dataSubs     = new Map()    // key → descriptor (records, ops)
    this._modelSubs    = new Set()    // 'deployed-model' | 'runtime-model'
    this._entitySubs   = new Set()    // entity names — entity track union
    this._relationSubs = new Set()    // 'entity.label' strings — relation track union

    // Eagerly construct the multiplexer when keepAlive is on so its
    // constructor opens the SSE before any user watch lands.
    if (this._keepAlive) getMultiplexer(this)
  }

  /**
   * Tear the client down — close every live watch, release the keepAlive
   * hold, close the SSE. Use this when a long-lived BFF / service is
   * shutting down so the plug session is dropped cleanly server-side
   * (rather than waiting for the SSE to time out).
   */
  close() {
    if (this.__watchMux) this.__watchMux.close()
  }

  /**
   * Shared fetch transport — attaches Authorization header, retries once on 401
   * (token may have been rotated since it was cached). Throws SynthigyError on
   * UNAUTHORIZED. All other status codes are returned to the caller to handle.
   *
   * Auto-injects an X-Request-Id header (caller-supplied or freshly
   * generated). The server echoes it back as the response X-Request-Id
   * header and logs include it via request-completed events, so callers
   * can correlate client logs with server logs.
   */
  async _fetchAuth(url, fetchOpts = {}, { applyTimeout = true, requestId } = {}) {
    const attempt = async () => {
      const token = await this._getToken()
      const headers = { ...fetchOpts.headers }
      if (token) headers['Authorization'] = `Bearer ${token}`
      if (!headers['X-Request-Id'] && !headers['x-request-id']) {
        headers['X-Request-Id'] = requestId ?? _generateRequestId()
      }
      const opts = { ...fetchOpts, headers }
      if (applyTimeout && this._timeout && !opts.signal) opts.signal = AbortSignal.timeout(this._timeout)
      return this._fetch(url, opts)
    }

    let resp = await attempt()
    if (resp.status === 401 && this._tokenManager) {
      this._tokenManager.clear()
      resp = await attempt()
    }
    if (resp.status === 401) {
      const requestId = resp.headers?.get?.('x-request-id') ?? undefined
      throw new SynthigyError('Unauthorized', 'UNAUTHORIZED', undefined,
        { requestId, status: 401 })
    }
    return resp
  }

  /**
   * Shared POST transport for the /data endpoint — handles 403, 5xx, and JSON parsing.
   * Returns the parsed JSON body augmented with `_requestId` so callers
   * can thread it into any error they throw downstream from per-op
   * results (`{ok: false, error}`).
   */
  async _post(body) {
    const resp = await this._fetchAuth(this._dataUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const requestId = resp.headers?.get?.('x-request-id') ?? undefined
    if (resp.status === 403) {
      const data = await resp.json().catch(() => ({}))
      throw _errorFromServer(
        data.error ?? { message: 'Forbidden', code: 'FORBIDDEN' },
        403, requestId)
    }
    if (!resp.ok) {
      const text = await resp.text()
      let data
      try { data = JSON.parse(text) } catch { /* not JSON */ }
      if (data?.error) {
        throw _errorFromServer(data.error, resp.status, requestId)
      }
      throw new SynthigyError(`Request failed (${resp.status})`, 'HTTP_ERROR', text,
        { requestId, status: resp.status })
    }
    const body_ = await resp.json()
    if (body_ && typeof body_ === 'object' && requestId) body_._requestId = requestId
    return body_
  }

  /**
   * Produce a `FetchFn` suitable for feeding to `@synthigy/buffer`'s
   * `connect({fetchFn})`.
   *
   * Pure transport: takes a body, attaches auth, POSTs to `/data`. Does not
   * modify the body — add `acting_as` at the buffer level if needed.
   *
   * @returns {(body: object) => Promise<{results: Array}>} FetchFn
   *
   * @example
   * ```js
   * const buffer = await connect({
   *   fetchFn: client.fetchFn(),
   *   entities: ["user", "user-role"],
   *   actingAs: req.session.userEuuid,
   * })
   * ```
   */
  fetchFn() {
    return (body) => this._post(body)
  }

  /**
   * Get an access token for a specific audience.
   *
   * Synthigy acts as the identity provider. Use this to get tokens
   * for external services (robotics, project management, etc.) that
   * trust Synthigy as their IdP.
   *
   * Tokens are cached per audience and auto-refreshed before expiry.
   *
   * @param {Object} [opts] - Options
   * @param {string} [opts.audience] - Target audience (omit to use the
   *                                   client's configured `audience`)
   * @returns {Promise<string>} Bearer access token
   *
   * @example
   * ```js
   * // Token for Synthigy itself (same as internal data operations)
   * const token = await client.token()
   *
   * // Token for Robotics API
   * const roboticsToken = await client.token({ audience: 'robotics' })
   *
   * // Use with any HTTP client
   * const resp = await fetch('https://robotics.example.com/api/robots', {
   *   headers: { 'Authorization': `Bearer ${roboticsToken}` },
   * })
   * ```
   */
  async token(opts) {
    if (!this._tokenManager) {
      // Static token mode — return the static token regardless of audience
      return this._getToken()
    }
    return this._tokenManager.getToken(opts?.audience ?? this._defaultAudience)
  }

  /**
   * Execute raw operations against the /data endpoint.
   *
   * @param {Array<Object>} operations - Array of operation objects
   * @param {Object} [opts] - Options
   * @param {string} [opts.actingAs] - User EUUID to act on behalf of
   * @param {'kebab'|'snake'|'camel'} [opts.keyFormat] - Response key-case override
   * @returns {Promise<Array>} Array of results
   */
  async exec(operations, opts) {
    const body = { operations }
    const actingAs = opts?.actingAs ?? this._defaultActingAs
    if (actingAs) body.acting_as = actingAs
    const keyFormat = opts?.keyFormat ?? this._defaultKeyFormat
    if (keyFormat) body.key_format = keyFormat

    const respBody = await this._post(body)
    const { results, error, _requestId: requestId } = respBody
    if (error) throw _errorFromServer(error, undefined, requestId)
    // Tag each per-op result with the request-id so downstream throw
    // sites (search, get, sync, etc.) can attach it to the SynthigyError.
    if (requestId && Array.isArray(results)) {
      for (const r of results) {
        if (r && typeof r === 'object') r._requestId = requestId
      }
    }
    return results
  }

  // --------------------------------------------------------------------------
  // Read operations
  // --------------------------------------------------------------------------

  /**
   * Search for multiple entities.
   *
   * @param {string} entity - Entity name (e.g., 'user', 'iam/user')
   * @param {Object} args - Query arguments ({ _where, _limit, _offset, _order_by, _distinct, ...fieldConditions })
   * @param {Object} selection - Attributes and relations to return
   * @returns {Promise<Array>} Array of entity records
   *
   * @example
   * ```js
   * const users = await client.search('User', {
   *   active: eq(true),
   *   _limit: 10
   * }, {
   *   name: null,
   *   email: null,
   *   roles: rel({ name: null })
   * })
   * ```
   */
  async search(entity, args, selection, opts) {
    const [result] = await this.exec([
      { op: 'search', entity, args, selections: normalizeSelection(selection) },
    ], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data ?? []
  }

  /**
   * Run an XSQL query — selection-DSL string with optional `?name:type[]`
   * placeholders. The wire envelope carries the XSQL source in
   * `selections` and a typed `params` map; the server compiles XSQL to
   * the wire AST and binds placeholder values via JDBC.
   *
   * `op` defaults to `"search"`. Pass `{ op: "get" }` for unique-key
   * identity reads; the XSQL `xid = ?xid:string` form lifts cleanly.
   * Other read-shape ops (`slice`, `purge`) work too.
   *
   * @param {string} xsql - XSQL source string
   * @param {Object} [params] - `{name: value}` map for `?name:type[]` refs
   * @param {Object} [opts] - Options
   * @param {'search'|'get'|'slice'|'purge'} [opts.op='search'] - Document
   *        verb for bare-body sources (and the unwrap: `get` → one record)
   * @param {string} [opts.actingAs] - Per-call impersonation
   * @param {'kebab'|'snake'|'camel'} [opts.keyFormat] - Response key case
   * @returns {Promise<Array>} Query result rows
   *
   * @example
   * ```js
   * const users = await client.query(`
   *   user (active = ?a:boolean, _limit ?n:int)
   *
   *   name
   *   email
   *   -roles
   *     name
   * `, { a: true, n: 50 })
   * ```
   *
   * @example
   * ```js
   * // get by unique key
   * const user = await client.query(`
   *   xid = ?xid:string
   *   name
   *   active
   * `, { xid }, { op: 'get' })
   * ```
   */
  async query(xsql, params, opts) {
    // STRICT wire: XSQL travels only as the `xsql` DOCUMENT op — the
    // document carries verb/entity/selections/args. Bare rooted bodies get
    // a synthetic `@<op> _q` header client-side.
    const verb = opts?.op ?? 'search'
    const op = { op: 'xsql', xsql: xsqlDocument(xsql, verb) }
    if (params !== undefined) op.params = params
    const [result] = await this.exec([op], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    // `get` returns a single record or null; everything else returns an array.
    return (verb === 'get') ? result.data : (result.data ?? [])
  }

  /**
   * Get a single entity by ID or filter.
   *
   * @param {string} entity - Entity name
   * @param {Object} args - Query arguments (must match exactly one record)
   * @param {Object} selection - Attributes and relations to return
   * @param {Object} [opts] - Options ({ actingAs })
   * @returns {Promise<Object|null>} Entity record or null
   */
  async get(entity, args, selection, opts) {
    // get takes flat unique constraint values — NO implicit _eq normalization
    const [result] = await this.exec([
      { op: 'get', entity, args, selections: normalizeSelection(selection) },
    ], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data
  }

  /**
   * Execute a SQL template with ERD-aware placeholders. Auto-generates
   * FROM and JOINs from {entity.field} / {entity->rel.field} references;
   * supports junction, self-FK (tree) and field-ref relation traversal.
   *
   * @param {string} template - SQL with {entity.field} and {entity->rel} placeholders
   * @param {Array} [params] - Query parameters for ? placeholders
   * @param {Object} [opts] - Options ({ actingAs })
   * @returns {Promise<Array>} Query results
   *
   * @example
   * ```js
   * const report = await client.sqlTemplate(
   *   'SELECT {user.name}, COUNT({user->roles}._eid) as role_count FROM {user} WHERE {user.active} = ? GROUP BY {user.name}',
   *   [true]
   * )
   * ```
   */
  async sqlTemplate(template, params, opts) {
    const op = { op: 'sql-template', template, params: params || [] }
    const [result] = await this.exec([op], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data ?? []
  }

  /**
   * Search for entities matching `args`, walk `on` UP to their ancestors,
   * then compose the flat result into a forest (one tree per independent root).
   *
   * The `on` relation must be included in `selection` so the composer can
   * link children to parents: `{ name: null, parent: { xid: null } }`
   *
   * @param {string} entity - Entity name
   * @param {string} on - Name of the tree (self-FK) relation to walk
   * @param {Object} args - Filter conditions
   * @param {Object} selection - Attributes/relations to return (include `on` relation)
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.raw] - Return flat array instead of composing into a forest
   * @param {string} [opts.childrenKey='_children'] - Key for nested children
   * @param {string} [opts.actingAs] - User to act as
   * @returns {Promise<Array>} Forest of composed trees (or flat array if raw: true)
   */
  async searchTree(entity, on, args, selection, opts) {
    const [result] = await this.exec([
      { op: 'search-tree', entity, on, args, selections: normalizeSelection(selection) },
    ], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    const flat = result.data ?? []
    if (opts?.raw) return flat
    return composeForest(flat, { on, childrenKey: opts?.childrenKey ?? '_children' })
  }

  /**
   * Return the root + all descendants reachable via the tree relation `on`,
   * composed into a single nested tree.
   *
   * The `on` relation must be included in `selection` so the composer can
   * link children to parents: `{ name: null, parent: { xid: null } }`
   *
   * @param {string} entity - Entity name
   * @param {string} root - Root entity id (xid/euuid)
   * @param {string} on - Name of the tree (self-FK) relation to walk
   * @param {Object} selection - Attributes/relations to return (include `on` relation)
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.raw] - Return flat array instead of composing into a tree
   * @param {string} [opts.childrenKey='_children'] - Key for nested children
   * @param {string} [opts.actingAs] - User to act as
   * @returns {Promise<Object|null>} Composed tree rooted at `root`, or null if not found (or flat array if raw: true)
   */
  async getTree(entity, root, on, selection, opts) {
    const [result] = await this.exec([
      { op: 'get-tree', entity, root, on, selections: normalizeSelection(selection) },
    ], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    const flat = result.data ?? []
    if (opts?.raw) return flat
    return composeTree(flat, { on, rootId: root, childrenKey: opts?.childrenKey ?? '_children' })
  }

  // --------------------------------------------------------------------------
  // Write operations
  // --------------------------------------------------------------------------

  /**
   * Sync (upsert) an entity. Replaces the full state including relations.
   *
   * Writes are silent by default — the server answers `{ count }`. Pass
   * `returning: true` for the written records, or mint ids up front with
   * `newXid()`, which is the cheap way to know what you wrote.
   *
   * @param {string} entity - Entity name
   * @param {Object} data - Entity data
   * @param {Object} [opts] - Options ({ actingAs, returning })
   * @returns {Promise<Object>} `{ count }`, or the synced entity when returning
   */
  async sync(entity, data, opts) {
    const [result] = await this.exec(
      [{ op: 'sync', entity, data, returning: opts?.returning === true }], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data
  }

  /**
   * Stack (additive upsert) an entity. Adds relations without removing existing.
   * Same `returning` contract as sync.
   *
   * @param {string} entity - Entity name
   * @param {Object} data - Entity data
   * @param {Object} [opts] - Options ({ actingAs, returning })
   * @returns {Promise<Object>} `{ count }`, or the stacked entity when returning
   */
  async stack(entity, data, opts) {
    const [result] = await this.exec(
      [{ op: 'stack', entity, data, returning: opts?.returning === true }], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data
  }

  /**
   * Slice (remove) specific relations from an entity.
   *
   * @param {string} entity - Entity name
   * @param {Object} args - Filter to identify the entity (e.g. { xid: '...' })
   * @param {Object} [selection] - Which relations to slice (omit = all)
   * @param {Object} [opts] - Options ({ actingAs })
   * @returns {Promise<Record<string, boolean>>} Map of relation-name → success
   */
  async slice(entity, args, selection, opts) {
    const [result] = await this.exec([
      { op: 'slice', entity, args, selections: normalizeSelection(selection) },
    ], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data
  }

  /**
   * Soft delete an entity.
   *
   * @param {string} entity - Entity name
   * @param {Object} data - Entity identifier
   * @param {Object} [opts] - Options ({ actingAs })
   * @returns {Promise<boolean>} true on success
   */
  async delete(entity, data, opts) {
    const [result] = await this.exec([{ op: 'delete', entity, data }], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data
  }

  /**
   * Hard delete (purge) entities matching arguments.
   *
   * @param {string} entity - Entity name
   * @param {Object} args - Filter for records to purge
   * @param {Object} [selection] - Fields to return for each purged record
   * @param {Object} [opts] - Options ({ actingAs })
   * @returns {Promise<Object>} Purged records
   */
  async purge(entity, args, selection, opts) {
    const [result] = await this.exec([
      { op: 'purge', entity, args, selections: normalizeSelection(selection) },
    ], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data
  }

  // --------------------------------------------------------------------------
  // Subscriptions — records-only set-replace contract (POST /data/subscription/set)
  //
  // The wire is records-only: every data item carries
  // a `records: [xid, ...]` set. Record events fan out when record-xid is
  // in the set; relation events fan out when either endpoint of a link
  // is in the set (server rotates the wire so `data[0]` is always the
  // subscribed perspective). No entity field. No firehose.
  //
  // SDK pattern: caller passes a descriptor (`{records, operations?}` or
  // a bare array of xids); SDK keys it by an explicit `key` option or a
  // stable hash of the descriptor. Local mirror persists across calls so
  // multiple parallel `observe()` flows can coexist on one client.
  // --------------------------------------------------------------------------

  /**
   * Compose the wire `subscriptions` array from local state.
   * @private
   */
  _buildSubscriptionsBody() {
    const items = []
    for (const descriptor of this._dataSubs.values()) {
      const item = { type: 'data', records: [...descriptor.records].sort() }
      if (descriptor.operations) item.operations = [...descriptor.operations].sort()
      items.push(item)
    }
    if (this._entitySubs.size) {
      items.push({ type: 'entity', entities: [...this._entitySubs].sort() })
    }
    if (this._relationSubs.size) {
      items.push({ type: 'relation', relations: [...this._relationSubs].sort() })
    }
    for (const t of this._modelSubs) items.push({ type: t })
    return { subscriptions: items }
  }

  /**
   * POST the current local subscription state to the server.
   * @private
   */
  async _flushSubscriptions() {
    const body = this._buildSubscriptionsBody()
    if (typeof process !== 'undefined' && process.env?.SDK_DEBUG) {
      const summary = (body.subscriptions ?? []).map((s) => ({
        type: s.type,
        records: s.records?.length,
        operations: s.operations,
        entities: s.entities,
        relations: s.relations,
      }))
      console.log('[sdk-sub] POST /data/subscription/set', summary)
    }
    const resp = await this._fetchAuth(`${this._endpoint}/data/subscription/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      throw new SynthigyError(
        data.error?.message || 'Subscription set failed',
        data.error?.code || 'HTTP_ERROR'
      )
    }
    return resp.json()
  }

  /**
   * Subscribe to data change notifications for a set of record xids.
   * Adds the descriptor to the local subscription set and POSTs the
   * full set to the server.
   *
   * The descriptor can be:
   *   - an array of xids (shorthand): `client.subscribe(['xid-a', 'xid-b'])`
   *   - an object: `{ records: ['xid-a'], operations: ['update'] }`
   *
   * Pass `opts.key` to give the subscription a stable handle for later
   * `unsubscribe(key)`. Without an explicit key, the descriptor's
   * stable hash is used — re-subscribing with the same records+operations
   * is idempotent.
   *
   * Legacy entity-firehose form (`client.subscribe('User')`) is rejected
   * at the SDK with a clear migration error — the wire supports only
   * the records-only form.
   *
   * @param {string[]|{records: string[], operations?: string[]}} descriptor
   * @param {Object} [opts]
   * @param {string} [opts.key] - Stable handle for unsubscribe
   * @returns {Promise<{ok:boolean}>}
   */
  async subscribe(descriptor, opts) {
    const normalized = _normalizeDescriptor(descriptor)
    const key = opts?.key ?? _descriptorKey(normalized)
    this._dataSubs.set(key, normalized)
    return this._flushSubscriptions()
  }

  /**
   * Unsubscribe from data change notifications. `handle` is either the
   * key passed at subscribe-time or a descriptor equal-by-hash to the
   * original (e.g. the same array of xids).
   *
   * @param {string|string[]|{records: string[], operations?: string[]}} handle
   * @returns {Promise<{ok:boolean}>}
   */
  async unsubscribe(handle) {
    let key
    if (typeof handle === 'string' && !Array.isArray(handle)) {
      // String handle — treat as the key first; if no match, the caller
      // may have passed a single xid (degenerate case) — try that too.
      if (this._dataSubs.has(handle)) {
        key = handle
      } else {
        const fallback = _descriptorKey({ records: new Set([handle]) })
        if (this._dataSubs.has(fallback)) key = fallback
      }
    } else {
      const normalized = _normalizeDescriptor(handle)
      key = _descriptorKey(normalized)
    }
    if (key == null || !this._dataSubs.delete(key)) return { ok: true }
    return this._flushSubscriptions()
  }

  /**
   * Subscribe to model deploy notifications. Two variants:
   *   - runtime-model (default): augmented IAM-projected model, what the
   *     data console renders against.
   *   - deployed-model: raw deployed model (modeler).
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.raw=false] - Subscribe to raw deployed-model
   *        instead of runtime-model.
   * @returns {Promise<{ok:boolean}>}
   */
  async subscribeModel(opts) {
    const t = opts?.raw ? 'deployed-model' : 'runtime-model'
    this._modelSubs.add(t)
    return this._flushSubscriptions()
  }

  /**
   * Unsubscribe from model deploy notifications.
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.raw=false] - Unsubscribe from raw deployed-model
   *        instead of runtime-model.
   * @returns {Promise<{ok:boolean}>}
   */
  async unsubscribeModel(opts) {
    const t = opts?.raw ? 'deployed-model' : 'runtime-model'
    if (!this._modelSubs.delete(t)) return { ok: true }
    return this._flushSubscriptions()
  }

  /**
   * Replace the entire subscription set in one call — full-set semantics
   * matching the wire contract. Each `data` item must carry a
   * non-empty `records` array of xid strings. Existing local state is
   * replaced.
   *
   * Items optionally carry a `key` field — used as the local-mirror
   * handle for subsequent `unsubscribe(key)` calls. Without one, a
   * stable hash of the descriptor is used.
   *
   * @param {Array<Object>} items - Subscription items
   * @returns {Promise<{ok:boolean}>}
   *
   * @example
   * ```js
   * await client.setSubscriptions([
   *   { type: 'data', records: ['u-abc', 'u-def'], operations: ['update'] },
   *   { type: 'data', records: ['r-1'] },
   *   { type: 'runtime-model' },
   * ])
   * ```
   */
  async setSubscriptions(items) {
    this._dataSubs.clear()
    this._modelSubs.clear()
    this._entitySubs.clear()
    this._relationSubs.clear()
    for (const item of items) {
      const t = item.type ?? 'data'
      if (t === 'data') {
        const normalized = _normalizeDescriptor({
          records: item.records,
          ...(item.operations !== undefined ? { operations: item.operations } : {}),
        })
        const key = item.key ?? _descriptorKey(normalized)
        this._dataSubs.set(key, normalized)
      } else if (t === 'entity') {
        if (!Array.isArray(item.entities)) {
          throw new SynthigyError(`entity subscription requires entities array`, 'INVALID_SUBSCRIPTION')
        }
        for (const e of item.entities) this._entitySubs.add(e)
      } else if (t === 'relation') {
        if (!Array.isArray(item.relations)) {
          throw new SynthigyError(`relation subscription requires relations array`, 'INVALID_SUBSCRIPTION')
        }
        for (const r of item.relations) this._relationSubs.add(r)
      } else if (t === 'deployed-model' || t === 'runtime-model') {
        this._modelSubs.add(t)
      } else {
        throw new SynthigyError(`Unsupported subscription type: ${t}`, 'UNSUPPORTED_TYPE')
      }
    }
    return this._flushSubscriptions()
  }

  /**
   * Clear all subscriptions for this session.
   *
   * @returns {Promise<{ok:boolean}>}
   */
  async clearSubscriptions() {
    this._dataSubs.clear()
    this._modelSubs.clear()
    this._entitySubs.clear()
    this._relationSubs.clear()
    return this._flushSubscriptions()
  }

  /**
   * Get current subscription status from the server.
   *
   * @returns {Promise<{ subscriptions: Array<Object> }>}
   */
  async subscriptions() {
    const resp = await this._fetchAuth(`${this._endpoint}/data/subscription/status`)
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      throw new SynthigyError(
        data.error?.message || 'Subscription status failed',
        data.error?.code || 'HTTP_ERROR'
      )
    }
    return resp.json()
  }

  // --------------------------------------------------------------------------
  // watch() — live data primitive (multiplexed, schema-resolved)
  //
  // One SSE per client; many `watch()` calls fuse onto the same connection
  // and the same consolidated `setSubscriptions` POST. Each Watch yields a
  // typed, attribute-name-keyed event stream. See watch.js for the design.
  // --------------------------------------------------------------------------

  /**
   * Open a live subscription on a set of records (and/or relations).
   *
   * @param {{records?: string[], relations?: string[],
   *          ops?: Array<'insert'|'update'|'delete'|'link'|'unlink'>}} interest
   * @param {{backpressure?: 'coalesce'|'lossless'|'sliding',
   *          bufferSize?: number,
   *          signal?: AbortSignal}} [opts]
   * @returns {Watch}
   */
  watch(interest, opts) {
    return _watch(this, interest, opts)
  }

  /**
   * Open a separate stream of schema-deploy events.
   * @returns {SchemaWatch}
   */
  watchSchema() {
    return _watchSchema(this)
  }

  /**
   * Live result-set for a query. Builds on `watch()`:
   *   - snapshots via search
   *   - watches the result xids + entity's relations
   *   - on any event, coalesced re-run + diff against last result
   *   - emits {query/added, query/changed, query/removed}
   *
   * `watchQuery.xsql(xsql, params, { entity, ... })` — XSQL variant.
   *
   * @returns {QueryWatch}
   */
  get watchQuery() {
    if (!this._watchQueryFn) {
      const self = this
      const fn = (entity, args, selection, opts) =>
        _watchQuery(self, entity, args, selection, opts)
      fn.xsql = (xsql, params, opts) =>
        _watchQuery.xsql(self, xsql, params, opts)
      this._watchQueryFn = fn
    }
    return this._watchQueryFn
  }

  /**
   * Live raw-SQL result. Composes `sqlTemplate()` snapshot with
   * `watch()` subscription on the named entities' relation xids.
   *
   * Required: `opts.entities` — list of entity names the SQL reads
   * from. The SDK subscribes to those entities' relation xids so the
   * SQL re-runs when records of those entities are linked/unlinked.
   * For per-row updates on existing rows to trigger refresh, also
   * pass `opts.records: [...]` explicitly.
   *
   * @example
   * ```js
   * const w = client.watchSqlTemplate(
   *   "SELECT count(*) AS n FROM {user_rating}", {},
   *   { entities: ['user_rating'] })
   * await w.ready()
   * w.first.n             // → 100981
   * for await (const ev of w.events) {
   *   if (ev.type === 'result/changed') console.log(ev.after[0].n)
   * }
   * ```
   *
   * @param {string} template - SQL with ?name:type placeholders
   * @param {Object|Array} [params] - named or positional params
   * @param {Object} [opts]
   * @param {string[]} opts.entities - entity names the SQL reads from (REQUIRED)
   * @param {string[]} [opts.records] - extra record xids to watch (for update refresh)
   * @param {Object} [opts.searchOpts] - forwarded to sqlTemplate (actingAs, etc.)
   * @returns {SqlTemplateWatch}
   */
  watchSqlTemplate(template, params, opts) {
    return _watchSqlTemplate(this, template, params, opts)
  }

  // --------------------------------------------------------------------------
  // Schema introspection
  // --------------------------------------------------------------------------

  /**
   * Fetch the IAM-filtered model schema via `GET /schema`.
   *
   * @param {string[]} [entities] - Optional kebab-case entity names to include. Omit for full schema.
   * @returns {Promise<Object>} `{ 'id-key', entities }` — entity name → `{ name, attributes, relations, constraints }`
   *
   * @example
   * ```js
   * const schema = await client.schema()
   * // schema['id-key'] → 'xid'
   * // schema.entities['user'].attributes → { name: 'string', active: 'boolean' }
   * // schema.entities['user'].relations['roles'] → { to: 'user-role', cardinality: 'many' }
   *
   * const partial = await client.schema(['user', 'user-role'])
   * ```
   */
  async schema(entities) {
    const url = new URL(`${this._endpoint}/schema`)
    if (entities?.length) url.searchParams.set('entities', entities.join(','))
    const resp = await this._fetchAuth(url.toString())
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      throw new SynthigyError(data.error?.message || 'Schema request failed', data.error?.code || 'HTTP_ERROR')
    }
    return resp.json()
  }

  /**
   * Lint an XSQL source string against the IAM-projected schema.
   *
   * Returns an array of diagnostics. Each diagnostic carries
   * `severity` (`"error"` typically), `message`, byte-offset `from`/`to`
   * and 1-based `start`/`end` `{line, col}` for editor integration.
   *
   * `opts.entity` (kebab-case entity name) enables schema-aware checks
   * — unknown attributes, type mismatches, etc. When omitted, only
   * syntax-level and parameter-ref diagnostics are reported.
   *
   * @param {string} source - XSQL source
   * @param {Object} [opts]
   * @param {string} [opts.entity] - Root entity (kebab-case)
   * @param {'search'|'get'|'slice'|'purge'} [opts.op='search']
   * @returns {Promise<Array<{severity: string, message: string, from: number, to: number, start: {line: number, col: number}, end: {line: number, col: number}}>>}
   *
   * @example
   * ```js
   * const diags = await client.lint(`user (active = ?a:bool)\n  name\n`,
   *                                 { entity: 'user' })
   * if (diags.length) console.error(diags)
   * ```
   */
  async lint(source, opts) {
    const body = { source }
    if (opts?.entity) body.entity = opts.entity
    if (opts?.op) body.op = opts.op
    const resp = await this._fetchAuth(`${this._endpoint}/lint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      throw new SynthigyError(
        data.error?.message || `Lint request failed (${resp.status})`,
        data.error?.code || 'HTTP_ERROR'
      )
    }
    const json = await resp.json()
    return json.diagnostics ?? []
  }

  /**
   * Mint a one-time account-claim link via `POST /oauth/onboard`.
   * Confidential client whose principal administers the account — RBAC
   * update on User plus the row inside its owner-group write scope, which
   * the shipped User Provisioner role grants — else `PROVISION_FORBIDDEN`.
   * This client's own client_credentials identity IS that principal, so no
   * separate credential is needed here.
   *
   * `xid` addresses an EXISTING account — onboarding no longer creates
   * accounts; create it first via `sync('iam/user', ...)` (with person_info,
   * roles, groups in one tree), then mint a ticket for it. A blank xid fails
   * with `XID_REQUIRED`; one that doesn't resolve fails with
   * `USER_NOT_FOUND`. `opts.reset` soft-recycles the account first (strips
   * its federated identities, nulls its password, revokes its live
   * sessions/tokens — leaves `active` untouched) before minting.
   * `opts.methods` restricts which claim methods the page offers (e.g.
   * `['password']`); omitted allows every active federation provider plus
   * password.
   *
   * @param {string} xid
   * @param {Object} [opts]
   * @param {boolean} [opts.reset]
   * @param {string[]} [opts.methods]
   * @param {number} [opts.ttlSeconds]
   * @param {string} [opts.returnUrl] Where a successful DIRECT (browser) claim
   *   redirects instead of Synthigy's generic status page. Must match one of
   *   THIS client's registered redirections (or be a loopback URI).
   * @returns {Promise<{onboard_url: string, expires_at: number, user: {xid: string}}>}
   *
   * @example
   * ```js
   * const { xid } = await client.sync('iam/user', { name: 'alice@example.com', active: false })
   * const { onboard_url } = await client.onboard(xid, { methods: ['password'] })
   * // email onboard_url to alice yourself — the SDK doesn't send it
   * ```
   */
  async onboard(xid, opts) {
    const body = { xid }
    if (opts?.reset !== undefined) body.reset = opts.reset
    if (opts?.methods) body.methods = opts.methods
    if (opts?.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds
    if (opts?.returnUrl !== undefined) body.return_url = opts.returnUrl
    const resp = await this._fetchAuth(`${this._endpoint}/oauth/onboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      throw await onboardError(resp)
    }
    return resp.json()
  }

  /**
   * Redeem an onboarding ticket without a browser via
   * `POST /oauth/onboard/complete` — the indirect face of the SAME ticket
   * `onboard()` mints. Must be called by the SAME client that minted the
   * ticket; any other client's bearer is rejected with `CLAIM_INVALID`, and
   * the client must still administer the account (`PROVISION_FORBIDDEN`).
   *
   * The caller runs its own out-of-band proofing (email link, SMS OTP, push
   * approval, KYC, a phone call — Synthigy never learns which) and, once
   * satisfied, redeems the ticket itself instead of bouncing the user's
   * browser through `/oauth/claim`. This never sets a credential —
   * credentials are subject-only. The account activates with none; give it
   * one via the claim page (password or a federated identity) or a later
   * ticket.
   *
   * @param {string} ticket
   * @returns {Promise<{user: {xid: string}, active: boolean}>}
   */
  async onboardComplete(ticket) {
    const resp = await this._fetchAuth(`${this._endpoint}/oauth/onboard/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })
    if (!resp.ok) {
      throw await onboardError(resp)
    }
    return resp.json()
  }

  /**
   * Fetch the raw deployed ERD model — the modeler-authored shape,
   * without system attrs (xid/euuid/audit) or reference-as-relation
   * expansion. This is what the modeler/canvas reads. Most SDK
   * consumers want `runtimeModel()` instead.
   *
   * Requires `dataset:load` scope.
   *
   * Server returns this as a transit-encoded JSON string.
   *
   * @param {Object} [opts] - Options ({ actingAs })
   * @returns {Promise<Object|string>} Full ERD model
   */
  async deployedModel(opts) {
    const [result] = await this.exec([{ op: 'deployed-model' }], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data
  }

  /**
   * Fetch the runtime ERD model — the deployed model augmented with:
   *   - `xid` / `euuid` identity attrs on every entity
   *   - audit attrs (created-on / modified-on / created-by / modified-by)
   *     based on each entity's audit configuration
   *   - reference-typed attrs surfaced as first-class relations
   *
   * This is what the data console reads, and what the SDK's watch
   * resolver uses to map attr-xid → name for plug events. Use
   * this rather than `deployedModel()` if you want to see what the
   * running system actually emits (including audit timestamps).
   *
   * Requires `dataset:load` scope.
   *
   * Server returns this as a transit-encoded JSON string.
   *
   * @param {Object} [opts] - Options ({ actingAs })
   * @returns {Promise<Object|string>} Runtime ERD model
   */
  async runtimeModel(opts) {
    const [result] = await this.exec([{ op: 'runtime-model' }], opts)
    if (!result.ok) throw _errorFromServer(result.error, undefined, result._requestId)
    return result.data
  }

  // --------------------------------------------------------------------------
  // History — temporal query surface (POST /history)
  //
  // Five ops over the audit plug: get-at, events, diff, timeline,
  // since. Endpoint returns 404 when no audit provider is loaded in
  // the deployment.
  // --------------------------------------------------------------------------

  /** @private */
  async _historyPost(op, opts) {
    const resp = await this._fetchAuth(`${this._endpoint}/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, opts }),
    })
    if (resp.status === 404) {
      throw new SynthigyError(
        'History endpoint unavailable — no audit provider configured on the server',
        'HISTORY_UNAVAILABLE'
      )
    }
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      throw new SynthigyError(
        data.error?.message || `History op '${op}' failed (${resp.status})`,
        data.error?.code || 'HTTP_ERROR'
      )
    }
    const body = await resp.json()
    return body.result
  }

  // Defined as a regular property so the .d.ts namespace `client.history.foo`
  // shape works at edit time.
  get history() {
    if (!this._history) {
      const self = this
      this._history = {
        /**
         * State of a record at timestamp T as an attribute map.
         */
        async getAt(recordXid, at, opts) {
          return self._historyPost('get-at', {
            'record-xid': recordXid,
            at,
            ...(opts?.tenant !== undefined && { tenant: opts.tenant }),
            ...(opts?.includeDeleted !== undefined && {
              'include-deleted?': opts.includeDeleted,
            }),
          })
        },

        /**
         * Events for a record (or any record) over a time range.
         *
         * The server requires an upper time bound; when `between` is omitted
         * we default it to `[null, now]` so `events()` means "recent events up
         * to now" (the server still defaults the lower bound to now − 30d).
         */
        async events(opts) {
          return self._historyPost('events', {
            ...(opts?.recordXid !== undefined && { 'record-xid': opts.recordXid }),
            between: opts?.between ?? [null, new Date().toISOString()],
            ...(opts?.tenant !== undefined && { tenant: opts.tenant }),
            ...(opts?.limit !== undefined && { limit: opts.limit }),
            ...(opts?.track !== undefined && { track: opts.track }),
          })
        },

        /**
         * Diff a record's state between two timestamps.
         */
        async diff(recordXid, fromTs, toTs, opts) {
          return self._historyPost('diff', {
            'record-xid': recordXid,
            'from-ts': fromTs,
            'to-ts': toTs,
            ...(opts?.tenant !== undefined && { tenant: opts.tenant }),
          })
        },

        /**
         * Events grouped by :request, :actor, or :scope.
         *
         * Defaults the upper time bound to "now" when `between` is omitted
         * (same contract as `events`).
         */
        async timeline(opts) {
          return self._historyPost('timeline', {
            between: opts?.between ?? [null, new Date().toISOString()],
            ...(opts?.groupBy !== undefined && { 'group-by': opts.groupBy }),
            ...(opts?.tenant !== undefined && { tenant: opts.tenant }),
            ...(opts?.limit !== undefined && { limit: opts.limit }),
          })
        },

        /**
         * Events strictly after cursor timestamp T, oldest-first.
         */
        async since(opts) {
          return self._historyPost('since', {
            ...(opts?.cursor !== undefined && { cursor: opts.cursor }),
            ...(opts?.tenant !== undefined && { tenant: opts.tenant }),
            ...(opts?.limit !== undefined && { limit: opts.limit }),
            ...(opts?.track !== undefined && { track: opts.track }),
          })
        },
      }
    }
    return this._history
  }

  // --------------------------------------------------------------------------
  // Subscriptions — SSE listener
  // --------------------------------------------------------------------------

  /**
   * Open an SSE connection to `/data/events` and yield change notifications.
   *
   * Events are notification-only (no data payload). Fetch the updated records
   * via `exec`/`search`/`get` after receiving a notification.
   *
   * Yields objects: `{ type: 'change'|'delete', entity, relations?, xids? }`
   *
   * The async generator runs until the connection drops or the caller breaks.
   * Subscriptions persist across reconnects — call `subscribe()` once at
   * startup; the server remembers which entities this client watches.
   *
   * @param {Object} [opts]
   * @param {AbortSignal} [opts.signal] - Cancel the listener
   * @yields {{ type: string, entity: string, relations?: string[], xids?: string[] }}
   *
   * @example
   * ```js
   * await client.subscribe('User')
   * for await (const event of client.listen()) {
   *   const users = await client.search('User', {}, { name: null })
   *   render(users)
   * }
   * ```
   */
  /**
   * One SSE session against `/data/events`. Yields parsed event frames
   * as `{ _sseEvent, _sseId, ...payload }` — the payload is the SSE
   * `data:` line parsed as JSON, plus metadata fields with `_sse`
   * prefix so they can't collide with payload keys. Caller handles
   * reconnect (listen() runs an infinite reconnect loop around this;
   * observe() also re-subscribes between sessions because the server
   * tears down subscription state on SSE close).
   * @private
   */
  async *_sseSession(opts) {
    const signal = opts?.signal
    const headers = { Accept: 'text/event-stream' }
    if (opts?.lastEventId) headers['Last-Event-ID'] = opts.lastEventId

    const resp = await this._fetchAuth(
      `${this._endpoint}/data/events`,
      { headers, signal },
      { applyTimeout: false }
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new SynthigyError(`SSE connect failed (${resp.status})`, 'HTTP_ERROR', text)
    }
    if (!resp.body) throw new SynthigyError('SSE response has no body', 'HTTP_ERROR')

    // Headers received = server has created the event stream session.
    // Emit a synthetic 'open' sentinel so callers can POST /subscription/set
    // here (and only here) — POSTing before this point races the
    // server's stream creation and silently drops subscriptions.
    yield { _sseEvent: 'open' }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let eventType = 'message'
    let dataLines = []
    let eventId = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim())
          } else if (line.startsWith('id:')) {
            eventId = line.slice(3).trim()
          } else if (line === '') {
            if (dataLines.length > 0) {
              try {
                const payload = JSON.parse(dataLines.join('\n'))
                // Underscore-prefixed metadata so it can't collide with
                // payload keys (the Option-B channel envelope has its
                // own `type` field).
                yield { _sseEvent: eventType, _sseId: eventId, ...payload }
              } catch { /* ignore malformed frames */ }
            }
            eventType = 'message'
            dataLines = []
            eventId = null
          }
        }
      }
    } finally {
      // `reader.cancel()` returns a promise that REJECTS when the stream was
      // aborted (the common teardown path). `try/catch` only traps a sync
      // throw, so the rejected promise would dangle as an unhandled rejection.
      // Attach a no-op `.catch` to swallow it — an aborted SSE is a clean stop.
      try { reader.cancel().catch(() => {}) } catch { /* ignore */ }
    }
  }

  async *listen(opts) {
    const signal = opts?.signal
    let delay = 1000
    let lastEventId = null

    while (!signal?.aborted) {
      try {
        for await (const event of this._sseSession({ signal, lastEventId })) {
          if (event._sseId) lastEventId = event._sseId
          delay = 1000
          // Surface the synthetic 'open' sentinel as `{ type: 'sse/open' }`
          // so the multiplexer can POST /subscription/set only after the
          // server has created the event stream (otherwise the POST races
          // stream creation and the subscription is silently lost).
          if (event._sseEvent === 'open') {
            yield { type: 'sse/open' }
            continue
          }
          // Strip internal SSE metadata before handing the payload to
          // callers. listen() exposes the channel-shaped event verbatim
          // — for Option B that means the full delta envelope.
          const { _sseEvent, _sseId, ...payload } = event
          yield payload
        }
      } catch (e) {
        if (signal?.aborted || e?.name === 'AbortError') return
        if (e?.code === 'UNAUTHORIZED' || e?.code === 'FORBIDDEN') throw e
        await new Promise(r => setTimeout(r, delay))
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  // --------------------------------------------------------------------------
  // observe(descriptor) — one-call live primitive
  //
  // Bundles subscribe + SSE + auto-reconnect + (opt-in) history backfill into
  // a single async iterable. The server tears down subscription state on
  // SSE close, so observe() re-subscribes before each new SSE session.
  // --------------------------------------------------------------------------

  /**
   * Subscribe to a record-set and yield change events as an async iterable.
   *
   * The descriptor identifies which records to watch — either a bare
   * array of xids or `{records, operations?}`. Record events fire when
   * an envelope's `record-xid` is in the set; relation events fire when
   * either endpoint of a relation link/unlink is in the set (server
   * rotates the wire so `data[0]` is always the subscribed endpoint).
   *
   * Each event is the record-shaped envelope: record
   * events carry `before` / `after` attribute maps (already keyed by
   * attribute key, not attribute-xid); relation events carry a `data`
   * tuple `[subscribed-xid, other-xid]`. Both carry `actor` / `txid` /
   * `request` / `scope` / `tenant` provenance as xids — resolve on
   * demand if you need names.
   *
   * On each SSE session this:
   *   1. POSTs `/data/subscription/set` with this descriptor (set-replace).
   *   2. Opens a single SSE session via `/data/events`.
   *   3. Yields events whose record-xid OR data[0] is in the set.
   *   4. On disconnect: optionally backfills missed events from
   *      `/history events`, then re-subscribes and reconnects.
   *
   * Cleanup on iterator close: unsubscribes this descriptor.
   *
   * @param {string[]|{records: string[], operations?: string[]}} descriptor
   * @param {Object} [opts]
   * @param {string} [opts.key] - Stable subscription handle; defaults to
   *        a hash of the descriptor.
   * @param {AbortSignal} [opts.signal] - Cancel the loop
   * @param {boolean} [opts.backfill=false] - Replay /history events
   *        missed during disconnect.
   * @param {number} [opts.backfillLimit=1000] - Max history rows per
   *        backfill pass.
   * @yields {ObserveEvent} — see ObserveEvent in index.d.ts for the
   *        discriminated-union shape.
   *
   * @example
   * ```js
   * for await (const ev of client.observe(['u-abc'])) {
   *   if (ev.type === 'record/update') diffRender(ev.before, ev.after)
   * }
   *
   * for await (const ev of client.observe({
   *   records: [userXid, teamXid],
   *   operations: ['update', 'link'],
   * })) { ... }
   * ```
   */
  async *observe(descriptor, opts) {
    const normalized = _normalizeDescriptor(descriptor)
    const key = opts?.key ?? _descriptorKey(normalized)
    const signal = opts?.signal
    const backfillEnabled = opts?.backfill === true
    const backfillLimit = opts?.backfillLimit ?? 1000
    let lastSeenTs = null
    let delay = 1000

    try {
      while (!signal?.aborted) {
        try {
          // Server tears subscription state down on SSE close, so we
          // re-register the descriptor before each new session.
          this._dataSubs.set(key, normalized)
          await this._flushSubscriptions()

          for await (const raw of this._sseSession({ signal })) {
            // `raw` is the channel payload plus _sseEvent / _sseId
            // metadata. Strip the metadata; emit the channel envelope.
            const { _sseEvent: _evt, _sseId: _id, ...payload } = raw
            // Only entity/relation channel events have a slash-typed
            // type; anything else (heartbeats, future event kinds) is
            // skipped.
            const channelType = payload.type
            if (typeof channelType !== 'string' || !channelType.includes('/')) continue
            // Defense-in-depth filter: plug already gates by records;
            // double-check here so multiple parallel observe()s on one
            // client don't cross-deliver.
            if (!_eventMatchesDescriptor(payload, normalized)) continue
            if (payload.ts) lastSeenTs = payload.ts
            delay = 1000
            yield payload
          }
        } catch (e) {
          if (signal?.aborted || e?.name === 'AbortError') return
          if (e?.code === 'UNAUTHORIZED' || e?.code === 'FORBIDDEN') throw e
        }

        if (signal?.aborted) return

        if (backfillEnabled && lastSeenTs) {
          try {
            const now = new Date().toISOString()
            const events = await this.history.events({
              between: [lastSeenTs, now],
              track: 'entity',
              limit: backfillLimit,
            })
            // /history events are attribute-primary (one row per changed
            // attribute). Fold into one observe event per (record, op)
            // and reconstruct a partial `after` map from the rows. The
            // shape is best-effort: not as rich as live, but a faithful
            // diff for the rows that landed in __audit_entity.
            const byKey = new Map()  // `${recordXid}::${op}` → folded event
            for (const ev of events) {
              const xid = ev.recordXid ?? ev['record-xid']
              if (!xid) continue
              // Skip backfill rows for records outside our watch set.
              if (!normalized.records.has(xid)) continue
              const op = ev.op
              const foldKey = `${xid}::${op}`
              const channelType = `record/${op === 'change' ? 'update' : op}`
              let folded = byKey.get(foldKey)
              if (!folded) {
                folded = {
                  type: channelType,
                  ts: ev.ts,
                  'record-xid': xid,
                  txid: ev.txid,
                  actor: ev.actorXid ?? ev['actor-xid'],
                  request: ev.requestId ?? ev['request-id'],
                  scope: ev.scopeXid ?? ev['scope-xid'],
                  after: {},
                  fromBackfill: true,
                }
                byKey.set(foldKey, folded)
              }
              // Backfill rows are attribute-primary and key by attribute-xid;
              // live events come in attribute-key-keyed (server-translated).
              // We leave backfill as-is — consumer can detect via `fromBackfill`
              // and either translate or use as-is. Live events never carry
              // this flag.
              const attrXid = ev.attributeXid ?? ev['attribute-xid']
              if (attrXid && attrXid !== '__delete__') {
                folded.after[attrXid] = ev.value
              }
              if (ev.ts > (folded.ts ?? '')) folded.ts = ev.ts
            }
            for (const folded of byKey.values()) {
              if (folded.type === 'record/delete') delete folded.after
              if (folded.ts) lastSeenTs = folded.ts
              yield folded
            }
          } catch (_e) {
            // HISTORY_UNAVAILABLE / 404 / etc. — best-effort.
          }
        }

        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 30000)
      }
    } finally {
      if (this._dataSubs.delete(key)) {
        await this._flushSubscriptions().catch(() => {})
      }
    }
  }
}

/**
 * True if the channel-shaped event matches the observer's descriptor.
 * Record events match by record-xid; relation events match on `data[0]`
 * (server already rotated so position 0 is the subscribed-perspective
 * endpoint — when both endpoints sat in the identity's union the server
 * emitted two events, one per perspective, so per-observer we just check
 * position 0). Used by observe() to demultiplex when multiple observe()
 * calls share one client's SSE session.
 *
 * @private
 */
function _eventMatchesDescriptor(event, descriptor) {
  const records = descriptor.records
  if (!records || records.size === 0) return false
  const recordXid = event['record-xid']
  if (recordXid) return records.has(recordXid)
  if (Array.isArray(event.data) && event.data.length >= 2) {
    return records.has(event.data[0])
  }
  return false
}

// ============================================================================
// Client-minted identity
// ============================================================================

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * A fresh 22-char Base58 xid — client-minted identity for sync/stack, the
 * same derivation the server uses (UUID bytes → base58, left-padded with '1').
 *
 * Mint one before a write to know a record's id up front, or to make a retried
 * write idempotent — the server accepts a caller-supplied id as-is, and the
 * alternative (`returning: true`) costs the full echo on every write.
 *
 * @returns {string} 22-character Base58 xid
 */
export function newXid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // UUIDv4 bit layout, so the value round-trips the server's uuid->nanoid.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  // Schoolbook base-256 → base-58, the same conversion Bitcoin-style base58
  // libraries use.
  const digits = [0]
  for (const b of bytes) {
    let carry = b
    for (let i = 0; i < digits.length; i++) {
      const x = digits[i] * 256 + carry
      digits[i] = x % 58
      carry = Math.floor(x / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  const s = digits.reverse().map(d => BASE58[d]).join('')
  return '1'.repeat(Math.max(0, 22 - s.length)) + s
}

// ============================================================================
// Operation builders — for use with exec()
// ============================================================================

export const op = {
  search:      (entity, args, selection) => ({ op: 'search',      entity, args, selections: normalizeSelection(selection) }),
  get:         (entity, args, selection) => ({ op: 'get',         entity, args, selections: normalizeSelection(selection) }),
  sync:        (entity, data, returning) => ({ op: 'sync',        entity, data, returning: returning === true }),
  stack:       (entity, data, returning) => ({ op: 'stack',       entity, data, returning: returning === true }),
  slice:       (entity, args, selection) => ({ op: 'slice',       entity, args, selections: normalizeSelection(selection) }),
  delete:      (entity, data)            => ({ op: 'delete',      entity, data }),
  purge:       (entity, args, selection) => ({ op: 'purge',       entity, args, selections: normalizeSelection(selection) }),
  searchTree:  (entity, on, args, sel)   => ({ op: 'search-tree', entity, on, args, selections: normalizeSelection(sel) }),
  getTree:     (entity, root, on, sel)   => ({ op: 'get-tree',    entity, root, on, selections: normalizeSelection(sel) }),
  sqlTemplate: (template, params)        => ({ op: 'sql-template', template, params: params || [] }),
  deployedModel: () => ({ op: 'deployed-model' }),
  runtimeModel: () => ({ op: 'runtime-model' }),
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a Synthigy client.
 *
 * @param {Object} config
 * @param {string} config.endpoint - Synthigy base URL
 * @param {string} [config.clientId] - OAuth client ID
 * @param {string} [config.clientSecret] - OAuth client secret
 * @param {string} [config.token] - Static bearer token (alternative to client credentials)
 * @param {string} [config.scope] - OAuth scopes
 * @returns {SynthigyClient}
 *
 * @example
 * ```js
 * // Client credentials (service-to-service)
 * const client = createClient({
 *   endpoint: 'https://synthigy.example.com',
 *   clientId: 'my-service',
 *   clientSecret: process.env.SYNTHIGY_CLIENT_SECRET,
 * })
 *
 * // Per-request user context
 * const users = await client.search('iam/user', {}, { name: null },
 *   { actingAs: req.session.userEuuid })
 *
 * // Static token (testing, scripts)
 * const client = createClient({
 *   endpoint: 'https://synthigy.example.com',
 *   token: 'my-access-token'
 * })
 * ```
 */
export function createClient(config) {
  return new SynthigyClient(config)
}

// ---------------------------------------------------------------------------
// Single-client layer — the JS analog of the Go SDK's global.go and the
// Clojure SDK's process-wide `*client*` dynvar.
//
// THE INVARIANT: one process, one client, one backend. A service connects to
// Synthigy as exactly ONE OAuth client — identity is multiplexed per-call with
// `opts.actingAs`, never a second `connect`. `connect` installs a module-wide
// default and the bare verbs below (search, sync, watch, …) operate on it, so
// callers never thread a client.
//
// The escape hatch is `createClient` itself: construct a client and call its
// methods directly (tests, a rare second endpoint) — the analog of Clojure's
// `binding *client*`.
// ---------------------------------------------------------------------------

let _defaultClient = null

/**
 * Create a client from `config` and install it as the module-wide default —
 * the server-restart idiom: any PREVIOUS default is destroyed first (its live
 * watches close, its SSE session drops) before the new one replaces it. Call
 * once at startup; call again to reconnect.
 * @param {Object} config - same shape as {@link createClient}
 * @returns {SynthigyClient} the installed client (for introspection)
 */
export function connect(config) {
  const prev = _defaultClient
  _defaultClient = new SynthigyClient(config)
  if (prev) prev.close() // destroy the old one, server-restart style
  return _defaultClient
}

/**
 * Destroy the current default client — closing every live watch and dropping
 * the SSE session — and uninstall it. No-op when not connected. `connect`
 * calls this on the previous client automatically.
 */
export function disconnect() {
  const prev = _defaultClient
  _defaultClient = null
  if (prev) prev.close()
}

/**
 * The module-wide client installed by `connect`, or null when not connected.
 * The bare verbs already operate on it; this is for introspection or handing
 * the client to code that needs an explicit instance.
 * @returns {SynthigyClient|null}
 */
export function getClient() {
  return _defaultClient
}

/** Resolve the default client or throw — using the SDK before `connect`. */
function _dflt() {
  if (!_defaultClient) {
    throw new SynthigyError('not connected — call connect() first', 'NOT_CONNECTED')
  }
  return _defaultClient
}

// CRUD + XSQL
export const search      = (...a) => _dflt().search(...a)
export const get         = (...a) => _dflt().get(...a)
export const sync        = (...a) => _dflt().sync(...a)
export const stack       = (...a) => _dflt().stack(...a)
export const slice       = (...a) => _dflt().slice(...a)
export const purge       = (...a) => _dflt().purge(...a)
export const sqlTemplate = (...a) => _dflt().sqlTemplate(...a)
export const query       = (...a) => _dflt().query(...a)
export const searchTree  = (...a) => _dflt().searchTree(...a)
export const getTree     = (...a) => _dflt().getTree(...a)
export const exec        = (...a) => _dflt().exec(...a)
// `delete` is a reserved word — no top-level binding of that name is legal, so
// it's exported under the `delete` key via aliasing. Reach it with a namespace
// import (`synthigy.delete(...)`) or `import { delete as del }`.
const _delete = (...a) => _dflt().delete(...a)
export { _delete as delete }

// Schema / introspection
export const schema        = (...a) => _dflt().schema(...a)
export const lint          = (...a) => _dflt().lint(...a)
export const onboard       = (...a) => _dflt().onboard(...a)
export const onboardComplete = (...a) => _dflt().onboardComplete(...a)
export const deployedModel = (...a) => _dflt().deployedModel(...a)
export const runtimeModel  = (...a) => _dflt().runtimeModel(...a)
export const token         = (...a) => _dflt().token(...a)
export const history       = () => _dflt().history

// Streaming + live watches
export const listen           = (...a) => _dflt().listen(...a)
export const observe          = (...a) => _dflt().observe(...a)
export const watch            = (...a) => _dflt().watch(...a)
export const watchSchema      = (...a) => _dflt().watchSchema(...a)
export const watchQuery       = (...a) => _dflt().watchQuery(...a)
export const watchSqlTemplate = (...a) => _dflt().watchSqlTemplate(...a)

// Subscriptions (advanced — prefer the watch family)
export const subscribe          = (...a) => _dflt().subscribe(...a)
export const unsubscribe        = (...a) => _dflt().unsubscribe(...a)
export const subscribeModel     = (...a) => _dflt().subscribeModel(...a)
export const unsubscribeModel   = (...a) => _dflt().unsubscribeModel(...a)
export const setSubscriptions   = (...a) => _dflt().setSubscriptions(...a)
export const clearSubscriptions = (...a) => _dflt().clearSubscriptions(...a)
export const subscriptions      = (...a) => _dflt().subscriptions(...a)
