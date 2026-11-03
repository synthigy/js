# Files

`client.files` stores and serves file bytes through the server's `/files`
endpoints. Every call runs as your identity: you see and change only the files
your roles and the folder access lists allow. Each file is also an ordinary
`File` record, so `client.search('File', …)` works for queries `list` does not
cover. Needs a server with the files module running.

```js
import { createClient } from '@synthigy/sdk'

const client = createClient({ endpoint, clientId, clientSecret })
const { files } = client

await files.folder('/site/img/')                     // the folder, and any missing above it
await files.put('/site/img/logo.png', logo)          // creates the file
await files.put('/site/img/logo.png', newLogo)       // replaces it: same xid, a new version

await files.download('/site/img/logo.png')           // a Blob
await files.info('/site/img/logo.png')               // { xid, name, size, hash, …, public } or null
await files.list('/site/img/')                       // { files, folders }
await files.move('/site/img/logo.png', '/site/brand/')
await files.delete('/site/brand/logo.png')
```

## Naming files and folders

A file is a path (`'/site/img/logo.png'`), an xid, or the file itself. A
folder is a path ending in `/` (`'/'` is ROOT), an xid, or the folder itself.
Paths are the same in every environment; an xid stays the same when the file
is renamed or moved.

## Every day

```js
// put: a path creates or replaces the file there; the folder must exist
await files.put('/site/img/logo.png', input.files[0])
await files.put('/reports/q3.csv', 'a,b\n1,2\n', { contentType: 'text/csv' })
await files.put(file, nextBytes, { ifMatch: file })  // only if nobody changed it since you read it
await files.put({ name: 'scan.pdf' }, buffer)        // a new file in no folder (put it again: another file)

// download: a Blob by default
const text = await files.download('/notes/today.txt', { as: 'text' })
const head = await files.download(file, { as: 'arrayBuffer', range: [0, 1023] })
const body = await files.download(file, { as: 'stream' })

// list
const { files: images, folders } = await files.list('/site/img/', { q: 'logo' })
await files.list(null)                               // files in no folder
await files.list(undefined, { q: 'invoice' })        // every file you can see, newest first

// search: the words in order, anywhere in the path; shortest path first
const { results, truncated } = await files.search('site logo')   // folders and files; results[i].type
await files.search('invoice 2026', { folder: '/accounting/', limit: 20, offset: 20 })   // page 2

// links: no request
files.url('/site/img/logo.png')                      // https://…/files/path/site/img/logo.png
files.url(file)                                      // https://…/files/<xid>
files.url(file, { inline: true })                    // opens in the browser instead of downloading
```

## When you need them

```js
await files.folder('/site/', { public: true, cache: 3600 })   // settings: below
await files.move('/site/img/', '/site/media/')        // a folder's new path; paths below follow
await files.share('/site/', 'write', { users: [userXid], groups: [groupXid] })
await files.unshare('/site/', 'write', { users: [userXid] })
await files.access('/site/')                          // { read: { users, groups }, write: …, delete: … }

const [now, previous] = await files.versions(file)    // the last ten
await files.download(file, { version: previous })
await files.restore(file, previous)                   // current again; no bytes copied

// browser: a private file in <img> or <iframe>
const { url, revoke } = await files.objectUrl(file)

// server (BFF): answer the browser's request with the file
export async function GET(request) {
  return files.serve('/invoices/2026/inv-1.pdf', request, { inline: true })
}
```

`serve` passes `Range`, `If-None-Match` and `If-Range` to the server and
answers with its status, type, length, `ETag`, name and `Cache-Control`; a
refusal (404, 403) comes back as the server's own answer.

## Public folders

`<img src>`, `<video>` and a link in an email cannot carry your token. A file
in a public folder loads without one:

- Each folder has its own `public` and `cache`, or none: then it takes them
  from the nearest folder above that has them, as on a filesystem. `null`
  clears a folder's own value.
- `public: true` makes the files load without a token; `public: false` keeps
  them private, also inside a public folder. `file.public` tells you whether
  a file loads without one.
- `cache` (seconds) tells browsers and CDNs how long to keep the files.
  Without one, browsers ask each time and get 304 while the file is unchanged.
- A folder shows both: `public` and `cache` as they apply, and its own values
  under `settings` (`null`: inherited).
- File User may set `cache` but not `public` (`ATTRIBUTE_FORBIDDEN`); then
  nothing is created either.

A private file in the browser: `objectUrl` (downloads with your token), or
your backend serves it (`serve`).

## What a file looks like

```js
{
  xid: 'rkpYAgQpiwaSnUhP7z5hU1',
  name: 'report.pdf',
  size: 48213,
  hash: '906ed25f…',            // SHA-256 of the bytes; also the download ETag
  status: 'READY',
  content_type: 'application/pdf',
  uploaded_at: '2026-10-29T13:15:07Z',
  uploaded_by: { xid, name },   // who wrote the current version
  folder: { xid, name, path } | null,
  public: false                 // loads without a token
}
```

## Rules worth knowing

- **`put` never creates folders.** A missing one is `FOLDER_NOT_FOUND`, and
  the error names it (`details.path`); `folder(path)` creates it.
- **A second `put` to a path replaces the file**: same xid, so links stay
  valid, and the old bytes stay a version you can restore.
- **Names are unique inside a folder**, compared exactly (`Report.pdf` and
  `report.pdf` are two files). Files in no folder are never compared.
- **`move` never overwrites**: a taken name is `FILE_NAME_TAKEN`. For a file,
  a `to` ending in `/` keeps the name; a folder's `to` is its new path.
- **`delete` of a folder** works only on an empty one (`FOLDER_NOT_EMPTY`).
- **The server decides the facts.** Size, hash and status are measured and
  set by the server.
- **Content type**: the Blob's own type, else `text/plain` for strings, else
  the server guesses from the name. Never send
  `application/x-www-form-urlencoded`: such a body is parsed as a form and
  never stored (`UNSUPPORTED_MEDIA_TYPE`).
- **Size**: one request carries up to the server's limit (25 MB by default,
  `SYNTHIGY_SERVER_MAX_BODY`); more is `FILE_TOO_LARGE`.
- **Versions**: the last ten are kept; older ones are `VERSION_EXPIRED`.
  Deleted files keep their bytes for 30 days on the server.

## Errors

| Code | Category | When |
|---|---|---|
| `FILE_NOT_FOUND` | not_found | no such file, or you can't see it |
| `FOLDER_NOT_FOUND` | not_found | no such folder, or you can't see it; `details.path` names it |
| `FILE_NAME_TAKEN` | conflict | the folder already has a file of that name |
| `FILE_CHANGED` | conflict | `put` with a stale `ifMatch` |
| `FILE_NOT_READY` | conflict | the file is still being processed, or failed |
| `FILE_TOO_LARGE` | validation | over the server's request limit |
| `UNSUPPORTED_MEDIA_TYPE` | validation | a form-encoded body |
| `RANGE_NOT_SATISFIABLE` | validation | a range past the end of the file |
| `INVALID_PATH` | validation | not a file path (`/folder/name`), or not a folder path |
| `INVALID_SETTINGS` | validation | `public` not true/false, `cache` not whole seconds |
| `INVALID_NAME` | validation | empty, over 255 characters, `/` `\` or control characters, `.`/`..` |
| `FILES_UNAVAILABLE` | not_found | the server runs no files module |
| `AUDIT_UNAVAILABLE` | not_found | a write, delete or version call while the server's audit history is down; downloads still work |
| `FILES_MIGRATING` | internal | an upload while the server moves files to a new store; retry in a moment, downloads still work |
| `FOLDER_NAME_TAKEN` | conflict | the parent already has a folder of that name |
| `FOLDER_NOT_EMPTY` | conflict | delete of a folder that holds files or folders |
| `FOLDER_CYCLE` | conflict | moving a folder inside itself |
| `VERSION_EXPIRED` | not_found | a version that is no longer kept |
| `FORBIDDEN` | iam | your roles or the folder's access list refuse it |
| `ATTRIBUTE_FORBIDDEN` | iam | your roles may not set that folder setting |

## Not yet

- Upload progress: `fetch` reports none. Use `XMLHttpRequest` against
  `PUT /files?path=…` if you need a progress bar.
- Files over the request limit (chunked uploads).
- Links that expire, for private files.
