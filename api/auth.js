// api/auth.js — login / logout / me / bootstrap.
//
// ESM handler. Uses lib/session.js (cookies) + lib/users.js (accounts) — the same
// split BackBone uses. Kept SEPARATE from lib/session.js so the route and the library
// can never overwrite each other (the trap BackBone documented).
//
// Actions (via ?action= or JSON { action }):
//   login     POST { username, password }  -> sets cookie
//   logout    POST                          -> clears cookie
//   me        GET                           -> current session or null
//   bootstrap POST { username, password, name } -> creates FIRST admin, only if no users exist

import { setSessionCookie, clearSessionCookie, getSession } from "../lib/session.js";
import { authenticate, createUser, noUsersYet, getUser } from "../lib/users.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query && req.query.action) || (req.body && req.body.action) || "";

  try {
    // ---- who am I ----
    if (action === "me" || req.method === "GET") {
      const sess = getSession(req);
      if (!sess) {
        // needsSetup tells the login page whether to show "create first admin"
        // vs "sign in" — a deterministic check, not a fragile probe.
        let needsSetup = false;
        try { needsSetup = await noUsersYet(); } catch (e) { needsSetup = false; }
        return res.status(200).json({ authenticated: false, needsSetup });
      }
      return res.status(200).json({
        authenticated: true,
        user: { username: sess.username, name: sess.name, role: sess.role },
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};

    // ---- logout ----
    if (action === "logout") {
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    // ---- bootstrap first admin (only when the store is empty) ----
    if (action === "bootstrap") {
      if (!(await noUsersYet())) {
        return res.status(403).json({ error: "Users already exist — bootstrap disabled." });
      }
      const user = await createUser({
        username: body.username,
        password: body.password,
        name: body.name,
        role: "admin",
      });
      setSessionCookie(res, { username: user.username, name: user.name, role: user.role });
      return res.status(201).json({ ok: true, user });
    }

    // ---- login ----
    if (action === "login" || (body.username && body.password)) {
      const user = await authenticate(body.username, body.password);
      if (!user) return res.status(401).json({ error: "Invalid username or password" });
      setSessionCookie(res, { username: user.username, name: user.name, role: user.role });
      return res.status(200).json({ ok: true, user });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error("auth error:", e);
    return res.status(500).json({ error: e.message });
  }
}
