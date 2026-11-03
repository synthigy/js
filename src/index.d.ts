/** The platform API this SDK is a client of; the default audience for every mint. */
export const PLATFORM_AUDIENCE: "https://synthigy.com"

// ============================================================================
// Selection
// ============================================================================

/** A rel() config object — use directly or in an array for multiple occurrences */
export interface RelationConfig {
  selections?: Selection
  args?: Args
  alias?: string
}

/**
 * Selection for a /data operation.
 *
 * Shorthand forms (all equivalent at nesting level):
 *   ['name', 'email']                                             — scalar field list
 *   { name: null, email: null }                                   — scalar object
 *   { roles: { name: null } }                                     — relation (auto-wrapped)
 *   { roles: rel({ name: null }, { _limit: 5 }) }                 — rel() with args
 *   { roles: [rel({ name: null }, w1, 'a'), rel({ name: null }, w2, 'b')] } — multiple
 */
export type Selection =
  | string[]
  | { [field: string]: null | true | RelationConfig | RelationConfig[] | Selection }

// ============================================================================
// Filter / Args
// ============================================================================

export type Condition =
  | { _eq: unknown }
  | { _neq: unknown }
  | { _gt: unknown }
  | { _ge: unknown }
  | { _lt: unknown }
  | { _le: unknown }
  | { _in: unknown[] }
  | { _nin: unknown[] }
  | { _like: string }
  | { _ilike: string }
  | { _is_null: boolean }

export interface WhereClause {
  _and?: WhereClause[]
  _or?: WhereClause[]
  _not?: WhereClause
  [field: string]: Condition | WhereClause | WhereClause[] | undefined
}

export interface Args {
  _where?: WhereClause
  _limit?: number
  _offset?: number
  _order_by?: Array<[string, 'asc' | 'desc']>
  _distinct?: string[]
  [field: string]: unknown
}

// ============================================================================
// Operations
// ============================================================================

export type KeyFormat = 'kebab' | 'snake' | 'camel'

export interface ExecOpts {
  actingAs?: string
  keyFormat?: KeyFormat
}

export interface WriteOpts extends ExecOpts {
  /** Echo the written records instead of the default silent `{ count }`. */
  returning?: boolean
}

export interface TreeExecOpts extends ExecOpts {
  /** Return the raw flat array instead of composing into a tree/forest. */
  raw?: boolean
  /** Key under which children are nested (default: "_children"). */
  childrenKey?: string
}

/** What `deploy()` acks with — `dataset` is the xid `destroy()` takes. */
export interface DeployAck {
  deployed: boolean
  version: string
  dataset: string
}

export type OperationResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; code: string } }

export type Operation = Record<string, unknown>

export type FetchFn = (body: object) => Promise<{ results: OperationResult[] }>

// ============================================================================
// Subscriptions — records-only
// ============================================================================

export interface SubscribeEvent {
  /**
   * The delta kind from the envelope payload: 'record/insert' | 'record/update'
   * | 'record/delete' | 'relation/link' | 'relation/unlink' |
   * 'entity/touched' | 'relation/touched' (plus the SDK's 'sse/open' sentinel).
   * NOT the SSE `event:` field — that is always the literal 'data'. This is the
   * raw envelope; the typed shape is ObserveEvent (see observe()).
   */
  type: string
  [key: string]: unknown
}

/**
 * A subscription descriptor declares the records a consumer is watching.
 * Most callers pass a bare array of xids; the object form lets you also
 * narrow by operation.
 *
 *   subscribe(['u-abc', 'u-def'])
 *   subscribe({ records: ['u-abc'], operations: ['update', 'link'] })
 */
export type Descriptor =
  | string[]
  | { records: string[]; operations?: string[] }

export interface SubscribeOpts {
  /** Stable handle for later unsubscribe(); defaults to a hash of the descriptor. */
  key?: string
}

export interface ListenOpts {
  signal?: AbortSignal
}

export interface SubscriptionInfo {
  /** Subscription type. 'data' for record-scoped events, 'deployed-model' / 'runtime-model' for model deploys. */
  type?: 'data' | 'deployed-model' | 'runtime-model'
  records?: string[]
  operations?: string[]
}

export interface SubscriptionItem {
  type?: 'data' | 'deployed-model' | 'runtime-model'
  /** Required for `type: "data"`. Non-empty array of xid strings. */
  records?: string[]
  operations?: string[]
  /** Optional stable handle for later unsubscribe(). */
  key?: string
}

// ============================================================================
// History — temporal query surface
// ============================================================================

export interface HistoryEvent {
  ts: string
  recordXid?: string
  entityXid?: string
  attributeXid?: string
  value?: unknown
  op?: 'insert' | 'update' | 'delete' | 'link' | 'unlink' | string
  actorXid?: string
  requestId?: string
  scopeXid?: string
  txid?: number | string
  // Relation events
  relationXid?: string
  fromXid?: string
  toXid?: string
}

export interface HistoryEventsOpts {
  recordXid?: string
  between?: [string, string]
  tenant?: string
  limit?: number
  /** 'entity' (default) or 'relation' */
  track?: 'entity' | 'relation'
}

export interface HistoryDiffResult<T = Record<string, unknown>> {
  before: T | null
  after: T | null
  changed: string[]
}

export interface HistoryTimelineOpts {
  between?: [string, string]
  groupBy?: 'request' | 'actor' | 'scope'
  tenant?: string
  limit?: number
}

export interface HistorySinceOpts {
  cursor?: string
  tenant?: string
  limit?: number
  track?: 'entity' | 'relation'
}

// ============================================================================
// Files — bytes behind /files, rows behind /data
// ============================================================================

/** A file as the files endpoints answer it. */
export interface FileInfo {
  xid: string
  name: string
  size: number
  /** SHA-256 of the bytes, hex; also the download ETag. */
  hash: string
  status: 'READY' | 'UPLOADED' | 'FAILED' | 'PENDING' | string | null
  content_type: string | null
  uploaded_at: string | null
  /** Who uploaded the current version. */
  uploaded_by: { xid: string; name: string | null } | null
  folder: { xid: string; name?: string; path?: string } | null
  /** Loads without a token: its folder, or a folder above it, is Public. */
  public: boolean
}

export interface FileVersion {
  /** Pass to `download({ version })` or `restore`. */
  id: number
  at: string
  /** Xid of the user who wrote this version. */
  by: string | null
  hash: string | null
  size: number | null
  content_type: string | null
  current: boolean
}

/** Anything fetch can send: Blob/File, ArrayBuffer, typed array, string, or a stream. */
export type FileBody =
  | Blob | ArrayBuffer | ArrayBufferView | string
  | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>

/** A file by path ('/site/img/logo.png'), by xid, or the file itself. */
export type FileRef = string | { xid: string }

/** A folder by path ('/site/img/', '/' is ROOT), by xid, or the folder itself. */
export type FolderRef = string | { xid: string; path?: string }

export interface FolderInfo {
  xid: string
  name: string
  path: string
  /** Parent folder xid (ROOT's for a top-level folder); null only on ROOT itself. */
  parent: string | null
  /** Whether you may upload here, create subfolders, rename and share. */
  writable: boolean
  /** Files here load without a token: this folder's own Public, else the nearest folder above that has one. */
  public: boolean
  /** Seconds browsers and CDNs may keep the files, set the same way; null: they check every time. */
  cache: number | null
  /** What is set on this folder itself (null: inherited); `folder(path, settings)` writes these. */
  settings: { public: boolean | null; cache: number | null }
}

export interface FilePutOpts {
  /** Defaults to the Blob's type, else text/plain for strings, else application/octet-stream. */
  contentType?: string
  /** Refuse with FILE_CHANGED unless the stored hash still matches (a hash, or the file). */
  ifMatch?: string | { hash: string }
  signal?: AbortSignal
}

export type FileDownloadAs = 'blob' | 'arrayBuffer' | 'text' | 'json' | 'stream' | 'response'

export interface FileDownloadOpts<A extends FileDownloadAs = 'blob'> {
  as?: A
  /** Inclusive byte range; `[start]` reads to the end, `[undefined, n]` the last n bytes. */
  range?: [number | undefined, number?] | { start?: number; end?: number }
  /** A hash you already hold: answers null instead of the bytes when unchanged. */
  ifNoneMatch?: string
  /** A kept version (its id, or the version itself) instead of the current bytes. */
  version?: number | { id: number }
  signal?: AbortSignal
}

export type FileDownloadResult<A extends FileDownloadAs> =
  A extends 'arrayBuffer' ? ArrayBuffer
  : A extends 'text' ? string
  : A extends 'json' ? unknown
  : A extends 'stream' ? ReadableStream<Uint8Array> | null
  : A extends 'response' ? Response
  : Blob

export interface FileListOpts {
  /** Names holding these words in order, any case; a space stands for anything between. */
  q?: string
  /** Files per page: default 100, at most 1000. */
  limit?: number
  offset?: number
}

export interface FileListing {
  files: FileInfo[]
  folders: FolderInfo[]
}

export interface FileSearchOpts {
  /** Search only below this folder. */
  folder?: FolderRef
  /** Results per page: default 100, at most 1000. */
  limit?: number
  /** Skip this many results; with `truncated`, page through the rest. */
  offset?: number
  signal?: AbortSignal
}
export type FileSearchResult =
  | (FolderInfo & { type: 'folder' })
  /** `path` is null for a file in no folder or in a folder you cannot see; such a file matches by name. */
  | (FileInfo & { type: 'file'; path: string | null })
export interface FileSearch {
  /** Shortest path first. */
  results: FileSearchResult[]
  /** More results after this page. */
  truncated: boolean
}
export interface FolderSettings {
  /** Files here, and in folders below without their own value, load without a token; null: inherit. */
  public?: boolean | null
  /** Seconds browsers and CDNs may keep the files; null: inherit. */
  cache?: number | null
}

export type FolderAccess = 'read' | 'write' | 'delete'

export type FolderAccessLists = Record<FolderAccess, {
  users: { xid: string; name: string | null }[]
  groups: { xid: string; name: string | null }[]
}>

/** Users and groups by xid, or the records. */
export interface Grantees {
  users?: (string | { xid: string })[]
  groups?: (string | { xid: string })[]
}

export interface FilesApi {
  /** A path creates or replaces the file there (its folder must exist); an xid or file replaces it; `{ name }` makes a new file in no folder. */
  put(target: string | { xid: string } | { name: string }, data: FileBody, opts?: FilePutOpts): Promise<FileInfo>
  /** The bytes; null when `ifNoneMatch` still matches. */
  download<A extends FileDownloadAs = 'blob'>(file: FileRef, opts?: FileDownloadOpts<A>): Promise<FileDownloadResult<A> | null>
  /** The file, or null when it is not there or you can't see it. */
  info(file: FileRef): Promise<FileInfo | null>
  /** A folder's files and subfolders; `null`: files in no folder; nothing: every file you can see, newest first. */
  list(folder?: FolderRef | null, opts?: FileListOpts): Promise<FileListing>
  /** Folders and files whose paths hold the words of `q` in order ('site logo' finds /site/img/logo.png), shortest path first. */
  search(q: string, opts?: FileSearchOpts): Promise<FileSearch>
  /** Delete a file, or an empty folder (a path ending in / or the folder itself). */
  delete(target: FileRef | FolderRef): Promise<void>
  /** Where the file loads from, without a request; `inline` opens it in the browser instead of downloading. */
  url(file: FileRef, opts?: { inline?: boolean }): string
  /** Rename or move; for a file, a `to` ending in / keeps the name. */
  move(from: FileRef | FolderRef, to: string): Promise<FileInfo | FolderInfo>
  /** The folder at `path`, made with every missing folder above it; `settings` sets its Public and Cache. */
  folder(path: string, settings?: FolderSettings): Promise<FolderInfo>
  /** Give users and groups an access on a folder; writers of the folder may. */
  share(folder: FolderRef, access: FolderAccess, to: Grantees): Promise<void>
  /** Take an access away. */
  unshare(folder: FolderRef, access: FolderAccess, from: Grantees): Promise<void>
  /** Who holds read, write and delete. */
  access(folder: FolderRef): Promise<FolderAccessLists>
  /** The kept versions (the last ten), newest first. */
  versions(file: FileRef): Promise<FileVersion[]>
  /** Make a kept version current again (VERSION_EXPIRED when it is gone). */
  restore(file: FileRef, version: number | { id: number }): Promise<FileInfo>
  /** Browser: a blob: URL of the bytes, downloaded with your token; call revoke when done. */
  objectUrl(file: FileRef, opts?: { signal?: AbortSignal }): Promise<{ url: string; revoke(): void }>
  /** Server: answer a browser's request with the file (Range, If-None-Match, ETag and type pass through). */
  serve(file: FileRef, request?: Request | { method?: string; headers?: Record<string, string> }, opts?: { inline?: boolean }): Promise<Response>
}

// ============================================================================
// Lint
// ============================================================================

export interface LintDiagnostic {
  severity: 'error' | 'warning'
  message: string
  /** Byte offset (inclusive) into the source. */
  from: number
  /** Byte offset (exclusive) into the source. */
  to: number
  /** 1-based line/column at `from`. */
  start: { line: number; col: number }
  /** 1-based line/column at `to`. */
  end: { line: number; col: number }
}

// ============================================================================
// Schema
// ============================================================================

export interface SchemaRelation {
  to: string
  cardinality: 'one' | 'many'
}

export interface SchemaAttribute {
  /** Scalar or reference type: 'string' | 'boolean' | 'int' | 'float' | 'timestamp' | 'json' | 'uuid' | 'enum' | 'hashed' | 'encrypted' | 'transit' | <referenced-entity> */
  type: string
  /** Present (and always `false`) only for mandatory fields; absent ⇒ nullable.
   *  The terse-by-exception form: most fields are optional and omit this key. */
  nullable?: boolean
  /** Enum member values, verbatim (not re-cased). Present only when `type === 'enum'`. */
  enum?: string[]
  /** Input-only — written but never read back (no plaintext). Present only for
   *  `hashed` fields. (`encrypted` reads back as ciphertext, so it is NOT write-only.) */
  'write-only'?: boolean
}

export interface SchemaEntity {
  name: string
  /** Field name (kebab-case) → attribute schema. Keys are canonical kebab-case
   *  regardless of any `key_format` used on `/data` responses. */
  attributes: Record<string, SchemaAttribute>
  relations: Record<string, SchemaRelation>
  constraints: { unique: string[][] }
}

export interface Schema {
  'id-key': 'xid' | 'euuid'
  /** Entity name (kebab-case) → entity schema */
  entities: Record<string, SchemaEntity>
}

// ============================================================================
// Error
// ============================================================================

/**
 * Wire-level error code emitted by the Synthigy server. Union of the
 * stable typed codes; falls through to `string` so future codes don't
 * become a breaking change here.
 *
 * Discriminate on these instead of regex-matching `error.message`:
 *
 *   try { await client.search(...) } catch (e) {
 *     if (e instanceof SynthigyError && e.code === 'UNKNOWN_ATTRIBUTE') {
 *       // e.details may carry { entity, attribute, hint }
 *     }
 *   }
 *
 * Auth / impersonation:
 *   UNAUTHORIZED, CLIENT_NOT_FOUND, CLIENT_INACTIVE,
 *   PUBLIC_CLIENT_FORBIDDEN, NOT_TRUSTED, USER_NOT_FOUND, FORBIDDEN
 *
 * Token mint refused (client credentials):
 *   INVALID_CLIENT, INVALID_SCOPE, INVALID_AUDIENCE
 *
 * Permission denied (RBAC/RLS):
 *   ENTITY_FORBIDDEN, RELATION_FORBIDDEN, ATTRIBUTE_FORBIDDEN,
 *   ROW_FORBIDDEN, CREATE_FORBIDDEN, DELETE_FORBIDDEN, SLOT_OCCUPIED
 *
 * Request shape:
 *   INVALID_BODY, NO_OPERATIONS, BAD_OP, MISSING_ENTITY,
 *   BAD_ARGS_SHAPE
 *
 * Schema resolution (typed throws ride along the engine's existing
 * walks; ex-`INTERNAL_ERROR`):
 *   UNKNOWN_OP, UNKNOWN_ENTITY, UNKNOWN_ATTRIBUTE, UNKNOWN_OPERATOR,
 *   MISSING_ON, MISSING_ROOT, UNKNOWN_TREE_RELATION, XSQL_PARSE_ERROR,
 *   PARAM_MISSING, PARAM_TYPE_MISMATCH
 *
 * DB:
 *   FK_VIOLATION, UNIQUE_VIOLATION, NOT_NULL_VIOLATION,
 *   CHECK_VIOLATION, TYPE_CAST_FAILURE, TIMEOUT
 *
 * Transport / catch-all:
 *   HTTP_ERROR, OPERATION_ERROR, INTERNAL_ERROR
 *
 * Client-side (no server round trip):
 *   NO_TOKEN — no token source configured; see ClientConfig.
 *   NO_LOGIN_STORE — createClient({ loginStore }) was never given one.
 *   LOGIN_REQUIRES_CONFIDENTIAL_CLIENT — login needs clientId + clientSecret.
 *   LOGIN_STATE_UNKNOWN, LOGIN_NONCE_MISMATCH, LOGIN_EXCHANGE_FAILED — see client.login.
 */
export type SynthigyErrorCode =
  | 'UNAUTHORIZED' | 'CLIENT_NOT_FOUND' | 'CLIENT_INACTIVE'
  | 'PUBLIC_CLIENT_FORBIDDEN' | 'NOT_TRUSTED' | 'USER_NOT_FOUND'
  | 'FORBIDDEN' | 'NO_TOKEN'
  | 'INVALID_CLIENT' | 'INVALID_SCOPE' | 'INVALID_AUDIENCE'
  | 'ENTITY_FORBIDDEN' | 'RELATION_FORBIDDEN' | 'ATTRIBUTE_FORBIDDEN'
  | 'ROW_FORBIDDEN' | 'CREATE_FORBIDDEN' | 'DELETE_FORBIDDEN' | 'SLOT_OCCUPIED'
  | 'NO_LOGIN_STORE' | 'LOGIN_REQUIRES_CONFIDENTIAL_CLIENT'
  | 'LOGIN_STATE_UNKNOWN' | 'LOGIN_NONCE_MISMATCH' | 'LOGIN_EXCHANGE_FAILED'
  | 'INVALID_BODY' | 'NO_OPERATIONS' | 'BAD_OP' | 'MISSING_ENTITY'
  | 'BAD_ARGS_SHAPE'
  | 'UNKNOWN_OP' | 'UNKNOWN_ENTITY' | 'UNKNOWN_ATTRIBUTE' | 'UNKNOWN_OPERATOR'
  | 'MISSING_ON' | 'MISSING_ROOT' | 'UNKNOWN_TREE_RELATION' | 'XSQL_PARSE_ERROR'
  | 'PARAM_MISSING' | 'PARAM_TYPE_MISMATCH'
  | 'FK_VIOLATION' | 'UNIQUE_VIOLATION' | 'NOT_NULL_VIOLATION'
  | 'CHECK_VIOLATION' | 'TYPE_CAST_FAILURE' | 'TIMEOUT'
  | 'HTTP_ERROR' | 'OPERATION_ERROR' | 'INTERNAL_ERROR'
  | 'FILE_NOT_FOUND' | 'FOLDER_NOT_FOUND' | 'FILE_NAME_TAKEN' | 'FILE_CHANGED'
  | 'FILE_NOT_READY' | 'FILE_TOO_LARGE' | 'NAME_REQUIRED' | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RANGE_NOT_SATISFIABLE' | 'FILES_UNAVAILABLE' | 'AUDIT_UNAVAILABLE'
  | 'FOLDER_NOT_EMPTY' | 'FOLDER_NAME_TAKEN' | 'FOLDER_CYCLE' | 'INVALID_NAME' | 'INVALID_ACCESS'
  | 'VERSION_EXPIRED' | 'INVALID_PATH' | 'INVALID_SETTINGS' | 'INVALID_QUERY'
  | 'METHOD_NOT_ALLOWED' | 'NOT_FOUND' | 'ENGINE_OWNED' | 'INVALID_SLICE'
  | (string & {})

/** `whoami()` — the identity a call runs as. `client` is null in-process (no OAuth client). */
export interface WhoAmI {
  xid: string | null
  name: string | null
  active: boolean
  superuser: boolean
  roles: string[]
  groups: string[]
  /** `trusted`: this client may act as users (confidential, active, flagged trusted). */
  client: { id: string; trusted: boolean } | null
}

export type SynthigyErrorCategory =
  | 'auth' | 'iam' | 'validation' | 'not_found'
  | 'conflict' | 'rate_limit' | 'network' | 'internal'

/** 1-based source position (XSQL_PARSE_ERROR, TEMPLATE_*). */
export interface SourcePosition { line: number; col: number }

export class SynthigyError extends Error {
  name: 'SynthigyError'
  code: SynthigyErrorCode
  category: SynthigyErrorCategory
  /** True for known network/rate_limit/internal codes, or when the server marked the error retryable. */
  retryable: boolean
  details?: unknown
  hint?: string
  available?: string[]
  path?: unknown
  entity?: string
  relation?: string
  operator?: string
  requestId?: string
  status?: number
  line?: number
  col?: number
  start?: SourcePosition
  end?: SourcePosition
  diagnostics?: unknown[]
  constructor(message: string, code: string, details?: unknown, extras?: {
    hint?: string; available?: string[]; path?: unknown; entity?: string; relation?: string
    operator?: string; requestId?: string; status?: number; retryable?: boolean
    line?: number; col?: number; start?: SourcePosition; end?: SourcePosition; diagnostics?: unknown[]
  })
}

// ============================================================================
// Client config
// ============================================================================

export interface ClientConfig {
  /** Synthigy base URL. Defaults to `$SYNTHIGY_ENDPOINT` (set by `synthigy exec`). */
  endpoint?: string
  /** OAuth client ID — required with clientSecret for client credentials */
  clientId?: string
  clientSecret?: string
  /**
   * Static bearer token — alternative to client credentials. On Node,
   * with none of clientId+clientSecret/token given, the client also falls
   * back to SYNTHIGY_TOKEN env, then a SYNTHIGY_SUPERVISED=1 stdio ask;
   * with no source at all it throws SynthigyError{code: 'NO_TOKEN'}.
   */
  token?: string
  /**
   * Caller-owned token source, checked before every other option. `clear()`
   * is called on a 401 before the single retry; `createBrowserLogin()`'s
   * `tokenProvider()` renews there.
   */
  tokenProvider?: TokenProvider
  scope?: string
  /**
   * Default client_credentials audience, applied to every mint this client
   * makes (falls back to SYNTHIGY_AUDIENCE on Node). The platform's audience
   * model is opt-in: a mint naming no audience resolves to the identity-only
   * OIDC audience, which /data rejects. The server publishes its /data
   * audience at /.well-known/synthigy as `auth.oidc.audience`.
   */
  audience?: string
  /** Default acting_as applied to every request unless overridden per-call */
  actingAs?: string
  keyFormat?: KeyFormat
  /**
   * Hold the upstream SSE connection open across windows where no user
   * watches are active. Default: false (SSE closes when the last watch
   * closes — correct for browser SPAs).
   *
   * Set true for long-lived BFFs / Node services: the server-side
   * plug session is keyed by [sub, client_id] and is torn down when
   * the SSE drops, so a tab refresh that briefly closes every watch can
   * lose published events. With keepAlive on, the SSE stays open from
   * `createClient()` until `client.close()`.
   */
  keepAlive?: boolean
  /**
   * Request timeout in milliseconds. Applied to all one-shot requests (exec,
   * subscribe, etc.) via `AbortSignal.timeout`. Not applied when the call
   * already carries an AbortSignal (e.g. listen() with opts.signal).
   * Requires Node ≥ 17.3 / modern browsers.
   */
  timeout?: number
  /**
   * Optional fetch implementation. Defaults to `globalThis.fetch`.
   * Pass `undici.fetch` with a shared `Agent` for pooled connections in Node.
   */
  fetch?: typeof globalThis.fetch
  /**
   * Where in-flight logins live between `login.start()` and the callback.
   * Required to use `client.login` at all — without one, every call throws
   * `NO_LOGIN_STORE` rather than silently keeping state in one process.
   * `MemoryLoginStore` is the single-process dev option.
   */
  loginStore?: LoginStore
}

// ============================================================================
// Login — OIDC authorization-code + PKCE
// ============================================================================

/** One login in flight: everything the callback needs to finish it. */
export interface PendingLogin {
  codeVerifier: string
  nonce: string
  returnTo: string
  createdAt: number
}

/**
 * The one piece of protocol state the SDK cannot hold for you.
 *
 * `take` is one-shot: it must return the login AND remove it, so a replayed
 * callback finds nothing. Both methods may be sync or async.
 */
export interface TokenProvider {
  getToken(audience?: string): string | null | Promise<string | null>
  clear(): void
}

export interface BrowserLoginConfig {
  endpoint: string
  clientId: string
  /** The page that finishes the login (calls `complete()`), registered on the client. */
  redirectUri: string
  /** Page the renewal iframe lands on; default `redirectUri`. It must call `silentCallback()` first. */
  silentRedirectUri?: string
  postLogoutRedirectUri?: string
  /** Default 'openid profile'. */
  scope?: string
  audience?: string
  /** Renew silently shortly before expiry (default true). */
  automaticSilentRenew?: boolean
  /** Merge /oauth/userinfo into `user` after each login and renewal (default false) — the profile (name, email) lives there. */
  loadUserInfo?: boolean
  /** Seconds before expiry that renewal starts (default 60). */
  expiringSeconds?: number
  silentTimeoutMs?: number
  fetch?: typeof globalThis.fetch
  /** Where the in-flight login waits for the callback (default sessionStorage). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

export type BrowserLoginEvent =
  'userLoaded' | 'userUnloaded' | 'accessTokenExpiring' | 'accessTokenExpired' | 'silentRenewError'

export interface BrowserLogin {
  /** id_token claims of the logged-in user (`sub`, `xid`, …), or null. */
  readonly user: Record<string, unknown> | null
  readonly token: string | null
  on(event: BrowserLoginEvent, listener: (payload?: unknown) => void): () => void
  isCallback(): boolean
  /** Redirect to the login page; `prompt: 'none'` returns at once when a session is alive. */
  start(opts?: { prompt?: 'none' | 'login'; returnTo?: string }): Promise<void>
  /** Finish the login the current URL returns from, or null when it carries none. */
  complete(): Promise<{ user: Record<string, unknown>; returnTo: string } | null>
  /** The user cancelled on the IdP: drop the pending login. */
  cancel(): { returnTo: string } | null
  renew(): Promise<Record<string, unknown>>
  removeUser(): void
  logout(): void
  tokenProvider(): TokenProvider
}

/** Browser login as a public client: PKCE, silent renew, tokens in memory. */
export function createBrowserLogin(config: BrowserLoginConfig): BrowserLogin

/** Call first on the silent-redirect page; true when this window was a renewal iframe and answered it. */
export function silentCallback(): boolean

export interface LoginStore {
  put(state: string, login: PendingLogin): void | Promise<void>
  take(state: string): PendingLogin | null | Promise<PendingLogin | null>
}

/** In-memory `LoginStore`. Single process only — see the class docstring. */
export class MemoryLoginStore implements LoginStore {
  constructor(opts?: { ttlMs?: number })
  put(state: string, login: PendingLogin): void
  take(state: string): PendingLogin | null
}

export interface LoginStartOpts {
  /** URL on YOUR server the IdP redirects back to; must be registered on the client. */
  redirectUri: string
  /** Where to send the visitor once login finishes. Default `'/'`. */
  returnTo?: string
  /** Default `'openid'` — the scope that names the user. */
  scope?: string
  /** Browser-reachable engine URL, when it differs from the server-side one. */
  publicEndpoint?: string
}

export interface LoginCompleteOpts {
  code: string
  state: string
  redirectUri: string
}

export interface LoginTokens {
  access_token: string
  id_token?: string
  refresh_token?: string
  token_type?: string
  scope?: string
  expires_in?: number
}

export interface LoginResult {
  /** Straight out of the id_token — no /data round-trip. */
  user: { xid: string | null; name: string | null; scopes: string[] }
  tokens: LoginTokens
  returnTo: string
}

// ============================================================================
// Client
// ============================================================================

export class SynthigyClient {
  /**
   * Tear the client down — close every live watch, release the keepAlive
   * hold, close the SSE. Idempotent. Use this on shutdown so the server
   * drops the plug session promptly instead of waiting for the SSE
   * to time out.
   */
  close(): void

  /**
   * Returns a FetchFn for `@synthigy/buffer`'s `connect({ fetchFn })`.
   * Shares this client's token cache, endpoint, and fetch implementation.
   */
  fetchFn(): FetchFn

  /** Get a bearer token, optionally for a specific audience (Synthigy as IdP). */
  token(opts?: { audience?: string }): Promise<string>

  /** Execute raw operations against /data. */
  exec(operations: Operation[], opts?: ExecOpts): Promise<OperationResult[]>

  // ── Read ──────────────────────────────────────────────────────────────────

  search<T = Record<string, unknown>>(
    entity: string,
    args: Args | undefined,
    selection: Selection,
    opts?: ExecOpts,
  ): Promise<T[]>

  /**
   * Run an XSQL selection-DSL query in `get` mode. Returns a single
   * record or `null`. The XSQL must express identity via unique-key
   * predicates at the root (`xid = ?xid:string` etc.).
   */
  query<T = Record<string, unknown>>(
    xsql: string,
    params: Record<string, unknown> | undefined,
    opts: ExecOpts & { op: 'get'; entity?: string },
  ): Promise<T | null>

  /**
   * Run an XSQL selection-DSL query with optional named parameters.
   * The wire envelope carries the XSQL string in `selections` plus a
   * `params` map for `?name:type[]` placeholders. Default `op` is
   * `'search'`; pass `opts.op` to use `'get'` / `'slice'` / `'purge'`.
   */
  query<T = Record<string, unknown>>(
    xsql: string,
    params?: Record<string, unknown>,
    opts?: ExecOpts & {
      op?: 'search' | 'slice' | 'purge'
      entity?: string
    },
  ): Promise<T[]>

  get<T = Record<string, unknown>>(
    entity: string,
    args: Record<string, unknown>,
    selection: Selection,
    opts?: ExecOpts,
  ): Promise<T | null>

  sqlTemplate<T = Record<string, unknown>>(
    template: string,
    params?: Record<string, unknown> | unknown[],
    opts?: ExecOpts & { cached?: boolean },
  ): Promise<T[]>

  /** Returns a forest of composed trees. Pass `{ raw: true }` to get the flat array instead. */
  searchTree<T = Record<string, unknown>>(
    entity: string,
    on: string,
    args: Args | undefined,
    selection: Selection,
    opts?: TreeExecOpts,
  ): Promise<(T & { [key: string]: unknown })[]>

  /** Returns a single composed tree rooted at `root`, or null if not found. Pass `{ raw: true }` to get the flat array instead. */
  getTree<T = Record<string, unknown>>(
    entity: string,
    root: string,
    on: string,
    selection: Selection,
    opts?: TreeExecOpts,
  ): Promise<(T & { [key: string]: unknown }) | null>

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Writes are silent by default — the server answers `{ count }`. Pass
   * `returning: true` for the written records, or mint ids up front with
   * `newXid()`, which is the cheap way to know what you wrote.
   */
  sync<T = Record<string, unknown>>(
    entity: string,
    data: Record<string, unknown> | Record<string, unknown>[],
    opts?: WriteOpts,
  ): Promise<T>

  /** Same `returning` contract as sync. */
  stack<T = Record<string, unknown>>(
    entity: string,
    data: Record<string, unknown> | Record<string, unknown>[],
    opts?: WriteOpts,
  ): Promise<T>

  /** Returns a map of relation-name → boolean (true = sliced successfully). */
  slice(
    entity: string,
    args: Record<string, unknown>,
    selection?: Selection,
    opts?: ExecOpts,
  ): Promise<Record<string, boolean>>

  delete(
    entity: string,
    data: Record<string, unknown>,
    opts?: ExecOpts,
  ): Promise<boolean>

  purge<T = Record<string, unknown>>(
    entity: string,
    args: Args | undefined,
    selection?: Selection,
    opts?: ExecOpts,
  ): Promise<T>

  // ── Subscriptions ─────────────────────────────────────────────────────────
  //
  // The SDK tracks the active subscription set locally; each call below
  // mutates that local set and POSTs the full set to the server's
  // /data/subscription/set endpoint (full-set replacement semantics).

  /**
   * Add a record-scoped data subscription. Re-subscribing with the same
   * descriptor (or same `opts.key`) replaces the prior entry.
   *
   *   subscribe(['u-abc', 'u-def'])
   *   subscribe({ records: ['u-abc'], operations: ['update'] }, { key: 'page-detail' })
   */
  subscribe(descriptor: Descriptor, opts?: SubscribeOpts): Promise<{ ok: boolean }>

  /**
   * Remove a record-scoped data subscription. `handle` is either the
   * `key` you used at subscribe-time or an equivalent descriptor.
   */
  unsubscribe(handle: string | Descriptor): Promise<{ ok: boolean }>

  /** Subscribe to model deploy events. raw=true uses 'deployed-model'; otherwise 'runtime-model'. */
  subscribeModel(opts?: { raw?: boolean }): Promise<{ ok: boolean }>

  /** Unsubscribe from model deploy events. */
  unsubscribeModel(opts?: { raw?: boolean }): Promise<{ ok: boolean }>

  /** Replace the entire subscription set in one call. */
  setSubscriptions(items: SubscriptionItem[]): Promise<{ ok: boolean }>

  /** Clear all subscriptions for this session. */
  clearSubscriptions(): Promise<{ ok: boolean }>

  /** Fetch current subscription state from the server. */
  subscriptions(): Promise<{ subscriptions: SubscriptionInfo[] }>

  // ── Files — upload, download, versions ───────────────────────────────────

  files: FilesApi

  // ── History — temporal query surface ─────────────────────────────────────

  history: {
    /** State of a record at timestamp T. */
    getAt<T = Record<string, unknown>>(
      recordXid: string,
      at: string,
      opts?: { tenant?: string; includeDeleted?: boolean },
    ): Promise<T | null>

    /** Events for a record (or any record) over a time range. */
    events(opts?: HistoryEventsOpts): Promise<HistoryEvent[]>

    /** Diff a record between two timestamps. */
    diff<T = Record<string, unknown>>(
      recordXid: string,
      fromTs: string,
      toTs: string,
      opts?: { tenant?: string },
    ): Promise<HistoryDiffResult<T>>

    /** Events grouped by request, actor, or scope. */
    timeline(opts: HistoryTimelineOpts): Promise<Record<string, HistoryEvent[]>>

    /** Events strictly after cursor timestamp T, oldest-first. */
    since(opts?: HistorySinceOpts): Promise<HistoryEvent[]>
  }

  // ── Login — OIDC authorization-code + PKCE ───────────────────────────────

  login: {
    /** Begin a login; redirect the browser to the returned URL. */
    start(opts: LoginStartOpts): Promise<{ url: string }>

    /** Finish a login from the callback's `code` + `state`. */
    complete(opts: LoginCompleteOpts): Promise<LoginResult>

    /** Drop an in-flight login and recover its `returnTo`; null when unknown. */
    cancel(state: string | null | undefined): Promise<{ returnTo: string } | null>
  }

  /** Fetch the IAM-filtered model schema via `GET /schema`. Pass entity names to filter. */
  schema(entities?: string[]): Promise<Schema>

  /**
   * Lint an XSQL source string against the IAM-projected schema.
   * `entity` enables schema-aware checks; omit for syntax-only lint.
   */
  lint(source: string, opts?: {
    entity?: string
    op?: 'search' | 'get' | 'slice' | 'purge'
  }): Promise<LintDiagnostic[]>

  /**
   * Compile an XSQL source to the wire operation the engine would execute
   * (`POST /compile`), without executing it. `params` bind exactly as on
   * `query`, so the result IS what the engine receives — edit it and send
   * it through `exec`.
   */
  compile(source: string, opts?: {
    params?: Record<string, unknown>
    op?: 'search' | 'get' | 'slice' | 'purge'
  }): Promise<Operation>

  /**
   * Mint a one-time account-claim link via `POST /oauth/onboard`.
   * Confidential client whose principal administers the account — RBAC
   * update on User plus the row inside its owner-group write scope, which
   * the shipped User Provisioner role grants — else `PROVISION_FORBIDDEN`;
   * this client's own client_credentials identity IS that principal. `xid`
   * addresses an EXISTING account (create it first via `sync('iam/user', ...)`);
   * a blank xid fails with `XID_REQUIRED`, one that doesn't resolve with
   * `USER_NOT_FOUND`. `reset` soft-recycles the account first (strips its
   * federated identities, nulls its password, revokes its live
   * sessions/tokens — leaves `active` untouched); `methods` restricts the
   * claim page (e.g. `['password']`); omitted allows every active provider
   * plus password. `returnUrl`, if set, must match one of THIS client's
   * registered redirections (or be a loopback URI); a successful DIRECT
   * claim (browser) then redirects there instead of the generic status page.
   */
  onboard(xid: string, opts?: {
    reset?: boolean
    methods?: string[]
    ttlSeconds?: number
    returnUrl?: string
  }): Promise<{ onboard_url: string; expires_at: number; user: { xid: string } }>

  /**
   * Redeem an onboarding ticket without a browser via
   * `POST /oauth/onboard/complete` — the indirect face of the SAME ticket
   * `onboard()` mints. Must be called by the SAME client that minted the
   * ticket. Never sets a credential — credentials are subject-only; the
   * account activates with none. Give it one via the claim page (password
   * or a federated identity) or a later ticket.
   */
  onboardComplete(ticket: string): Promise<{ user: { xid: string }; active: boolean }>

  /**
   * Fetch the full ERD model via `op: "deployed-model"`.
   * Unlike `schema()`, this returns the raw model including internal
   * metadata and un-filtered entities. Requires `dataset:load` scope.
   */
  deployedModel(opts?: ExecOpts): Promise<Record<string, unknown>>

  /** Who a call runs as, after `actingAs` — roles, superuser, and whether this client may act as users. */
  whoami(opts?: ExecOpts): Promise<WhoAmI>

  /**
   * Deploy a dataset version from a modeler export — pass the export file's
   * contents verbatim, the server decodes it. Requires `dataset:deploy`.
   * The ack carries the dataset xid `destroy()` takes.
   */
  deploy(exportContents: string, opts?: ExecOpts): Promise<DeployAck>

  /**
   * Destroy a dataset — every version, table and row. Requires
   * `dataset:delete`. Idempotent.
   */
  destroy(datasetXid: string, opts?: ExecOpts): Promise<boolean>

  /**
   * Fetch the runtime (enhanced) ERD model via `op: "runtime-model"` —
   * the model as the running system actually emits it, with audit
   * timestamps, computed defaults, and reference-typed attrs surfaced
   * as first-class relations. Prefer this over `deployedModel()` when
   * you want to see what the live system emits. The server currently
   * returns this transit-encoded, so the result may be a string.
   * Requires `dataset:load` scope.
   */
  runtimeModel(opts?: ExecOpts): Promise<Record<string, unknown> | string>

  /**
   * Open a persistent SSE connection to `/data/events`.
   * Reconnects automatically with exponential backoff.
   * Sends `Last-Event-ID` on reconnect to avoid missing events.
   * Cancel via `AbortSignal`.
   */
  listen(opts?: ListenOpts): AsyncGenerator<SubscribeEvent>

  /**
   * One-call live primitive: subscribe + SSE + auto-reconnect (+ optional
   * history backfill). Yields a typed event stream filtered to the
   * records named by the descriptor. Cleanup on iterator close:
   * unsubscribes locally.
   *
   * Server tears down subscription state on each SSE close, so observe()
   * re-subscribes before every new SSE session. The plug's default
   * best-effort delivery is normally enough; pass `backfill: true` to
   * also replay `/history` events missed during a disconnect.
   *
   *   for await (const ev of client.observe(['u-abc'])) { ... }
   *   for await (const ev of client.observe({
   *     records: [userXid, teamXid],
   *     operations: ['update', 'link'],
   *   })) { ... }
   */
  observe(descriptor: Descriptor, opts?: ObserveOpts): AsyncGenerator<ObserveEvent>

  /**
   * Open a live, multiplexed subscription. Many `watch()` calls on the
   * same client fuse onto ONE SSE connection and ONE consolidated
   * subscription set on the server. Events are coalesced per-record
   * and attribute-name keyed.
   *
   * Each `for await (const ev of w.events)` gets a fresh iterator with
   * its own buffer — siblings in a component tree can consume the same
   * Watch independently.
   */
  watch(interest: WatchInterest, opts?: WatchOpts): Watch

  /** Open a separate stream of schema-deploy events. */
  watchSchema(): SchemaWatch

  /**
   * Live result-set for a query. Built on `watch()`. Snapshots via
   * /data search, watches the result xids + the entity's relations,
   * coalesced re-runs the query on each event window, diffs against
   * last result, emits query/added | query/changed | query/removed.
   */
  watchQuery: WatchQueryFn

  /**
   * Live raw-SQL result. Composes `sqlTemplate()` snapshot with
   * `watch()` subscription on the entities named in `opts.entities`.
   *
   * SQL is opaque to the SDK, so the caller declares which entities
   * the query reads from — those entities' relation xids become the
   * watch interest. Add specific record xids via `opts.records` if
   * you also need per-row update events to trigger refresh.
   */
  watchSqlTemplate<T = Record<string, unknown>>(
    template: string,
    params?: Record<string, unknown> | unknown[],
    opts?: SqlTemplateWatchOpts,
  ): SqlTemplateWatch<T>
}

export interface SqlTemplateWatchOpts extends WatchOpts {
  /** Entity names the SQL reads from. Required — used to compute the
   *  relation-xid watch interest. */
  entities: string[]
  /** Extra record xids to include in the watch interest. Use when the
   *  SQL aggregates over fields that can change without inserts/deletes
   *  (e.g. avg(value) where existing rows' values are mutable). */
  records?: string[]
  /** Forwarded to sqlTemplate() — actingAs, abort signal, etc. */
  searchOpts?: ExecOpts
}

export interface SqlTemplateWatch<T = Record<string, unknown>> {
  /** Current result: array of rows. */
  readonly value: T[] | null
  /** Convenience: first row, or null. */
  readonly first: T | null
  /** Resolves once the initial snapshot + watch are wired. */
  ready(): Promise<void>
  /** Force a fresh re-run of the SQL. */
  refresh(): Promise<void>
  /** Async iterable of events. */
  readonly events: AsyncIterable<SqlTemplateWatchEvent<T> | WatchSentinel>
  /** Tear down the watch. */
  close(): void
}

export type SqlTemplateWatchEvent<T = Record<string, unknown>> =
  | { type: 'result/changed'; before: T[] | null; after: T[]; ts?: string; txid?: string; actor?: string; request?: string }

// ============================================================================
// Live query / aggregate types
// ============================================================================

export interface WatchQueryOpts extends WatchOpts {
  /** Forwarded to search()/query() as the request's options bag. */
  searchOpts?: ExecOpts
}

export interface XsqlWatchOpts extends WatchOpts {
  /** Kebab-case root entity name — required so the SDK knows which
   *  relations to watch for new-member events. */
  entity: string
  searchOpts?: ExecOpts
  /** Op override for the underlying client.query() call (default 'search'). */
  op?: 'search' | 'get' | 'slice' | 'purge'
}

export interface WatchQueryFn {
  <T = Record<string, unknown>>(
    entity: string,
    args: Args,
    selection: Selection,
    opts?: WatchQueryOpts,
  ): QueryWatch<T>
  xsql<T = Record<string, unknown>>(
    xsql: string,
    params?: Record<string, unknown>,
    opts?: XsqlWatchOpts,
  ): QueryWatch<T>
}

export type QueryEvent<T> =
  | { type: 'query/added';   record: T;
      ts?: string; txid?: number; actor?: string; request?: string }
  | { type: 'query/removed'; recordXid: string;
      ts?: string; txid?: number; actor?: string; request?: string }
  | { type: 'query/changed'; record: T;
      before: Partial<T>; after: Partial<T>; changed: (keyof T & string)[];
      ts?: string; txid?: number; actor?: string; request?: string }
  | WatchSentinel

export interface QueryWatch<T = Record<string, unknown>> {
  readonly initial: readonly T[] | null
  readonly records: ReadonlyMap<string, T>
  list(): T[]
  ready(): Promise<void>
  refresh(): Promise<void>
  readonly events: AsyncIterable<QueryEvent<T>>
  close(): void
}

export interface AggregateSelection {
  count?: null | true
  avg?: Record<string, null | true>
  sum?: Record<string, null | true>
  min?: Record<string, null | true>
  max?: Record<string, null | true>
}

export interface AggregateResult {
  count?: number
  avg?: Record<string, number>
  sum?: Record<string, number>
  min?: Record<string, unknown>
  max?: Record<string, unknown>
}

// ============================================================================
// Watch types
// ============================================================================

export interface WatchInterest {
  /** Record xids to watch. Receives entity events for these records, and
   *  relation events where either side of the link is one of these records. */
  records?: string[]
  /** Relation-type xids to watch. Receives link/unlink events for those types. */
  relations?: string[]
  /** Ops to include; omit for all. */
  ops?: ('insert' | 'update' | 'delete' | 'link' | 'unlink')[]
}

export interface WatchOpts {
  /**
   * 'coalesce' (default) — collapse repeated entity events on the same record
   * into the latest state. 'lossless' — preserve every event; emit a 'paused'
   * sentinel on overflow. 'sliding' — drop oldest on overflow (legacy).
   */
  backpressure?: 'coalesce' | 'lossless' | 'sliding'
  /** Per-iterator buffer size (default 100). */
  bufferSize?: number
  signal?: AbortSignal
}

/** Common provenance carried on every event. */
export interface WatchProvenance {
  ts: string
  txid?: number
  actor?: string
  request?: string
  tenant?: string
  scope?: string
}

export interface RecordEvent extends WatchProvenance {
  type: 'record/insert' | 'record/update' | 'record/delete'
  record: string
  /**
   * Keyed by the plug's raw attribute names — **snake_case**, NOT
   * transformed to the client's keyFormat (unlike `/data` responses, which the
   * server cases per `key_format`). So `after['release_year']`, even when the
   * client is configured `keyFormat: 'kebab'` and `/data` returns `release-year`.
   */
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  /** Attribute-name list; computed by the SDK from before/after. */
  changed?: string[]
}

export interface RelationEvent extends WatchProvenance {
  type: 'relation/link' | 'relation/unlink'
  /** [subscribed-xid, other-xid] — position 0 is always your subscribed endpoint. */
  data: [string, string]
}

export type WatchSentinel =
  | { type: 'connection/resumed'; gap: [string | null, string | null] }
  | { type: 'schema/changed' }
  | { type: 'subscription/rejected'; reason: string; records: string[] }
  | { type: 'paused' }

export type WatchEvent = RecordEvent | RelationEvent | WatchSentinel

export interface Watch {
  readonly interest: WatchInterest
  readonly closed: boolean
  readonly events: AsyncIterable<WatchEvent>

  add(xids: string[]): void
  remove(xids: string[]): void
  setInterest(interest: WatchInterest): void

  /** Suppress the next event carrying this request-id. Auto-expires after ttlMs. */
  muteRequest(requestId: string, opts?: { ttlMs?: number }): void

  close(): void
}

export interface SchemaWatch {
  readonly events: AsyncIterable<{ type: 'schema/changed' }>
  close(): void
}

export class WatchError extends Error {
  code: string
  details?: unknown
  constructor(message: string, code: string, details?: unknown)
}

// ============================================================================
// Observe types — record-shaped envelope
// ============================================================================

export interface ObserveOpts {
  signal?: AbortSignal
  /** Stable subscription handle; defaults to a hash of the descriptor. */
  key?: string
  /** Replay /history events missed during disconnect (default: false). */
  backfill?: boolean
  /** Max rows per backfill pass (default: 1000). */
  backfillLimit?: number
}

/**
 * Common provenance fields carried on every delta envelope.
 */
export interface DeltaProvenance {
  /** ISO-8601 timestamp captured by the trigger when the underlying change happened. */
  ts: string
  /** Tenant scope xid (install-level boundary). */
  tenant?: string
  /** Scope xid (per-record access scope, if set). */
  scope?: string
  /** Actor xid (the user who triggered the change). */
  actor?: string
  /** Request-id from the actor's request, if propagated through the trigger. */
  request?: string
  /** DB transaction id — same across all envelopes from one multi-row tx. */
  txid?: number
  /** Set to `true` on events replayed from /history during reconnect. */
  fromBackfill?: boolean
}

/**
 * Record-track delta event. `before` is absent on `record/insert`;
 * `after` is absent on `record/delete`. The `before`/`after` maps are keyed by
 * the plug's raw attribute names — **snake_case**, NOT transformed to the
 * client's keyFormat (unlike `/data`, which cases keys per `key_format`). So
 * `after['release_year']` even under `keyFormat: 'kebab'`. Encrypted columns
 * carry their encrypted form; resolve via /data if you need decrypted values.
 */
export interface RecordDeltaEvent extends DeltaProvenance {
  type: 'record/insert' | 'record/update' | 'record/delete'
  'record-xid': string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}

/**
 * Relation-track delta event for a link/unlink between two entities.
 * `data` is a `[subscribed-xid, other-xid]` tuple — server has rotated
 * so position 0 is always the endpoint in your watched record set.
 * When the identity's union covers BOTH endpoints, the server emits
 * two events per link with rotated tuples (same `ts`/`txid`/provenance);
 * dedupe by `txid` + sorted-endpoints if you want one per underlying link.
 */
export interface RelationDeltaEvent extends DeltaProvenance {
  type: 'relation/link' | 'relation/unlink'
  data: [string, string]
}

/**
 * Coalesced cache-invalidation poke for an entity track subscription.
 * `entity` is the client's verbatim original string (server echoes back
 * exactly what was subscribed to, before any case/whitespace/separator
 * normalization).
 */
export interface EntityTouchedEvent {
  type: 'entity/touched'
  entity: string
  ts: string
}

/**
 * Coalesced cache-invalidation poke for a relation track subscription.
 * `relation` is the client's verbatim original string.
 */
export interface RelationTouchedEvent {
  type: 'relation/touched'
  relation: string
  ts: string
}

export type ObserveEvent =
  | RecordDeltaEvent
  | RelationDeltaEvent
  | EntityTouchedEvent
  | RelationTouchedEvent

// ============================================================================
// Operator helpers
// ============================================================================

export function eq(v: unknown): { _eq: unknown }
export function neq(v: unknown): { _neq: unknown }
export function gt(v: unknown): { _gt: unknown }
export function gte(v: unknown): { _ge: unknown }
export function lt(v: unknown): { _lt: unknown }
export function lte(v: unknown): { _le: unknown }
export function in_(...v: unknown[]): { _in: unknown[] }
export function nin(...v: unknown[]): { _nin: unknown[] }
export function like(v: string): { _like: string }
export function ilike(v: string): { _ilike: string }
export function isNull(): { _is_null: true }
export function isNotNull(): { _is_null: false }

export function and(...clauses: WhereClause[]): { _and: WhereClause[] }
export function or(...clauses: WhereClause[]): { _or: WhereClause[] }
export function not(clause: WhereClause): { _not: WhereClause }

// ============================================================================
// Selection helpers
// ============================================================================

/**
 * Build a relation config for use in a selection.
 *
 * Single:   { roles: rel({ name: null }, { _limit: 5 }) }
 * Multiple: { roles: [rel({ name: null }, w1, 'active'), rel({ name: null }, w2, 'archived')] }
 */
export function rel(selections: Selection, args?: Args, alias?: string): RelationConfig

// ============================================================================
// Operation builders
// ============================================================================

export const op: {
  search(entity: string, args: Args | undefined, selection: Selection): Operation
  get(entity: string, args: Record<string, unknown>, selection: Selection): Operation
  sync(entity: string, data: Record<string, unknown> | Record<string, unknown>[], returning?: boolean): Operation
  stack(entity: string, data: Record<string, unknown> | Record<string, unknown>[], returning?: boolean): Operation
  slice(entity: string, args: Record<string, unknown>, selection?: Selection): Operation
  delete(entity: string, data: Record<string, unknown>): Operation
  purge(entity: string, args: Args | undefined, selection?: Selection): Operation
  searchTree(entity: string, on: string, args: Args | undefined, selection: Selection): Operation
  getTree(entity: string, root: string, on: string, selection: Selection): Operation
  sqlTemplate(template: string, params?: Record<string, unknown> | unknown[], opts?: { cached?: boolean }): Operation
  /** An XSQL read, for `exec` batches; `verb` names the op a bare body runs as (default `search`). */
  query(xsql: string, params?: Record<string, unknown>, verb?: string): Operation
  deployedModel(): Operation
  runtimeModel(): Operation
  whoami(): Operation
  deploy(exportContents: string): Operation
  destroy(datasetXid: string): Operation
}

// ============================================================================
// Tree composition
// ============================================================================

export interface ComposeTreeOpts {
  /** Name of the tree (self-FK) relation, e.g. "father", "parent" */
  on: string
  /** Root record id; defaults to the first record */
  rootId?: string
  /** Key under which children are nested (default: "_children") */
  childrenKey?: string
}

export interface ComposeForestOpts {
  on: string
  /** Key under which children are nested (default: "_children") */
  childrenKey?: string
}

export function composeTree<T extends Record<string, unknown>>(
  records: T[],
  opts: ComposeTreeOpts,
): (T & { [key: string]: unknown }) | null

export function composeForest<T extends Record<string, unknown>>(
  records: T[],
  opts: ComposeForestOpts,
): (T & { [key: string]: unknown })[]

// ============================================================================
// Factory
// ============================================================================

export function createClient(config?: ClientConfig): SynthigyClient

// ============================================================================
// Single-client layer — connect once, call the bare verbs, no client threading.
// One process, one client; multiplex identity per-call with opts.actingAs.
// Verb types are derived from SynthigyClient so they never drift.
// ============================================================================

/** Install a module-wide default client (destroys any previous one). */
export function connect(config?: ClientConfig): SynthigyClient
/** Destroy and uninstall the default client. No-op when not connected. */
export function disconnect(): void
/** The default client installed by `connect`, or null. */
export function getClient(): SynthigyClient | null

/**
 * A fresh 22-char Base58 xid — client-minted identity for sync/stack, the same
 * derivation the server uses. Mint one before a write to know a record's id up
 * front, or to make a retried write idempotent.
 */
export function newXid(): string

export const search: SynthigyClient['search']
export const get: SynthigyClient['get']
export const sync: SynthigyClient['sync']
export const stack: SynthigyClient['stack']
export const slice: SynthigyClient['slice']
export const purge: SynthigyClient['purge']
export const sqlTemplate: SynthigyClient['sqlTemplate']
export const query: SynthigyClient['query']
export const searchTree: SynthigyClient['searchTree']
export const getTree: SynthigyClient['getTree']
export const exec: SynthigyClient['exec']
declare const _delete: SynthigyClient['delete']
export { _delete as delete }

export const schema: SynthigyClient['schema']
export const lint: SynthigyClient['lint']
export const compile: SynthigyClient['compile']
export const onboard: SynthigyClient['onboard']
export const onboardComplete: SynthigyClient['onboardComplete']
export const deploy: SynthigyClient['deploy']
export const destroy: SynthigyClient['destroy']
export const deployedModel: SynthigyClient['deployedModel']
export const whoami: SynthigyClient['whoami']
export const runtimeModel: SynthigyClient['runtimeModel']
export const token: SynthigyClient['token']
export function history(): SynthigyClient['history']
export function files(): SynthigyClient['files']
export function login(): SynthigyClient['login']

export const listen: SynthigyClient['listen']
export const observe: SynthigyClient['observe']
export const watch: SynthigyClient['watch']
export const watchSchema: SynthigyClient['watchSchema']
export const watchQuery: SynthigyClient['watchQuery']
export const watchSqlTemplate: SynthigyClient['watchSqlTemplate']

export const subscribe: SynthigyClient['subscribe']
export const unsubscribe: SynthigyClient['unsubscribe']
export const subscribeModel: SynthigyClient['subscribeModel']
export const unsubscribeModel: SynthigyClient['unsubscribeModel']
export const setSubscriptions: SynthigyClient['setSubscriptions']
export const clearSubscriptions: SynthigyClient['clearSubscriptions']
export const subscriptions: SynthigyClient['subscriptions']
