import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Generates offline from a saved IR + schema (no server), through the
// generator's own tsc gate, and checks the emitted surface.
const here = path.dirname(fileURLToPath(import.meta.url))

function generate() {
  const dir = mkdtempSync(path.join(tmpdir(), 'synthigy-gen-'))
  cpSync(path.join(here, 'fixtures', 'codegen'), path.join(dir, 'xsql'), { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SYNTHIGY_')))
  execFileSync(process.execPath, [path.join(here, '..', 'codegen', 'codegen.mjs'),
    path.join(dir, 'xsql'), path.join(dir, 'generated')], { env, stdio: 'pipe' })
  return readFileSync(path.join(dir, 'generated', 'ops.ts'), 'utf8')
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

  it('types operations from the IR, outside the entity Pick and the Sel', () => {
    const ops = generate()
    assert.match(ops, /export type MovieList = Pick<_Movie, "xid" \| "title" \| "release_year"> & \{/)
    assert.match(ops, /\n  votes: number\n  cast_size: number\n  rating: number \| null\n/)
    const sel = ops.slice(ops.indexOf('export const MovieListSel'), ops.indexOf('} as const'))
    assert.doesNotMatch(sel, /votes|rating/)
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
