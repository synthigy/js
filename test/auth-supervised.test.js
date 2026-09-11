import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

// Contract test for the supervised-stdio token source — spawns the SDK's
// own process (via `node --input-type=module -e <script>`, ESM inline
// eval) under a stub parent speaking `auth.token`, per
// docs/plans/PLAN-EXEC-IDENTITY.md steps 3-4. The child writes its result
// to STDERR as one JSON line so the test's own bookkeeping never collides
// with the protocol channel it's exercising — stdout is exclusively
// `auth.token` frames.

const SDK_ROOT = fileURLToPath(new URL('..', import.meta.url))

function spawnChild(script, extraEnv = {}) {
  const env = { ...process.env, SYNTHIGY_SUPERVISED: '1' }
  delete env.SYNTHIGY_TOKEN
  delete env.SYNTHIGY_CLIENT_ID
  delete env.SYNTHIGY_CLIENT_SECRET
  Object.assign(env, extraEnv)
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: SDK_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdoutLines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  child.stderrLines = createInterface({ input: child.stderr })[Symbol.asyncIterator]()
  return child
}

async function nextLine(it) {
  const { value, done } = await it.next()
  return done ? null : value
}

function writeLine(child, s) {
  child.stdin.write(s + '\n')
}

async function readResult(child) {
  const line = await nextLine(child.stderrLines)
  assert.ok(line, 'child never wrote a result to stderr')
  return JSON.parse(line)
}

async function readFrame(child) {
  const line = await nextLine(child.stdoutLines)
  assert.ok(line, 'child never wrote a frame to stdout')
  return JSON.parse(line)
}

function finish(child) {
  child.stdin.end()
  return new Promise((resolve) => child.once('close', resolve))
}

const CHILD_ASK_ONCE = `
import { createClient } from './src/index.js'
const client = createClient({ endpoint: 'http://unused.invalid' })
try {
  const token = await client.token()
  process.stderr.write(JSON.stringify({ ok: true, token }) + '\\n')
} catch (e) {
  process.stderr.write(JSON.stringify({ ok: false, error: e.message, code: e.code }) + '\\n')
}
`

describe('supervised stdio auth', () => {
  it('asks and receives a token', async () => {
    const child = spawnChild(CHILD_ASK_ONCE)
    const frame = await readFrame(child)
    assert.equal(frame.jsonrpc, '2.0')
    assert.equal(frame.method, 'auth.token')
    assert.ok(frame.id)

    writeLine(child, JSON.stringify({
      jsonrpc: '2.0', id: frame.id,
      result: { token: 'supervised-token-abc', expires_in: 300 },
    }))

    const result = await readResult(child)
    await finish(child)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.token, 'supervised-token-abc')
  })

  it('ignores stray and mismatched-id lines', async () => {
    // Non-frame noise and a response for a DIFFERENT request id on the
    // same stdin must not corrupt dispatch of the real response.
    const child = spawnChild(CHILD_ASK_ONCE)
    const frame = await readFrame(child)

    writeLine(child, 'not json at all')
    writeLine(child, JSON.stringify({
      jsonrpc: '2.0', id: frame.id + 999, result: { token: 'wrong-request' },
    }))
    writeLine(child, JSON.stringify({
      jsonrpc: '2.0', id: frame.id,
      result: { token: 'right-token', expires_in: 300 },
    }))

    const result = await readResult(child)
    await finish(child)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.token, 'right-token')
  })

  it('falls through to the teaching throw on timeout', { timeout: 10000 }, async () => {
    // A hung or missing parent must not hang the bot — see step 3.
    const child = spawnChild(CHILD_ASK_ONCE)
    await readFrame(child)
    // Never respond — the SDK's ~5s ask timeout fires.
    const result = await readResult(child)
    await finish(child)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_TOKEN')
  })

  it('the pipe beats the env token when supervised', async () => {
    // SYNTHIGY_TOKEN in env AND SYNTHIGY_SUPERVISED=1: the pipe wins —
    // exec injects the cached env token and supervises, and only the
    // pipe can refresh mid-run (the env value is a frozen snapshot).
    const child = spawnChild(CHILD_ASK_ONCE, { SYNTHIGY_TOKEN: 'stale-env-snapshot' })
    const frame = await readFrame(child)
    assert.equal(frame.method, 'auth.token',
      'supervised child must ask the pipe even with SYNTHIGY_TOKEN set')
    writeLine(child, JSON.stringify({
      jsonrpc: '2.0', id: frame.id,
      result: { token: 'fresh-pipe-token', expires_in: 300 },
    }))
    const result = await readResult(child)
    await finish(child)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.token, 'fresh-pipe-token')
  })

  it('a malformed line does not kill the reader', async () => {
    // A garbage line between two independent asks must not take the
    // background dispatcher down with it — the second ask still has to
    // work, or every future request in this process hangs forever.
    const CHILD_ASK_TWICE = `
import { createClient } from './src/index.js'
const client = createClient({ endpoint: 'http://unused.invalid' })
try {
  const t1 = await client.token({ audience: 'aud-a' })
  const t2 = await client.token({ audience: 'aud-b' })
  process.stderr.write(JSON.stringify({ ok: true, tokens: [t1, t2] }) + '\\n')
} catch (e) {
  process.stderr.write(JSON.stringify({ ok: false, error: e.message, code: e.code }) + '\\n')
}
`
    const child = spawnChild(CHILD_ASK_TWICE)
    const frame1 = await readFrame(child)

    writeLine(child, '\xff not even valid json {')
    writeLine(child, '{ this looks like a frame but isn\'t valid json')
    writeLine(child, JSON.stringify({
      jsonrpc: '2.0', id: frame1.id,
      result: { token: 'first-token', expires_in: 300 },
    }))

    const frame2 = await readFrame(child)
    assert.notEqual(frame2.id, frame1.id)
    writeLine(child, JSON.stringify({
      jsonrpc: '2.0', id: frame2.id,
      result: { token: 'second-token', expires_in: 300 },
    }))

    const result = await readResult(child)
    await finish(child)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.tokens, ['first-token', 'second-token'])
  })

  it('a full 401 -> clear -> reask -> retry lifecycle drives the real SDK', async () => {
    // The full lifecycle a real bot exercises: ask, use, get 401 (token
    // was revoked/invalid despite our clock saying it's fresh), clear,
    // ask again, retry succeeds with the NEW token — proving
    // SupervisedTokenSource.clear() is actually wired into the SDK's
    // EXISTING 401 clear+retry-once path, not just present.
    const authHeaders = []
    const server = createServer((req, res) => {
      authHeaders.push(req.headers.authorization)
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        if (authHeaders.length === 1) {
          res.writeHead(401)
          res.end(JSON.stringify({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }))
        } else {
          res.writeHead(200)
          res.end(JSON.stringify({ results: [{ ok: true, data: [] }] }))
        }
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const endpoint = `http://127.0.0.1:${port}`

    const CHILD_SEARCH_ONCE = `
import { createClient } from './src/index.js'
const client = createClient({ endpoint: ${JSON.stringify(endpoint)} })
try {
  await client.search('user', null, { x: null })
  process.stderr.write(JSON.stringify({ ok: true }) + '\\n')
} catch (e) {
  process.stderr.write(JSON.stringify({ ok: false, error: e.message, code: e.code }) + '\\n')
}
`
    const child = spawnChild(CHILD_SEARCH_ONCE)
    try {
      const frame1 = await readFrame(child)
      writeLine(child, JSON.stringify({
        jsonrpc: '2.0', id: frame1.id,
        result: { token: 'stale-token', expires_in: 300 },
      }))

      const frame2 = await readFrame(child)
      assert.notEqual(frame2.id, frame1.id, 'the 401 must trigger a SECOND, independent ask')
      writeLine(child, JSON.stringify({
        jsonrpc: '2.0', id: frame2.id,
        result: { token: 'fresh-token', expires_in: 300 },
      }))

      const result = await readResult(child)
      await finish(child)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.deepEqual(authHeaders, ['Bearer stale-token', 'Bearer fresh-token'])
    } finally {
      server.close()
    }
  })
})
