/**
 * Live files suite: three client-credentials clients (File Admin, File User,
 * File Reader) walk folders, sharing, uploads, ranges, versions, links and
 * refusals against a running engine. Run it via `npm run test:files`.
 *
 * Env vars (the suite skips when the endpoint is unset, and under `npm test`):
 *   SYNTHIGY_FILES_TEST_ENDPOINT
 *   SYNTHIGY_FILES_TEST_ADMIN_ID   SYNTHIGY_FILES_TEST_ADMIN_SECRET
 *   SYNTHIGY_FILES_TEST_USER_ID    SYNTHIGY_FILES_TEST_USER_SECRET
 *   SYNTHIGY_FILES_TEST_READER_ID  SYNTHIGY_FILES_TEST_READER_SECRET
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, SynthigyError } from '../src/index.js'

const env = process.env
const ENDPOINT = env.SYNTHIGY_FILES_TEST_ENDPOINT
const skip = !ENDPOINT
  ? 'Set SYNTHIGY_FILES_TEST_ENDPOINT and the ADMIN/USER/READER client ids and secrets'
  : env.npm_lifecycle_event === 'test' ? 'live suite: run it with npm run test:files' : false

const RUN = `sdkjs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const BIN = new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x80, 0x00, 0xfe, 0xff, 0x10, 0x20])
const BAD_JSON = new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])
const NEXT = new Uint8Array([0xff, 0x00, 0xaa, 0x55, 0x00])

const bytesOf = async (blobOrBuf) => new Uint8Array(blobOrBuf instanceof ArrayBuffer ? blobOrBuf : await blobOrBuf.arrayBuffer())
const xidsOf = (list) => (list ?? []).map((u) => (typeof u === 'string' ? u : u.xid))

async function rejectsCode(promise, code, category) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof SynthigyError, `expected SynthigyError, got ${err}`)
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`)
    if (category) assert.equal(err.category, category)
    return true
  })
}

describe('files live', { skip }, () => {
  let admin, user, reader
  let userXid, readerXid
  let bin, json, note, loose
  const top = `/F-${RUN}/`
  const created = []

  before(() => {
    const mk = (role) => createClient({
      endpoint: ENDPOINT,
      clientId: env[`SYNTHIGY_FILES_TEST_${role}_ID`],
      clientSecret: env[`SYNTHIGY_FILES_TEST_${role}_SECRET`],
    })
    admin = mk('ADMIN'); user = mk('USER'); reader = mk('READER')
  })

  after(async () => {
    const quiet = (p) => p.catch(() => {})
    for (const f of [bin, json, note, loose]) if (f) await quiet(admin.files.delete(f.xid))
    for (const path of [...created].reverse()) await quiet(admin.files.delete(path))
  })

  describe('1. admin makes the top folder and shares it', () => {
    it('folder, share, access', async () => {
      const F = await admin.files.folder(top)
      created.push(top)
      assert.equal(F.path, top)
      userXid = (await user.whoami()).xid
      readerXid = (await reader.whoami()).xid
      for (const access of ['write', 'read', 'delete']) await admin.files.share(top, access, { users: [userXid] })
      await admin.files.share(top, 'read', { users: [readerXid] })
      const acl = await admin.files.access(top)
      for (const access of ['write', 'read', 'delete']) assert.ok(xidsOf(acl[access].users).includes(userXid), access)
      assert.ok(xidsOf(acl.read.users).includes(readerXid))
      assert.ok(!xidsOf(acl.write.users).includes(readerXid))
    })
  })

  describe('2. user puts, replaces and versions', () => {
    it('put by path, byte-exact; a second put replaces the same file', async () => {
      bin = await user.files.put(`${top}bin-${RUN}.bin`, BIN)
      assert.equal(bin.size, BIN.length)
      assert.deepEqual(await bytesOf(await user.files.download(`${top}bin-${RUN}.bin`)), BIN)
      const next = await user.files.put(`${top}bin-${RUN}.bin`, NEXT)
      assert.equal(next.xid, bin.xid)
      assert.notEqual(next.hash, bin.hash)
      await rejectsCode(user.files.put(bin, BIN, { ifMatch: '0'.repeat(64) }), 'FILE_CHANGED', 'conflict')
      await rejectsCode(user.files.put(`${top}nope/x.bin`, BIN), 'FOLDER_NOT_FOUND', 'not_found')
      await rejectsCode(user.files.put(`${top}a\\b`, BIN), 'INVALID_NAME', 'validation')
    })

    it('versions, an old download, restore', async () => {
      let vs = []
      for (let t = Date.now(); Date.now() - t < 30000; await new Promise((r) => setTimeout(r, 500))) {
        vs = await user.files.versions(`${top}bin-${RUN}.bin`)
        if (vs.length >= 2) break
      }
      assert.equal(vs.length, 2)
      assert.equal(vs[0].current, true)
      assert.equal(vs[1].hash, bin.hash)
      assert.deepEqual(await bytesOf(await user.files.download(bin.xid, { version: vs[1], as: 'arrayBuffer' })), BIN)
      assert.equal((await user.files.restore(bin, vs[1])).hash, bin.hash)
      assert.deepEqual(await bytesOf(await user.files.download(bin)), BIN)
    })

    it('json byte-exact, info by path and xid, list and search', async () => {
      json = await user.files.put(`${top}bad-${RUN}.json`, BAD_JSON, { contentType: 'application/json' })
      assert.deepEqual(await bytesOf(await user.files.download(json, { as: 'arrayBuffer' })), BAD_JSON)
      assert.equal((await user.files.info(`${top}bin-${RUN}.bin`)).xid, bin.xid)
      assert.equal((await user.files.info(bin.xid)).folder?.path, top)
      assert.equal(await user.files.info(`${top}missing.bin`), null)
      const { files, folders } = await user.files.list(top)
      assert.deepEqual(new Set(files.map((f) => f.xid)), new Set([bin.xid, json.xid]))
      assert.deepEqual(folders, [])
      assert.deepEqual((await user.files.list(undefined, { q: `bin-${RUN}` })).files.map((f) => f.xid), [bin.xid])
    })

    it('a file in no folder, by name; a second one is another file', async () => {
      loose = await user.files.put({ name: `loose-${RUN}.txt` }, 'loose')
      assert.equal(loose.folder ?? null, null)
      const twin = await user.files.put({ name: `loose-${RUN}.txt` }, 'twin')
      assert.notEqual(twin.xid, loose.xid)
      await user.files.delete(twin.xid)
      assert.deepEqual((await user.files.list(null, { q: `loose-${RUN}` })).files.map((f) => f.xid), [loose.xid])
    })
  })

  describe('3. user folders and moves', () => {
    it('folder, move a folder, move a file in and out, refusals', async () => {
      await user.files.folder(`${top}sub/`)
      created.push(`${top}sub/`)
      const renamed = await user.files.move(`${top}sub/`, `${top}sub2/`)
      created.push(`${top}sub2/`)
      assert.equal(renamed.path, `${top}sub2/`)
      assert.deepEqual((await user.files.list(top)).folders.map((f) => f.path), [`${top}sub2/`])
      assert.equal((await user.files.move(bin, `${top}sub2/`)).folder?.path, `${top}sub2/`)
      assert.equal((await user.files.move(`${top}sub2/bin-${RUN}.bin`, top)).folder?.path, top)
      await rejectsCode(user.files.move(`${top}sub2/`, `/sub2-${RUN}/`), 'FORBIDDEN', 'iam')
      await rejectsCode(user.files.delete(top), 'FOLDER_NOT_EMPTY', 'conflict')
    })
  })

  describe('3b. search and list q', () => {
    it('words in order across paths, shortest first, folder scope, pages', async () => {
      const hit = await user.files.search(`F-${RUN} sub2`)
      assert.deepEqual(hit.results.map((r) => [r.type, r.path]), [['folder', `${top}sub2/`]])
      assert.equal(hit.truncated, false)
      const file = await user.files.search(`${RUN} bin`)
      assert.deepEqual(file.results.map((r) => [r.type, r.xid, r.path]), [['file', bin.xid, `${top}bin-${RUN}.bin`]])
      assert.equal(file.results[0].hash, (await user.files.info(bin)).hash)
      assert.deepEqual((await user.files.search(`.bin F-${RUN}`)).results, [], 'order matters')
      const all = (await user.files.search(`F-${RUN}`)).results
      assert.ok(all.length >= 4)
      assert.deepEqual(all[0].path, top)
      const lengths = all.map((r) => r.path.length)
      assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b))
      const paged = []
      for (let offset = 0, more = true; more; offset += 2) {
        const page = await user.files.search(`F-${RUN}`, { limit: 2, offset })
        paged.push(...page.results)
        more = page.truncated
      }
      assert.deepEqual(paged.map((r) => r.xid), all.map((r) => r.xid))
      assert.deepEqual((await user.files.search('sub2', { folder: top })).results.map((r) => r.path), [`${top}sub2/`])
    })

    it('a file in no folder has no path; % and _ are plain; a space is anything between', async () => {
      assert.deepEqual((await user.files.search(`loose-${RUN}`)).results.map((r) => [r.xid, r.path]), [[loose.xid, null]])
      assert.deepEqual((await reader.files.search(`loose-${RUN}`)).results, [], 'not shared with the reader')
      assert.deepEqual((await user.files.search(`F-${RUN} %`)).results, [])
      assert.deepEqual((await user.files.list(top, { q: '%' })).files, [])
      assert.deepEqual((await user.files.list(top, { q: `bin ${RUN.slice(-6)}` })).files.map((f) => f.xid), [bin.xid])
      assert.deepEqual((await user.files.list(top, { q: 'sub' })).folders.map((f) => f.path), [`${top}sub2/`])
      await rejectsCode(user.files.search('  '), 'INVALID_QUERY', 'validation')
    })
  })

  describe('4. reader', () => {
    it('sees and downloads, may not write', async () => {
      const seen = (await reader.files.list('/')).folders.find((f) => f.path === top)
      assert.ok(seen, 'reader lists the top folder')
      assert.equal(seen.writable, false)
      assert.deepEqual(await bytesOf(await reader.files.download(bin.xid)), BIN)
      assert.equal(await reader.files.info(loose.xid), null)
      await rejectsCode(reader.files.put(`${top}r-${RUN}.bin`, BIN), 'FORBIDDEN', 'iam')
      await rejectsCode(reader.files.put(bin, NEXT), 'FORBIDDEN', 'iam')
      await rejectsCode(reader.files.folder(`${top}r-${RUN}/`), 'FORBIDDEN', 'iam')
    })
  })

  describe('5. links for browsers', () => {
    it('a public folder: url without a token, path or xid; inline; Cache', async () => {
      note = await user.files.put(`${top}note-${RUN}.txt`, 'hello')
      assert.equal((await fetch(user.files.url(note))).status, 401)
      await rejectsCode(user.files.folder(top, { public: true }), 'ATTRIBUTE_FORBIDDEN', 'iam')
      await user.files.folder(top, { cache: 120 })
      const shown = await admin.files.folder(top, { public: true })
      assert.deepEqual([shown.public, shown.cache, shown.settings], [true, 120, { public: true, cache: 120, can_link: null }])
      assert.equal((await user.files.info(note)).public, true)
      for (const url of [user.files.url(note), user.files.url(`${top}note-${RUN}.txt`)]) {
        const resp = await fetch(url)
        assert.equal(resp.status, 200, url)
        assert.equal(resp.headers.get('cache-control'), 'public, max-age=120')
        assert.equal(resp.headers.get('access-control-allow-origin'), '*')
        assert.equal(await resp.text(), 'hello')
      }
      const inline = await fetch(user.files.url(note, { inline: true }))
      assert.match(inline.headers.get('content-disposition'), /^inline/)
    })

    it('a folder without its own Public inherits it; its own false wins', async () => {
      const inner = await admin.files.folder(`${top}inner/`)
      created.push(`${top}inner/`)
      assert.deepEqual([inner.public, inner.settings.public], [true, null])
      const secret = await user.files.put(`${top}inner/secret-${RUN}.txt`, 'secret')
      assert.equal((await fetch(user.files.url(secret))).status, 200)
      await admin.files.folder(`${top}inner/`, { public: false })
      assert.equal((await fetch(user.files.url(secret))).status, 401)
      await admin.files.folder(`${top}inner/`, { public: null })
      assert.equal((await fetch(user.files.url(secret))).status, 200)
      await user.files.delete(secret)
      await admin.files.delete(`${top}inner/`)
      created.splice(created.indexOf(`${top}inner/`), 1)
    })

    it('serve passes a range through; objectUrl gives a blob: URL', async () => {
      const out = await user.files.serve(`${top}note-${RUN}.txt`, new Request('http://bff/x', { headers: { range: 'bytes=0-1' } }))
      assert.equal(out.status, 206)
      assert.equal(await out.text(), 'he')
      const missing = await user.files.serve(`${top}gone-${RUN}.txt`)
      assert.equal(missing.status, 404)
      const { url, revoke } = await user.files.objectUrl(note)
      assert.match(url, /^blob:/)
      revoke()
    })
  })

  describe('5b. download links', () => {
    it('off by default; File Admin switches them on; a link works without a token', async () => {
      const shut = await user.files.put(`${top}link-${RUN}.txt`, 'linked')
      await admin.files.folder(top, { public: false })
      await rejectsCode(user.files.link(shut), 'LINKS_DISABLED', 'iam')
      await rejectsCode(user.files.folder(top, { canLink: true }), 'ATTRIBUTE_FORBIDDEN', 'iam')
      const shown = await admin.files.folder(top, { canLink: true })
      assert.equal(shown.can_link, true)
      await rejectsCode(reader.files.link(shut), 'FORBIDDEN', 'iam')
      await rejectsCode(user.files.link(shut, { expires: 0 }), 'INVALID_EXPIRES', 'validation')

      const link = await user.files.link(shut, { expires: 600 })
      assert.equal(link.file, shut.xid)
      assert.equal(link.created_by, userXid)
      assert.equal(link.downloads, 0)
      const got = await fetch(link.url)
      assert.equal(got.status, 200)
      assert.equal(got.headers.get('referrer-policy'), 'no-referrer')
      assert.equal(await got.text(), 'linked')

      const once = await user.files.link(shut, { maxDownloads: 1, inline: true })
      const first = await fetch(once.url, { headers: { range: 'bytes=1-2' } })
      assert.equal(first.status, 200, 'a limited link ignores Range')
      assert.match(first.headers.get('content-disposition'), /^inline/)
      assert.equal(await first.text(), 'linked')
      assert.equal((await fetch(once.url)).status, 404, 'used up')

      const camel = createClient({ endpoint: ENDPOINT, clientId: env.SYNTHIGY_FILES_TEST_USER_ID,
        clientSecret: env.SYNTHIGY_FILES_TEST_USER_SECRET, keyFormat: 'camel' })
      const [seen] = (await camel.files.links(shut)).filter((l) => l.xid === link.xid)
      assert.deepEqual([seen.createdBy, seen.maxDownloads, 'created_by' in seen], [userXid, null, false], 'keyFormat camel')
      assert.equal((await camel.files.info(shut)).contentType, (await user.files.info(shut)).content_type)
      const mine = await user.files.links(shut)
      assert.ok(mine.some((l) => l.xid === link.xid))
      assert.ok(mine.every((l) => !('url' in l)), 'the url is shown once')
      assert.equal(mine.find((l) => l.xid === link.xid).downloads, 1)
      const admins = await admin.files.link(shut)
      assert.ok(!(await user.files.links(shut)).some((l) => l.xid === admins.xid), 'File User sees its own')
      assert.ok((await admin.files.links(shut)).some((l) => l.xid === link.xid), 'File Admin sees all')
      await rejectsCode(user.files.unlink(admins.xid), 'LINK_NOT_FOUND', 'not_found')

      await admin.files.folder(top, { canLink: false })
      assert.equal((await fetch(link.url)).status, 404, 'switched off: existing links stop')
      await admin.files.folder(top, { canLink: true })
      assert.equal((await fetch(link.url)).status, 200)
      await user.files.unlink(link)
      assert.equal((await fetch(link.url)).status, 404, 'unlinked: gone at once')
      await user.files.delete(shut)
      assert.equal((await fetch(admins.url)).status, 404, 'file deleted: its links die')
      await admin.files.folder(top, { public: true, canLink: null })
    })
  })

  describe('6. admin moves the subfolder to ROOT and deletes it', () => {
    it('moves and deletes', async () => {
      const moved = await admin.files.move(`${top}sub2/`, `/sub2-${RUN}/`)
      assert.equal(moved.path, `/sub2-${RUN}/`)
      await admin.files.delete(`/sub2-${RUN}/`)
    })
  })

  describe('7. cleanup', () => {
    it('deletes files and the top folder', async () => {
      for (const f of [bin, json, note, loose]) {
        await user.files.delete(f.xid)
        assert.equal(await user.files.info(f.xid), null)
      }
      bin = json = note = loose = null
      await admin.files.delete(top)
      assert.deepEqual((await admin.files.list('/', { q: `F-${RUN}` })).folders, [])
      created.length = 0
    })
  })
})
