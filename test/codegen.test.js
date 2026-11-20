import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Generates offline from a saved IR + schema (no server), through the
// generator's own tsc gate, and checks the emitted surface.
const here = path.dirname(fileURLToPath(import.meta.url))

function generateTo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'synthigy-gen-'))
  cpSync(path.join(here, 'fixtures', 'codegen'), path.join(dir, 'xsql'), { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SYNTHIGY_')))
  execFileSync(process.execPath, [path.join(here, '..', 'codegen', 'codegen.mjs'),
    path.join(dir, 'xsql'), path.join(dir, 'generated')], { env, stdio: 'pipe' })
  return path.join(dir, 'generated')
}

function generate() {
  return readFileSync(path.join(generateTo(), 'ops.ts'), 'utf8')
}

async function importGenerated() {
  const ts = (await import('typescript')).default
  const dir = generateTo()
  const { outputText } = ts.transpileModule(readFileSync(path.join(dir, 'ops.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  writeFileSync(path.join(dir, 'ops.mjs'), outputText)
  return import(pathToFileURL(path.join(dir, 'ops.mjs')).href)
}

describe('codegen', () => {
  it('emits @batch as one typed exec, a member error as a value', () => {
    const ops = generate()
    assert.match(ops, /export async function overview\(params\?: OverviewBatchParams, opts\?: ExecOpts\): Promise<OverviewBatch>/)
    assert.match(ops, /"list": MovieList\[\] \| SynthigyError/)
    assert.match(ops, /"stats": DashboardStats\[\] \| SynthigyError/)
    assert.match(ops, /const r = await _client\.exec\(\[\n    op\.query\(`@search list\n/)
    assert.match(ops, /op\.sqlTemplate\(`/)
    assert.match(ops, /import \{ connect, op, SynthigyError \} from/)
  })

  it('a failed @batch member keeps the server error fields, doc, rule and attribute included', async () => {
    const gen = await importGenerated()
    const { SynthigyError, disconnect } = await import('../src/index.js')
    const error = { message: "'modified_by' is set by the system on Movie", code: 'ATTRIBUTE_FORBIDDEN',
                    hint: 'leave it out of data', rule: 'stamp', doc: 'errors/stamp', attribute: 'modified_by' }
    gen.configure({ endpoint: 'http://localhost', token: 't',
      fetch: async () => new Response(JSON.stringify({ results: [{ ok: false, error }, { ok: true, data: [] }] })) })
    try {
      const { list, stats } = await gen.overview()
      assert.ok(list instanceof SynthigyError)
      assert.deepEqual([list.code, list.hint, list.rule, list.doc, list.attribute],
        ['ATTRIBUTE_FORBIDDEN', 'leave it out of data', 'stamp', 'errors/stamp', 'modified_by'])
      assert.deepEqual(stats, [])
    } finally {
      disconnect()
    }
  })

  it('types operations from the IR, outside the entity Pick and the Sel', () => {
    const ops = generate()
    assert.match(ops, /export type MovieList = Pick<_Movie, "xid" \| "title" \| "release_year"> & \{/)
    assert.match(ops, /\n  votes: number\n  cast_size: number\n  rating: number \| null\n/)
    const sel = ops.slice(ops.indexOf('export const MovieListSel'), ops.indexOf('} as const'))
    assert.doesNotMatch(sel, /votes|rating/)
  })

  it('types @purge as rows and @slice as a relation → boolean map', () => {
    const ops = generate()
    assert.match(ops, /stale\(params: MovieStaleParams, opts\?: ExecOpts\): Promise<MovieStale\[\]>/)
    assert.match(ops, /export type MovieUncast = Record<string, boolean>\n/)
    assert.doesNotMatch(ops, /MovieUncastSel/)
    assert.match(ops, /uncast\(params: MovieUncastParams, opts\?: ExecOpts\): Promise<MovieUncast> \{\n    return _client\.query<MovieUncast>\(`@slice uncast\n/)
    assert.match(ops, /"uncast": MovieUncast \| SynthigyError\n  "stale": MovieStale\[\] \| SynthigyError/)
  })

  it('a null @slice result decodes as an empty map, alone and in a @batch', async () => {
    const gen = await importGenerated()
    const { disconnect } = await import('../src/index.js')
    const results = [[{ ok: true, data: null }], [{ ok: true, data: null }, { ok: true, data: null }]]
    gen.configure({ endpoint: 'http://localhost', token: 't',
      fetch: async () => new Response(JSON.stringify({ results: results.shift() })) })
    try {
      assert.deepEqual(await gen.Movie.uncast({ xid: 'x' }), {})
      assert.deepEqual(await gen.cleanup({ xid: 'x', before: 1990 }), { uncast: {}, stale: [] })
    } finally {
      disconnect()
    }
  })
})

describe('warnStaleSchema', () => {
  it('warns only when the deploy stamp moved', async () => {
    const { createServer } = await import('node:http')
    const { writeFileSync } = await import('node:fs')
    const { warnStaleSchema } = await import('../codegen/lib.mjs')
    const srv = createServer((_, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{"datasets":{"A":"2026-09-15T09:47:15.698+02:00","B":"2026-10-01T00:00:00Z"}}')
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const endpoint = `http://127.0.0.1:${srv.address().port}`
    const schema = path.join(mkdtempSync(path.join(tmpdir(), 'synthigy-stale-')), 'schema.json')
    const run = async (ep) => { const out = []; await warnStaleSchema(ep, schema, (s) => out.push(s)); return out.join('') }
    try {
      writeFileSync(schema, '{"datasets":{"A":{"deployed-at":"2026-09-15T07:47:15.698Z"},"B":{"deployed-at":"2026-10-01T00:00:00Z"}}}')
      assert.equal(await run(endpoint), '')
      writeFileSync(schema, '{"datasets":{"A":{"deployed-at":"2026-09-15T07:47:15.698Z"}}}')
      assert.match(await run(endpoint), /stale/)
      assert.equal(await run(undefined), '')
    } finally {
      srv.close()
    }
  })
})

describe('describe failures', () => {
  it('print the code, position, hint and manual section the engine sent', async () => {
    const { createServer } = await import('node:http')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url !== '/data') { res.statusCode = 404; res.end('{}'); return }
      res.end(JSON.stringify({ results: [{ ok: false, error: {
        code: 'XSQL_PARSE_ERROR', message: 'bad token', line: 3, col: 5,
        hint: 'close the brace', doc: 'errors/xsql_parse' } }] }))
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const endpoint = `http://127.0.0.1:${srv.address().port}`
    const dir = mkdtempSync(path.join(tmpdir(), 'synthigy-describe-'))
    cpSync(path.join(here, 'fixtures', 'codegen'), path.join(dir, 'xsql'), { recursive: true })
    const src = path.join(dir, 'xsql', 'example.xsql')
    writeFileSync(src, readFileSync(src, 'utf8') + '\n')
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SYNTHIGY_'))),
      SYNTHIGY_ENDPOINT: endpoint }
    try {
      await assert.rejects(
        promisify(execFile)(process.execPath, [path.join(here, '..', 'codegen', 'codegen.mjs'),
          path.join(dir, 'xsql'), path.join(dir, 'generated')], { env }),
        (e) => {
          assert.ok(e.stderr.includes(['describe failed: XSQL_PARSE_ERROR: bad token',
            '  at line 3, col 5', '  hint: close the brace',
            `  docs: ${endpoint}/docs/errors/xsql_parse`].join('\n')), e.stderr)
          return true
        })
    } finally {
      srv.close()
    }
  })
})
