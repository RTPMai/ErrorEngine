// api/intake.js — log an error. Mirrors BackBone's api/intake.js + api/save.js shape.
//
// GET  -> list all error records (newest first), for the dashboard.
// POST -> validate, resolve customer/owner from backbone_data (read-only), write.
//
// ESM handler, guarded by requireAuth(req, res) from lib/session.js — the same
// signature BackBone uses. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { validateRecord } from "../lib/schema.js";
import { listErrors, saveError, nextErrorId, resolveFromBackbone } from "../lib/data.js";

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
      record.logged_by = sess.username || sess.name || sess.role || "unknown";

      await saveError(record);
      return res.status(201).json({ ok: true, record });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("intake error:", e);
    return res.status(500).json({ error: e.message });
  }
}
