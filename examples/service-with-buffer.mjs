/**
 * Services-style composition: @synthigy/sdk + @synthigy/buffer
 *
 * Demonstrates the intended Node.js service pattern:
 *
 *   - `connect()` once per service — the single process-wide client (holds
 *     OAuth token cache + pooled fetch). It returns that client for the few
 *     spots that need the instance (here: the buffer's fetchFn).
 *   - One buffer instance per unit of work (bound to that unit's actor)
 *   - All HTTP goes through the same connection pool
 *   - acting_as is a body concern, not a transport concern
 *
 * Run from `sdk/js/`:
 *     node examples/service-with-buffer.mjs
 *
 * Requires a Synthigy server at localhost:7887. OAuth is optional —
 * the demo falls back to a static empty token (works in dev mode).
 */

import { connect, disconnect } from "../src/index.js";

// Monorepo demo: import buffer source + Node WASM bundle, then use
// `TransactionBuffer.connect(wasmModule, opts)` directly. In a real
// service using the published package:
//     npm install @synthigy/buffer
//     import { create } from "@synthigy/buffer"
// (package.json `exports` resolves to the right bundle; top-level
// connect() just works).
const bufferSrcUrl = new URL(
  "../../../transaction-buffer/js/src/index.ts",
  import.meta.url,
);
const wasmNodeUrl = new URL(
  "../../../transaction-buffer/js/pkg-node/synthigy_wasm.js",
  import.meta.url,
);
const { TransactionBuffer } = await import(bufferSrcUrl.href);
const wasmModule = await import(wasmNodeUrl.href);
const { create } = await import(bufferSrcUrl.href);
// we already have TransactionBuffer imported; call .connect static with the node wasm
const buffer_create = (opts) => TransactionBuffer.connect(wasmModule, opts);

// ────────────────────────────────────────────────────────────────────────
// 1. Pooled fetch — optional but recommended for services.
//    Without this, every HTTP call opens a fresh TCP connection.
// ────────────────────────────────────────────────────────────────────────

let pooledFetch = globalThis.fetch;
try {
  const { Agent, fetch } = await import("undici");
  const agent = new Agent({
    keepAliveTimeout: 30_000,
    connections: 50,
  });
  pooledFetch = (url, init) => fetch(url, { ...init, dispatcher: agent });
  console.log("using undici with keep-alive agent");
} catch {
  console.log("undici not installed — using globalThis.fetch (no pooling)");
}

// ────────────────────────────────────────────────────────────────────────
// 2. Connect ONCE for the whole service lifetime — the single process-wide
//    client (OAuth token cache + injected pooled fetch). `connect` returns
//    it for the spots that need the instance (the buffer's fetchFn below).
// ────────────────────────────────────────────────────────────────────────

const endpoint = process.env.SYNTHIGY_ENDPOINT ?? "http://localhost:7887";
const clientId = process.env.SYNTHIGY_CLIENT_ID;
const clientSecret = process.env.SYNTHIGY_CLIENT_SECRET;

const client = connect({
  endpoint,
  ...(clientId && clientSecret
    ? { clientId, clientSecret }
    : { token: process.env.SYNTHIGY_TOKEN ?? "" }),
  fetch: pooledFetch,
});

// ────────────────────────────────────────────────────────────────────────
// 3. Unit of work — e.g. a request handler or cron job.
//    Gets a buffer scoped to this unit's actingAs identity.
// ────────────────────────────────────────────────────────────────────────

async function bulkImportUsers(rows, actingAs) {
  // Buffer shares the client's token cache + pooled fetch. actingAs is a
  // body-level concern, so it goes on `connect()` — not the fetchFn.
  const buffer = await buffer_create({
    fetchFn: client.fetchFn(),
    entities: ["user"],
    actingAs,
  });

  for (const row of rows) buffer.stack("user", row);

  const { stacks, slices, deletes } = buffer.pending();
  console.log(`  pending: ${stacks} stacks, ${slices} slices, ${deletes} deletes`);

  const preview = buffer.toData();
  console.log(`  committing 1 /data request with ${preview.request.operations.length} op(s)`);

  const result = await buffer.commit();
  if (result.success) {
    console.log(`  ✓ committed ${rows.length} row(s) in 1 HTTP call`);
  } else {
    console.error(`  ✗ commit errors:`);
    for (const err of result.errors) {
      console.error(`      [${err.code}] ${err.entityName}: ${err.message}`);
    }
  }

  return { buffer, result };
}

async function cleanup(prefix, actingAs) {
  const buffer = await buffer_create({
    fetchFn: client.fetchFn(),
    entities: ["user"],
    actingAs,
  });
  const demo = await buffer.search(
    "user",
    { _where: { name: { _like: `${prefix}%` } } },
    { xid: null, name: null },
  );
  for (const u of demo) buffer.delete("user", u.xid);
  if (buffer.hasChanges()) {
    const r = await buffer.commit();
    console.log(
      r.success
        ? `cleanup: deleted ${demo.length} row(s)`
        : `cleanup failed: ${JSON.stringify(r.errors)}`,
    );
  } else {
    console.log("cleanup: nothing to remove");
  }
}

// ────────────────────────────────────────────────────────────────────────
// 4. Run: two concurrent "requests", each with its own buffer + identity
// ────────────────────────────────────────────────────────────────────────

const ADMIN = process.env.ADMIN_EUUID ?? undefined;

console.log("\n=== Request 1 (Alice's import) ===");
await bulkImportUsers(
  [
    { name: "ServiceDemo-alice-1", active: true, type: "PERSON" },
    { name: "ServiceDemo-alice-2", active: true, type: "PERSON" },
  ],
  ADMIN,
);

console.log("\n=== Request 2 (Bob's import, concurrent) ===");
await bulkImportUsers(
  [{ name: "ServiceDemo-bob-1", active: true, type: "PERSON" }],
  ADMIN,
);

console.log("\n=== Cleanup ===");
await cleanup("ServiceDemo-", ADMIN);

disconnect(); // close the single client's pooled connections + SSE
console.log("\ndone");
