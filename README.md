# `@synthigy/sdk`

TypeScript / JavaScript client for [Synthigy](https://github.com/synthigy/synthigy).
Zero dependencies. Typed reads, structured writes, live data on one connection,
and per-call server-enforced permissions.

```bash
npm install @synthigy/sdk
```

## Hello world

```ts
import { createClient } from '@synthigy/sdk'

// Endpoint and identity come from `synthigy exec` (see Code generation, step 3).
const synthigy = createClient()

// Read — XSQL: the shape you write is the shape you get back
const movies = await synthigy.query(`
movie (limit 5, order by release_year desc)
  xid
  title
  release_year
  ->genres
    name`)

// Write — additive; doesn't disturb the movie's other ratings
await synthigy.stack('user_rating', {
  value: 5, timestamp: new Date().toISOString(),
  movie: { xid: movies[0].xid },
})

// Live — snapshot + keep-current, multiplexed onto one SSE
const w = synthigy.watchSqlTemplate(
  `SELECT count(*) AS n FROM {user_rating}`, {}, { entities: ['user_rating'] })
await w.ready()
for await (const ev of w.events) {
  if (ev.type === 'result/changed') console.log('ratings:', ev.after[0].n)
}
```

Run it with `synthigy exec -- node hello.ts`.

## What makes it Synthigy

- **The query *is* the result shape.** Ask for fields and relations; get back
  that JSON and nothing else, written in [XSQL](./docs/XSQL.md).

- **Writes are silent by default.** `sync`/`stack` answer `{ count }`, not the
  record. Mint the id up front with `newXid()` when you need it — cheaper than
  the echo, and a retried write upserts the same row instead of duplicating it.
  Pass `{ returning: true }` for the record; generated code types the two apart.
- **Writes that ORMs make you hand-roll.** `stack` adds a child without
  clobbering its siblings; `slice` detaches a link without deleting the record.
  Plus `sync` (upsert), `delete`, `purge`.

- **Live data on one connection.** Open dozens of watches — they multiplex onto
  a single SSE per client. `watchQuery` for a live result set,
  `watchSqlTemplate` for live analytics, `watch` for raw record events.

- **`actingAs` per call.** Every read and write can run as a specific user, with
  IAM / RBAC / row-level security enforced *server-side*; `whoami({ actingAs })`
  shows who a call runs as — roles, superuser, whether this client may act as
  users. Tokens never have to
  reach the browser. `client.login` runs the OIDC authorization-code + PKCE
  exchange for your BFF and leaves sessions to you; `createBrowserLogin` does
  the same for a browser app, as a public client with silent renew and tokens
  in memory.

- **Typed from your model.** `synthigy-gen` compiles your ERD + `.xsql` files
  into typed methods whose result types follow the selection — a typo'd entity
  or an unselected field is a compile error. With `typescript` (any version, 7
  included) in your project the generated files are type-checked before they
  are written. → [Code generation](#code-generation)

## Code generation

Write your queries in `.xsql` files and get typed functions for them. The
server compiles the queries, so the types always match what it returns.

**1. Get a server.** In your project folder:

```bash
synthigy env init
synthigy up
```

The first `up` prints a `/setup` link; open it and pick a database. (No
browser? `synthigy up --bundle sqlite` skips the wizard.) Already have a server?
Skip this step.

**2. Deploy your data model** in the modeler (or from code with `client.deploy()`, as a
client with the Dataset Developer role).

**3. Connect as your app.** Create its client once, then save it to the
project:

```bash
synthigy iam add-client "My App" --id my-app --type confidential \
  --role "Dataset Explorer" --api Synthigy --grant client_credentials --local
synthigy connect http://localhost:7887 --client-id my-app
```

`add-client` prints the secret once; `connect` asks for it. Code is generated
for what this app is allowed to see. (`--local` works on the server's own
machine; for a remote server, create the client in the console.)

**4. Install the SDK:**

```bash
npm install @synthigy/sdk
npm install -D typescript   # optional: type-checks the generated files
```

**5. Write a query** in `xsql/movies.xsql`:

```
@search list
movie (release_year > ?since:int=1990, limit ?limit:int=20)
  xid
  title
  release_year
```

**6. Generate:**

```bash
synthigy exec -- npx synthigy-gen xsql/ generated/
```

This writes `generated/ops.ts` and `generated/schema.ts`, and saves `xsql/schema.json` and `xsql/ops.ir.json`
next to your queries.

**7. Use it:**

```ts
import { configure, Movie } from './generated/ops.ts'

configure()
const movies = await Movie.list({ since: 2000 })
console.log(movies.map(m => m.title))
```

```bash
synthigy exec -- node app.ts
```

`synthigy exec` gives your program the server address and the app's identity (Node 23+ runs `.ts` directly; set `"type": "module"` in `package.json`).
Without it, pass them yourself: `configure({ endpoint, clientId, clientSecret })`.

**After you edit a query**, run step 6 again. As long as the `.xsql` files are
unchanged it works offline from `xsql/ops.ir.json`; after an edit it needs the
server, and it never generates from outdated results. In CI:

```bash
npx synthigy-gen check xsql/
```

**What to commit:** your `.xsql` files and `xsql/ops.ir.json`.
`xsql/schema.json` is your whole data model, so commit it only in a private
repo.

`@watch` ops also get a live `watch<Name>()` method, `@batch` ops become one exported function that sends every member in one request (a failed member is a `SynthigyError` in its slot), and every entity gets typed `sync` / `stack` / `delete`.

## Docs

| Doc | What's in it |
|---|---|
| [XSQL.md](./docs/XSQL.md) | The query language: shapes, params, aggregates, op files, sql-templates |
| [FILES.md](./docs/FILES.md) | Upload, download, list, search, share and version files |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |
| [synthigy/examples: movies/js](https://github.com/synthigy/examples/tree/main/movies/js) | End-to-end Datastar BFF against the published package |
| [src/index.d.ts](./src/index.d.ts) | Full type definitions |

## Tests

```bash
node --test 'test/*.test.js'                    # unit
SYNTHIGY_ENDPOINT=http://localhost:7887 \
  SYNTHIGY_CLIENT_ID=… SYNTHIGY_CLIENT_SECRET=… \
  node --test 'test/integration.test.js'        # integration (skips without a server)
SYNTHIGY_FILES_TEST_ENDPOINT=http://localhost:7887 \
  SYNTHIGY_FILES_TEST_{ADMIN,USER,READER}_{ID,SECRET}=… \
  npm run test:files                            # live files (skips without the endpoint)
```

The live files suite needs three client-credentials clients whose service users
hold File Admin, File User and File Reader. `npm test` never runs it.

## License

MIT — see [LICENSE](LICENSE).

The SDKs are deliberately permissive: they are client libraries you embed in
your own application. The Synthigy **engine** is separate, and is source-available
under the Business Source License 1.1.

