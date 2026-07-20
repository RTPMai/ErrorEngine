// api/taxonomy.js — curate the error type / root cause / status lists.
//
// GET    -> { taxonomy, usage, protected }   any signed-in user (the intake form
//                                            needs the active options to render)
// POST   -> add an option                    management + admin only
// PATCH  -> retire / restore / relabel       management + admin only
// DELETE -> hard delete, only if unused      management + admin only
//
// Writes are restricted to the taxonomy lists. Management deliberately does NOT
// get user management or error deletion — those stay admin-only in api/users.js
// and api/intake.js.
//
// NOTE ON THE GUARD: this calls requireAuth(req, res) with two args and checks
// sess.role itself, rather than passing a role as the third arg. api/users.js
// passes "admin" as a third arg, but that form takes a single role — this route
// allows two, so the check lives here where it can't be ambiguous.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import {
  getTaxonomy, addOption, setOptionActive, renameOption, deleteOption,
  LISTS, PROTECTED,
} from "../lib/taxonomy-store.js";
import { listErrors } from "../lib/data.js";

// Roles allowed to modify the lists.
const CAN_EDIT = ["admin", "management"];

// Vercel doesn't always pre-parse JSON bodies. Normalize so field access is safe.
function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

// How many records reference each value, per list. Drives two things in the UI:
// the "in use by N records" hint, and whether hard delete is offered at all.
async function countUsage() {
  const errors = await listErrors();
  const usage = {};
  for (const field of LISTS) usage[field] = {};
  for (const e of errors) {
    for (const field of LISTS) {
      const v = e[field];
      if (v == null || v === "") continue;
      usage[field][v] = (usage[field][v] || 0) + 1;
    }
  }
  return usage;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return; // 401 already sent

  try {
    // READ is open to any signed-in user — the intake form can't render its
    // dropdowns without it.
    if (req.method === "GET") {
      const [taxonomy, usage] = await Promise.all([getTaxonomy(), countUsage()]);
      return res.status(200).json({
        taxonomy,
        usage,
        protected: PROTECTED,
        can_edit: CAN_EDIT.includes(sess.role),
      });
    }

    // Everything past here mutates the lists.
    if (!CAN_EDIT.includes(sess.role)) {
      return res.status(403).json({ error: "Only management and admins can edit these lists" });
    }

    const body = parseBody(req);
    const field = body.field || (req.query && req.query.field);
    if (!LISTS.includes(field)) {
      return res.status(400).json({ error: `field must be one of: ${LISTS.join(", ")}` });
    }

    if (req.method === "POST") {
      const { list, reactivated } = await addOption(field, { value: body.value, label: body.label });
      return res.status(201).json({ ok: true, field, list, reactivated });
    }

    if (req.method === "PATCH") {
      const value = body.value;
      if (!value) return res.status(400).json({ error: "Missing value" });

      // action: "retire" | "restore" | "rename"
      if (body.action === "rename") {
        const list = await renameOption(field, value, body.label);
        return res.status(200).json({ ok: true, field, list });
      }
      if (body.action === "retire" || body.action === "restore") {
        const list = await setOptionActive(field, value, body.action === "restore");
        return res.status(200).json({ ok: true, field, list });
      }
      return res.status(400).json({ error: 'action must be "retire", "restore", or "rename"' });
    }

    if (req.method === "DELETE") {
      const value = (req.query && req.query.value) || body.value;
      if (!value) return res.status(400).json({ error: "Missing value" });

      // The safety rail: refuse to delete anything a record still points at.
      // Retiring is the supported path for options that are in use.
      const usage = await countUsage();
      const n = (usage[field] && usage[field][value]) || 0;
      if (n > 0) {
        return res.status(409).json({
          error: `"${value}" is used by ${n} record${n === 1 ? "" : "s"}. Retire it instead — it will disappear from new-record dropdowns but stay readable on existing records.`,
          usage: n,
        });
      }

      const list = await deleteOption(field, value);
      return res.status(200).json({ ok: true, field, list, deleted: value });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("taxonomy error:", e);
    // taxonomy.js throws user-facing messages (duplicate, protected, last-option).
    return res.status(400).json({ error: e.message });
  }
}
