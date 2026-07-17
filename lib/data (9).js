// lib/data.js — ErrorEngine's Upstash access layer.
//
// Mirrors BackBone's KV conventions exactly:
//   - READS  via GET /get/{key}
//   - WRITES via POST /pipeline with [["SET", key, JSON.stringify(value)]]  (never /set/key)
//   - Defensive triple-unwrap of double-encoded / chunked strings (historic writes
//     in the shared instance were double-encoded; unwrap rather than assume one shape).
//
// SHARED INSTANCE. ErrorEngine writes ONLY under the errorengine_data: prefix. It reads
// backbone_data READ-ONLY for enrichment and never writes that key.
//
// ESM. Do NOT convert to module.exports.

import { keys } from "./schema.js";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function assertConfig() {
  if (!KV_URL || !KV_TOKEN) throw new Error("Upstash not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
}

async function kvGet(key) {
  assertConfig();
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result || null;
}

// Pipeline write — matches BackBone's save pattern. Accepts one or many commands.
async function kvPipeline(commands) {
  assertConfig();
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Redis pipeline failed: ${r.status}`);
  return r.json();
}

// Upstash hands back whatever string was stored. Historic writes were double-encoded and
// some were chunked into numeric keys — unwrap defensively (copied from BackBone's data.js).
function unwrap(raw) {
  let data = raw;
  let attempts = 0;
  while (typeof data === "string" && attempts < 3) {
    try {
      data = JSON.parse(data);
    } catch (e) {
      break;
    }
    attempts++;
  }
  if (typeof data === "object" && data && data["0"] !== undefined && data.synced === undefined && data.error_id === undefined) {
    const rebuilt = Object.keys(data)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => data[k])
      .join("");
    try {
      data = JSON.parse(rebuilt);
    } catch (e) {
      /* leave as-is */
    }
  }
  return data;
}

// ---- ErrorEngine records ----------------------------------------------------

export async function getError(id) {
  const raw = await kvGet(keys.record(id));
  return raw ? unwrap(raw) : null;
}

export async function listErrorIds() {
  const raw = await kvGet(keys.index());
  const ids = raw ? unwrap(raw) : [];
  return Array.isArray(ids) ? ids : [];
}

export async function saveError(record) {
  // One pipeline: SET the record, append its id to the index array.
  // (Index kept as a JSON array under one key, matching BackBone's single-key style,
  //  rather than a Redis SET — keeps unwrap() behavior uniform.)
  const ids = await listErrorIds();
  if (!ids.includes(record.error_id)) ids.push(record.error_id);
  await kvPipeline([
    ["SET", keys.record(record.error_id), JSON.stringify(record)],
    ["SET", keys.index(), JSON.stringify(ids)],
  ]);
  return record;
}

export async function nextErrorId() {
  // INCR is atomic; the counter lives under the errorengine_data prefix.
  const [res] = await kvPipeline([["INCR", keys.counter()]]);
  const n = res && res.result;
  return `EE-${String(n).padStart(5, "0")}`;
}

export async function listErrors() {
  const ids = await listErrorIds();
  if (!ids.length) return [];
  const cmds = ids.map((id) => ["GET", keys.record(id)]);
  const results = await kvPipeline(cmds);
  return results
    .map((r) => (r && r.result ? unwrap(r.result) : null))
    .filter(Boolean)
    .sort((a, b) => new Date(b.date_logged) - new Date(a.date_logged));
}

// ---- BackBone reader (READ-ONLY) --------------------------------------------
// Reads the shared backbone_data key to resolve customer + AM without re-syncing
// Printavo or re-uploading the AM roster. ErrorEngine NEVER writes this key.

export async function getBackboneData() {
  const raw = await kvGet("backbone_data");
  if (!raw) return { synced: [], enrichment: {}, lastSynced: null };
  const data = unwrap(raw);
  return {
    synced: (data && data.synced) || [],
    enrichment: (data && data.enrichment) || {},
    lastSynced: (data && data.lastSynced) || null,
  };
}

// Resolve a customer_id to { customer, owner } using BackBone's roster + enrichment.
// owner comes from enrichment[customer_id].account_manager — this replaces the AM
// roster file, since BackBone already holds it.
export async function resolveFromBackbone(customerId) {
  if (!customerId) return {};
  const { synced, enrichment } = await getBackboneData();
  const row = synced.find((c) => String(c.customer_id) === String(customerId));
  const enr = enrichment[customerId] || {};
  return {
    customer: row ? row.company_name || row.companyName || row.customer : undefined,
    owner: enr.account_manager || undefined,
  };
}

// List BackBone customers for the intake dropdown (id + name only).
export async function listBackboneCustomers() {
  const { synced } = await getBackboneData();
  return synced
    .map((c) => ({
      customer_id: String(c.customer_id),
      name: c.company_name || c.companyName || c.customer || `#${c.customer_id}`,
    }))
    .filter((c) => c.customer_id)
    .sort((a, b) => a.name.localeCompare(b.name));
}
