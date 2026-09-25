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
})
