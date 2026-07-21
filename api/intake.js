// api/intake.js — log an error. Mirrors BackBone's api/intake.js + api/save.js shape.
//
// GET  -> list all error records (newest first), for the dashboard.
// POST -> validate, resolve customer/owner from backbone_data (read-only), write.
//
// ESM handler, guarded by requireAuth(req, res) from lib/session.js — the same
// signature BackBone uses. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { validateRecordWith, validatePatchWith, VENDOR_DEFECT } from "../lib/schema.js";
import {
  listErrors, saveError, nextErrorId, resolveFromBackbone, deleteError,
  getError, updateError, bulkUpdateErrors,
} from "../lib/data.js";
import { getTaxonomy } from "../lib/taxonomy-store.js";

// Values accepted by the validator = ALL options, active or retired. A retired
// option must still validate, or every historical record using it would become
// uneditable the moment management retires it.
async function allowedValues() {
  const tax = await getTaxonomy();
  const out = {};
  for (const [field, list] of Object.entries(tax)) out[field] = list.map((o) => o.value);
  return out;
}

// For NEW records, restrict to ACTIVE options — a retired type shouldn't be
// selectable going forward even if someone crafts the request by hand.
async function activeValues() {
  const tax = await getTaxonomy();
  const out = {};
  for (const [field, list] of Object.entries(tax)) {
    out[field] = list.filter((o) => o.active).map((o) => o.value);
  }
  return out;
}

// Vercel doesn't always pre-parse JSON bodies. Normalize so field access is safe.
function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}


export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  // GUARD. Everything below requires a valid ErrorEngine session.
  const sess = requireAuth(req, res);
  if (!sess) return; // 401 already sent

  try {
    if (req.method === "GET") {
      // ?id=EE-00001 fetches a single record for the detail view.
      const id = req.query && req.query.id;
      if (id) {
        const rec = await getError(id);
        if (!rec) return res.status(404).json({ error: "Error not found" });
        return res.status(200).json({ record: rec });
      }
      return res.status(200).json({ errors: await listErrors() });
    }

    // PATCH — edit a record, or change status on many at once.
    //   single: /api/intake?id=EE-00001   body = { status: "resolved", ... }
    //   bulk:   /api/intake               body = { ids: [...], patch: {...} }
    if (req.method === "PATCH") {
      const body = parseBody(req);
      const qid = req.query && req.query.id;

      // ---- bulk ----
      if (Array.isArray(body.ids)) {
        if (!body.ids.length) return res.status(400).json({ error: "ids array is empty" });
        if (body.ids.length > 500) return res.status(400).json({ error: "Too many ids (max 500)" });

        const { ok, errors, patch } = validatePatchWith(body.patch || {}, await allowedValues());
        if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
        if (!Object.keys(patch).length) return res.status(400).json({ error: "No editable fields in patch" });

        const { updated, missing } = await bulkUpdateErrors(body.ids, patch);
        return res.status(200).json({ ok: true, updated: updated.length, missing, records: updated });
      }

      // ---- single ----
      const id = qid || body.error_id || body.id;
      if (!id) return res.status(400).json({ error: "Missing error id" });

      const { ok, errors, patch } = validatePatchWith(body, await allowedValues());
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "No editable fields in patch" });

      const record = await updateError(id, patch);
      if (!record) return res.status(404).json({ error: "Error not found" });
      return res.status(200).json({ ok: true, record });
    }

    if (req.method === "POST") {
      const body = parseBody(req);

      // Resolve customer + owner from BackBone (read-only) when a customer_id is given
      // and the caller didn't supply them explicitly.
      if (body.customer_id) {
        const resolved = await resolveFromBackbone(body.customer_id);
        if (resolved.customer && !body.customer) body.customer = resolved.customer;
        if (resolved.owner && !body.owner) body.owner = resolved.owner;
      }

      const { ok, errors, record } = validateRecordWith(body, await activeValues());
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      // "Replaced?" only applies to vendor defects. applyDerived() enforces this on
      // every update; do the same on create so a hand-crafted POST can't seed a flag
      // that would skew the replacement stat.
      if (record.error_type !== VENDOR_DEFECT) delete record.replaced;

      record.error_id = await nextErrorId();
      record.date_logged = new Date().toISOString();
      // Attribution comes from the SESSION only — never trust a client-supplied
      // logged_by, or anyone could forge who recorded an error.
      record.logged_by = sess.username || "unknown";
      record.logged_by_name = sess.name || sess.username || "Unknown";

      await saveError(record);
      return res.status(201).json({ ok: true, record });
    }

    if (req.method === "DELETE") {
      // Admin-only. Deleting error records is destructive, so gate on role.
      if (sess.role !== "admin") {
        return res.status(403).json({ error: "Only admins can delete errors" });
      }
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing error id" });
      const removed = await deleteError(id);
      if (!removed) return res.status(404).json({ error: "Error not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("intake error:", e);
    return res.status(500).json({ error: e.message });
  }
}
