import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, SynthigyError } from '../src/index.js'

const calls = []
let responses = []

function respond(status, body, headers = {}) {
  const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text,
    blob: async () => new Blob([text]),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    body: text,
  }
}

function client(extra = {}) {
  return createClient({
    endpoint: 'http://files.test',
    token: 'tok',
    ...extra,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return responses.shift()
    },
  })
}

const X = 'X'.repeat(22)
const F = 'F'.repeat(22)
const info = { xid: X, name: 'a.txt', size: 3, hash: 'abc', status: 'READY', folder: null, public: false }
const notFound = (code) => respond(404, { error: { code, message: 'not there' } })

beforeEach(() => { calls.length = 0; responses = [] })

describe('files.put', () => {
  it('a path creates or replaces the file there, with the blob type and If-Match', async () => {
    responses.push(respond(201, info))
    const out = await client().files.put('/a b/c.csv', new Blob(['abc'], { type: 'text/csv' }), { ifMatch: info })
    assert.deepEqual(out, info)
    const { url, init } = calls[0]
    assert.equal(init.method, 'PUT')
    assert.equal(url, 'http://files.test/files?path=%2Fa+b%2Fc.csv')
    assert.equal(init.headers['Content-Type'], 'text/csv')
    assert.equal(init.headers['If-Match'], '"abc"')
    assert.equal(init.headers.Authorization, 'Bearer tok')
  })

  it('an xid or the file replaces it; { name } makes a new file in no folder', async () => {
    responses.push(respond(200, info), respond(200, info), respond(201, info))
    const c = client()
    await c.files.put(X, 'v2')
    await c.files.put(info, 'v3', { ifMatch: 'def' })
    await c.files.put({ name: 'scan.pdf' }, new Uint8Array([1]))
    assert.deepEqual(calls.map((x) => [x.init.method, x.url]), [
      ['PUT', `http://files.test/files/${X}`],
      ['PUT', `http://files.test/files/${X}`],
      ['POST', 'http://files.test/files?name=scan.pdf'],
    ])
    assert.equal(calls[1].init.headers['If-Match'], '"def"')
    assert.equal(calls[2].init.headers['Content-Type'], 'application/octet-stream')
  })

  it('streams with duplex half', async () => {
    responses.push(respond(201, info))
    await client().files.put('/s.bin', new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array([1])); ctl.close() } }))
    assert.equal(calls[0].init.duplex, 'half')
  })

  it('refuses a form content type and a target it cannot read, before any request', async () => {
    await assert.rejects(client().files.put('/x', 'a=b', { contentType: 'application/x-www-form-urlencoded' }),
      (e) => e.code === 'UNSUPPORTED_MEDIA_TYPE')
    await assert.rejects(client().files.put({}, 'x'), (e) => e.code === 'INVALID_PATH' && e.category === 'validation')
    assert.equal(calls.length, 0)
  })

  it('maps a missing folder and a lost update to typed errors', async () => {
    responses.push(respond(404, { error: { code: 'FOLDER_NOT_FOUND', message: 'No such folder: /a/', details: { path: '/a/' } } }, { 'x-request-id': 'r1' }),
      respond(412, { error: { code: 'FILE_CHANGED', message: 'changed' } }))
    const c = client()
    await assert.rejects(c.files.put('/a/b.txt', 'x'), (e) =>
      e instanceof SynthigyError && e.code === 'FOLDER_NOT_FOUND' && e.category === 'not_found' && e.status === 404 && e.requestId === 'r1')
    await assert.rejects(c.files.put('/a/b.txt', 'x', { ifMatch: 'old' }), (e) => e.code === 'FILE_CHANGED' && e.category === 'conflict')
  })
})

describe('files timeout', () => {
  it('a configured timeout covers file calls but not their bytes', async () => {
    const c = createClient({
      endpoint: 'http://files.test', token: 'tok', timeout: 50,
      fetch: async (url, init) => { calls.push({ url: String(url), init }); return responses.shift() },
    })
    responses.push(respond(200, info), respond(200, 'abc'), respond(200, info), respond(200, 'PK'))
    await c.files.info(X)
    await c.files.download(X)
    await c.files.put(X, 'v2')
    await c.files.zip({ files: [X] })
    assert.deepEqual(calls.map((x) => Boolean(x.init.signal)), [true, false, false, false])
  })
})

describe('files.zip', () => {
  it('posts files and folders as xids or paths, and reads the zip like download', async () => {
    responses.push(respond(200, 'PK'))
    const out = await client().files.zip({ files: [X, '/a/r.txt', info], folders: ['/site/img/', { xid: F, path: '/docs/' }] }, { as: 'text' })
    assert.equal(out, 'PK')
    const { url, init } = calls[0]
    assert.equal(url, 'http://files.test/files/zip')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(init.body), { files: [X, '/a/r.txt', X], folders: ['/site/img/', '/docs/'] })
  })

  it('turns an oversized zip into ZIP_TOO_LARGE', async () => {
    responses.push(respond(413, { error: { code: 'ZIP_TOO_LARGE', message: 'too big', details: { files: 20001 } } }))
    await assert.rejects(client().files.zip({ folders: ['/'] }), (e) => e.code === 'ZIP_TOO_LARGE')
  })
})

describe('files.download / info', () => {
  it('reads by path or xid, as text with a range, and answers null on 304', async () => {
    responses.push(respond(206, 'bc'), respond(304))
    const c = client()
    assert.equal(await c.files.download('/a b/r.txt', { as: 'text', range: [1, 2] }), 'bc')
    assert.equal(calls[0].url, 'http://files.test/files?path=%2Fa+b%2Fr.txt')
    assert.equal(calls[0].init.headers.Range, 'bytes=1-2')
    assert.equal(await c.files.download(X, { ifNoneMatch: 'abc' }), null)
    assert.equal(calls[1].url, `http://files.test/files/${X}`)
    assert.equal(calls[1].init.headers['If-None-Match'], '"abc"')
  })

  it('a kept version by path looks the file up first', async () => {
    responses.push(respond(200, info), respond(200, 'old'))
    assert.equal(await client().files.download('/r.txt', { as: 'text', version: { id: 42 } }), 'old')
    assert.deepEqual(calls.map((x) => x.url), ['http://files.test/files/info?path=%2Fr.txt', `http://files.test/files/${X}/versions/42`])
  })

  it('turns 416 and a missing module into typed errors', async () => {
    responses.push(respond(416), respond(404, { error: { code: 'NOT_FOUND', message: 'No matching route' } }))
    const c = client()
    await assert.rejects(c.files.download(X, { range: [99] }), (e) => e.code === 'RANGE_NOT_SATISFIABLE')
    await assert.rejects(c.files.download(X), (e) => e.code === 'FILES_UNAVAILABLE')
  })

  it('info answers null for a file or folder that is not there', async () => {
    responses.push(notFound('FILE_NOT_FOUND'), notFound('FOLDER_NOT_FOUND'), respond(200, info))
    const c = client()
    assert.equal(await c.files.info(X), null)
    assert.equal(await c.files.info('/nope/a.txt'), null)
    assert.deepEqual(await c.files.info('/a.txt'), info)
    assert.deepEqual(calls.map((x) => x.url), [
      `http://files.test/files/${X}/info`,
      'http://files.test/files/info?path=%2Fnope%2Fa.txt',
      'http://files.test/files/info?path=%2Fa.txt',
    ])
  })
})

describe('files.list', () => {
  it('a folder answers its files and subfolders; q narrows both', async () => {
    responses.push(respond(200, { files: [info] }), respond(200, { folders: [{ xid: F, name: 'Logos', path: '/a/Logos/' }, { xid: 'G', name: 'Docs', path: '/a/Docs/' }] }))
    const out = await client().files.list('/a/', { q: 'lo', limit: 5, offset: 10 })
    assert.deepEqual(out, { files: [info], folders: [{ xid: F, name: 'Logos', path: '/a/Logos/' }] })
    assert.deepEqual(calls.map((x) => x.url).sort(), [
      'http://files.test/files/folders?parent=%2Fa%2F',
      'http://files.test/files?q=lo&limit=5&offset=10&folder=%2Fa%2F',
    ])
  })

  it('subfolders match q as the server does: words in order, regex characters plain', async () => {
    const sub = (name) => ({ xid: name, name, path: `/a/${name}/` })
    responses.push(respond(200, { files: [] }), respond(200, { folders: [sub('Annual Report'), sub('Report Annual'), sub('a.b'), sub('axb')] }))
    const out = await client().files.list('/a/', { q: 'annual  report' })
    assert.deepEqual(out.folders.map((f) => f.name), ['Annual Report'])
    responses.push(respond(200, { files: [] }), respond(200, { folders: [sub('a.b'), sub('axb')] }))
    assert.deepEqual((await client().files.list('/a/', { q: 'a.b' })).folders.map((f) => f.name), ['a.b'])
  })

  it('null lists files in no folder; nothing lists every file you can see', async () => {
    responses.push(respond(200, { files: [] }), respond(200, { files: [info] }))
    const c = client()
    assert.deepEqual(await c.files.list(null, { q: 'inv' }), { files: [], folders: [] })
    assert.deepEqual(await c.files.list(), { files: [info], folders: [] })
    assert.deepEqual(calls.map((x) => x.url), ['http://files.test/files?q=inv&folderless=true', 'http://files.test/files'])
  })
})

describe('files.search', () => {
  it('sends the words, the folder and the limit; answers the results as they come', async () => {
    const found = { results: [{ type: 'folder', xid: F, path: '/site/' }, { ...info, type: 'file', path: '/site/a.txt' }], truncated: false }
    responses.push(respond(200, found), respond(200, { results: [], truncated: false }))
    const c = client()
    assert.deepEqual(await c.files.search('site a', { folder: '/', limit: 5, offset: 10 }), found)
    await c.files.search('x', { folder: { xid: F } })
    assert.deepEqual(calls.map((x) => x.url), [
      'http://files.test/files/search?q=site+a&folder=%2F&limit=5&offset=10',
      `http://files.test/files/search?q=x&folder=${F}`,
    ])
  })
})

describe('files.delete / move / folder / sharing', () => {
  it('delete takes a file or an empty folder', async () => {
    responses.push(respond(204), respond(204), respond(204), respond(204))
    const c = client()
    assert.equal(await c.files.delete(X), undefined)
    await c.files.delete('/a/b.txt')
    await c.files.delete('/a/')
    await c.files.delete({ xid: F, path: '/a/' })
    assert.deepEqual(calls.map((x) => [x.init.method, x.url]), [
      ['DELETE', `http://files.test/files/${X}`],
      ['DELETE', 'http://files.test/files?path=%2Fa%2Fb.txt'],
      ['DELETE', 'http://files.test/files/folders?path=%2Fa%2F'],
      ['DELETE', 'http://files.test/files/folders?path=%2Fa%2F'],
    ])
  })

  it('move renames or moves a file, and a folder to its new path', async () => {
    responses.push(respond(200, info), respond(200, info), respond(200, { xid: F }))
    const c = client()
    await c.files.move('/a/logo.png', '/b/brand.png')
    await c.files.move(X, '/b/')
    await c.files.move('/a/old/', '/b/new/')
    assert.deepEqual(calls.map((x) => [x.init.method, x.url, JSON.parse(x.init.body)]), [
      ['PATCH', 'http://files.test/files?path=%2Fa%2Flogo.png', { folder: '/b/', name: 'brand.png' }],
      ['PATCH', `http://files.test/files/${X}`, { folder: '/b/' }],
      ['PATCH', 'http://files.test/files/folders?path=%2Fa%2Fold%2F', { name: 'new', parent: '/b/' }],
    ])
    await assert.rejects(c.files.move(X, 'b.png'), (e) => e.code === 'INVALID_PATH')
  })

  it('folder makes the path with its settings; share, unshare and access by path', async () => {
    responses.push(respond(200, { xid: F, path: '/site/' }), respond(200, {}), respond(200, {}),
      respond(200, { read: { users: [], groups: [] }, write: { users: [], groups: [] }, delete: { users: [], groups: [] } }))
    const c = client()
    assert.equal((await c.files.folder('/site/', { public: true, cache: 3600 })).path, '/site/')
    assert.equal(await c.files.share('/site/', 'write', { users: [{ xid: 'U' }] }), undefined)
    await c.files.unshare({ xid: F }, 'write', { groups: ['G'] })
    await c.files.access('/site/')
    assert.deepEqual(calls.map((x) => [x.init.method, x.url, x.init.body && JSON.parse(x.init.body)]), [
      ['PUT', 'http://files.test/files/folders?path=%2Fsite%2F', { public: true, cache: 3600 }],
      ['POST', 'http://files.test/files/folders/share?path=%2Fsite%2F', { access: 'write', users: ['U'], groups: [] }],
      ['POST', `http://files.test/files/folders/${F}/unshare`, { access: 'write', users: [], groups: ['G'] }],
      ['GET', 'http://files.test/files/folders/access?path=%2Fsite%2F', undefined],
    ])
  })
})

describe('files.versions', () => {
  it('lists and restores by path or xid', async () => {
    responses.push(respond(200, info), respond(200, { versions: [{ id: 7, current: true }] }), respond(200, info))
    const c = client()
    assert.equal((await c.files.versions('/a.txt'))[0].id, 7)
    await c.files.restore(X, { id: 7 })
    assert.deepEqual(calls.map((x) => [x.init.method, x.url]), [
      ['GET', 'http://files.test/files/info?path=%2Fa.txt'],
      ['GET', `http://files.test/files/${X}/versions`],
      ['POST', `http://files.test/files/${X}/versions/7/restore`],
    ])
  })

  it('reports an expired version as not_found', async () => {
    responses.push(respond(410, { error: { code: 'VERSION_EXPIRED', message: 'gone' } }))
    await assert.rejects(client().files.restore(X, 1), (e) => e.code === 'VERSION_EXPIRED' && e.category === 'not_found')
  })
})

describe('files links', () => {
  it('url needs no request: an xid or file, or a path, and inline', () => {
    const c = client()
    assert.equal(c.files.url(X), `http://files.test/files/${X}`)
    assert.equal(c.files.url(info, { inline: true }), `http://files.test/files/${X}?disposition=inline`)
    assert.equal(c.files.url("/site/my logo+1 (č)*.png"), 'http://files.test/files/path/site/my%20logo%2B1%20%28%C4%8D%29%2A.png')
    assert.throws(() => c.files.url('/site/'), (e) => e.code === 'INVALID_PATH')
    assert.equal(calls.length, 0)
  })

  it('link, links and unlink: one request each, snake_case on the wire', async () => {
    const made = { xid: F, file: X, url: 'http://files.test/files/link/t', downloads: 0, max_downloads: 2, inline: true }
    responses.push(respond(200, info), respond(201, made), respond(200, { file: X, links: [made] }), respond(204), respond(204))
    const c = client()
    assert.equal((await c.files.link('/a.txt', { expires: 600, maxDownloads: 2, inline: true })).url, made.url)
    assert.equal((await c.files.links(X))[0].xid, F)
    await c.files.unlink(made)
    await c.files.unlink(F)
    assert.deepEqual(calls.map((x) => [x.init.method, x.url]), [
      ['GET', 'http://files.test/files/info?path=%2Fa.txt'],
      ['POST', `http://files.test/files/${X}/links`],
      ['GET', `http://files.test/files/${X}/links`],
      ['DELETE', `http://files.test/files/links/${F}`],
      ['DELETE', `http://files.test/files/links/${F}`],
    ])
    assert.deepEqual(JSON.parse(calls[1].init.body), { expires: 600, max_downloads: 2, inline: true })
  })

  it('link refusals carry their categories; canLink goes out as can_link', async () => {
    responses.push(respond(403, { error: { code: 'LINKS_DISABLED', message: 'off' } }),
      respond(400, { error: { code: 'INVALID_EXPIRES', message: 'bad' } }),
      respond(200, { xid: F, path: '/s/' }))
    const c = client()
    await assert.rejects(c.files.link(X), (e) => e.code === 'LINKS_DISABLED' && e.category === 'iam')
    await assert.rejects(c.files.link(X, { expires: 0 }), (e) => e.code === 'INVALID_EXPIRES' && e.category === 'validation')
    await c.files.folder('/s/', { canLink: true, cache: 60 })
    assert.deepEqual(JSON.parse(calls[2].init.body), { cache: 60, can_link: true })
  })

  it('keyFormat reaches /files as key_format; snake sends none', async () => {
    responses.push(respond(200, { xid: X }), respond(200, { xid: X }), respond(200, { file: X, links: [] }))
    await client({ keyFormat: 'camel' }).files.info(X)
    await client({ keyFormat: 'snake' }).files.info(X)
    await client({ keyFormat: 'camel' }).files.links(X)
    assert.deepEqual(calls.map((x) => x.url), [
      `http://files.test/files/${X}/info?key_format=camel`,
      `http://files.test/files/${X}/info`,
      `http://files.test/files/${X}/links?key_format=camel`,
    ])
  })

  it('objectUrl gives a blob: URL and a revoke', async () => {
    responses.push(respond(200, 'abc'))
    const { url, revoke } = await client().files.objectUrl(X)
    assert.match(url, /^blob:/)
    revoke()
  })

  it('serve passes the browser request through and keeps the answer', async () => {
    const res = {
      ok: false, status: 206,
      headers: new Headers({ 'content-type': 'image/png', 'content-range': 'bytes 0-1/3', etag: '"abc"', 'x-request-id': 'r9' }),
      body: new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array([1, 2])); ctl.close() } }),
    }
    responses.push(res)
    const out = await client().files.serve('/site/logo.png', new Request('http://bff/x', { headers: { range: 'bytes=0-1' } }), { inline: true })
    assert.equal(calls[0].url, 'http://files.test/files?path=%2Fsite%2Flogo.png&disposition=inline')
    assert.equal(calls[0].init.headers.range, 'bytes=0-1')
    assert.equal(out.status, 206)
    assert.equal(out.headers.get('content-range'), 'bytes 0-1/3')
    assert.equal(out.headers.get('x-request-id'), null)
    assert.deepEqual([...new Uint8Array(await out.arrayBuffer())], [1, 2])
  })
})

describe('files: actingAs', () => {
  const any = () => respond(200, { ...info, files: [], folders: [], versions: [], links: [], url: 'u' })
  const each = (c, o) => [
    () => c.files.put('/a/b.txt', 'x', o),
    () => c.files.download('/a/b.txt', { ...o, version: 1, as: 'text' }),
    () => c.files.zip({ files: [X] }, o),
    () => c.files.info(X, o),
    () => c.files.list('/a/', o),
    () => c.files.list(undefined, o),
    () => c.files.search('q', o),
    () => c.files.delete(X, o),
    () => c.files.move(X, '/b/c.txt', o),
    () => c.files.folder('/a/', {}, o),
    () => c.files.share('/a/', 'read', { users: [F] }, o),
    () => c.files.unshare('/a/', 'read', { users: [F] }, o),
    () => c.files.access('/a/', o),
    () => c.files.versions('/a/b.txt', o),
    () => c.files.restore('/a/b.txt', 1, o),
    () => c.files.link('/a/b.txt', o),
    () => c.files.links('/a/b.txt', o),
    () => c.files.unlink(F, o),
    () => c.files.serve(X, { headers: {} }, o),
  ]
  const header = (h) => h?.['X-Acting-As'] ?? h?.['x-acting-as']

  it('every files call, and the path lookup before it, sends X-Acting-As', async () => {
    const c = client()
    for (const call of each(c, { actingAs: F })) {
      calls.length = 0
      responses = Array.from({ length: 4 }, any)
      await call()
      assert.ok(calls.length > 0)
      for (const { url, init } of calls) assert.equal(header(init.headers), F, `${init.method ?? 'GET'} ${url}`)
    }
  })

  it('without actingAs no header goes out', async () => {
    const c = client()
    for (const call of each(c, {})) {
      calls.length = 0
      responses = Array.from({ length: 4 }, any)
      await call()
      for (const { init } of calls) assert.equal(header(init.headers), undefined)
    }
  })
})
