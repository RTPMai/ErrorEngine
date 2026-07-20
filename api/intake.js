// api/intake.js — log an error. Mirrors BackBone's api/intake.js + api/save.js shape.
//
// GET  -> list all error records (newest first), for the dashboard.
// POST -> validate, resolve customer/owner from backbone_data (read-only), write.
//
// ESM handler, guarded by requireAuth(req, res) from lib/session.js — the same
// signature BackBone uses. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { validateRecord } from "../lib/schema.js";
import { listErrors, saveError, nextErrorId, resolveFromBackbone, deleteError } from "../lib/data.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  // GUARD. Everything below requires a valid ErrorEngine session.
  const sess = requireAuth(req, res);
  if (!sess) return; // 401 already sent

  try {
    if (req.method === "GET") {
      return res.status(200).json({ errors: await listErrors() });
    }

    if (req.method === "POST") {
      const body = req.body || {};

      // Resolve customer + owner from BackBone (read-only) when a customer_id is given
      // and the caller didn't supply them explicitly.
      if (body.customer_id) {
        const resolved = await resolveFromBackbone(body.customer_id);
        if (resolved.customer && !body.customer) body.customer = resolved.customer;
        if (resolved.owner && !body.owner) body.owner = resolved.owner;
      }

      const { ok, errors, record } = validateRecord(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

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
      const id = (req.query && req.query.id) || (req.body && req.body.id);
      if (!id) return res.status(400).json({ error: "Missing error id" });
      const removed = await deleteError(id);
      if (!removed) return res.status(404).json({ error: "Error not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("intake error:", e);
    return res.status(500).json({ error: e.message });
  }
}
