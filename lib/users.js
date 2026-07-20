// api/users.js — admin-only user management.
//
// GET    -> list users (public fields only; never hashes)
// POST   -> create a user { username, password, name, role }
// DELETE -> remove a user ?username=...
//
// ESM handler. Guarded by requireAuth(req, res, "admin") — the third arg makes
// lib/session.js send a 403 for any non-admin, so only admins reach the body.

import { requireAuth } from "../lib/session.js";
import { listUsers, createUser, deleteUser, getRoles } from "../lib/users.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  // GUARD: admin role required for every action below.
  const sess = requireAuth(req, res, "admin");
  if (!sess) return; // 401/403 already sent

  try {
    if (req.method === "GET") {
      const [users, roles] = await Promise.all([listUsers(), getRoles()]);
      // Send role names + labels so the UI can build its dropdown.
      const roleList = Object.keys(roles).map((k) => ({
        name: k,
        label: roles[k].label || k,
      }));
      return res.status(200).json({ users, roles: roleList });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const user = await createUser({
        username: body.username,
        password: body.password,
        name: body.name,
        role: body.role,
      });
      return res.status(201).json({ ok: true, user });
    }

    if (req.method === "DELETE") {
      const username = (req.query && req.query.username) || (req.body && req.body.username);
      if (!username) return res.status(400).json({ error: "Missing username" });
      // Don't let an admin delete their own account out from under themselves.
      if (String(username).toLowerCase() === String(sess.username).toLowerCase()) {
        return res.status(400).json({ error: "You can't delete your own account" });
      }
      await deleteUser(username);
      return res.status(200).json({ ok: true, deleted: username });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("users error:", e);
    // createUser/deleteUser throw readable messages (duplicate name, weak password,
    // last-admin protection) — surface them to the admin as a 400.
    return res.status(400).json({ error: e.message });
  }
}
