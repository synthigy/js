#!/usr/bin/env node
// Pull the IAM-filtered schema → commit synthigy.schema.json.
//
// The codegen type-truth. Everyone (Prisma/genqlient/sqlc) does the same:
// pull once → commit the artifact → generate offline. Retires the nREPL `spit`.
//
// Reuses the SDK's `client.schema()` — it already does GET /schema + auth, so
// there's no HTTP/auth to reimplement here (ladder: a dependency already solves it).
//
// Config via env (or --endpoint):
//   SYNTHIGY_ENDPOINT        e.g. http://localhost:7887   (or argv[2])
//   SYNTHIGY_TOKEN           static bearer  — OR —
//   SYNTHIGY_CLIENT_ID + SYNTHIGY_CLIENT_SECRET   client-credentials
//   (none ⇒ authless GET, for bare servers / SYNTHIGY_IAM_ALLOW_PUBLIC)
//
// ponytail: device-code flow (gh/gcloud-style human login) skipped — token or
// client-creds covers the dev/CI loop. Add device-code when a human-pull UX is wanted.

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '../src/index.js'

const endpoint = process.argv[2] ?? process.env.SYNTHIGY_ENDPOINT
if (!endpoint) {
  console.error('usage: node pull.mjs <endpoint>   (or set SYNTHIGY_ENDPOINT)')
  process.exit(1)
}

const { SYNTHIGY_TOKEN, SYNTHIGY_CLIENT_ID, SYNTHIGY_CLIENT_SECRET } = process.env
const config = { endpoint }
if (SYNTHIGY_CLIENT_ID && SYNTHIGY_CLIENT_SECRET) {
  config.clientId = SYNTHIGY_CLIENT_ID
  config.clientSecret = SYNTHIGY_CLIENT_SECRET
} else {
  config.token = SYNTHIGY_TOKEN ?? '' // '' = authless (bare server)
}

const here = path.dirname(new URL(import.meta.url).pathname)
const outPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(here, 'schema.json')

const client = createClient(config)
const schema = await client.schema()
fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n')

const n = Object.keys(schema.entities ?? {}).length
const v = schema.version ? ` @${schema.version}` : ''
console.log(`pulled ${n} entities${v} → ${path.relative(process.cwd(), outPath)}`)
