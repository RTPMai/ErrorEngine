// lib/users.js — user accounts and roles for ErrorEngine.
//
// Mirrors BackBone's lib/users.js: Redis-stored users, scrypt-hashed passwords,
// configurable roles. Uses ErrorEngine's OWN keys so it's a separate login:
//   errorengine_users  — the user store
//   errorengine_roles  — the role store (roles are data, editable later)
//
// ESM. Do NOT convert to require() — mixing module systems broke BackBone.

import crypto from "crypto";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// ---- Upstash (same conventions as lib/data.js) -----------------------------
async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.result) return null;
  let v = j.result;
  let n = 0;
  while (typeof v === "string" && n < 3) {
    try { v = JSON.parse(v); } catch (e) { break; }
    n++;
  }
  return v;
}

// Writes MUST use /pipeline + SET (never /set/<key>).
async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([["SET", key, JSON.stringify(value)]]),
  });
  if (!r.ok) throw new Error("Upstash write failed: " + r.status);
  return true;
}

// ---- Passwords (scrypt, salted per user) -----------------------------------
export function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), s, 64).toString("hex");
  return s + ":" + derived;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string" || stored.indexOf(":") === -1) return false;
  const [salt, expected] = stored.split(":");
  const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- Roles -----------------------------------------------------------------
// Trimmed to ErrorEngine's actual surface: dashboard / log / records / settings.
const DEFAULT_ROLES = {
  admin: {
    name: "admin", label: "Administrator", protected: true,
    tabs: ["dashboard", "log", "records", "settings"],
    data_scope: "all", can_edit: true, can_export: true,
  },
  manager: {
    name: "manager", label: "Manager", protected: false,
    tabs: ["dashboard", "log", "records"],
    data_scope: "all", can_edit: true, can_export: true,
  },
  staff: {
    name: "staff", label: "Staff", protected: false,
    tabs: ["dashboard", "log", "records"],
    data_scope: "all", can_edit: true, can_export: false,
  },
  viewer: {
    name: "viewer", label: "Viewer (read-only)", protected: false,
    tabs: ["dashboard", "records"],
    data_scope: "all", can_edit: false, can_export: false,
  },
};

export async function getRoles() {
  const stored = await kvGet("errorengine_roles");
  if (!stored || typeof stored !== "object") return Object.assign({}, DEFAULT_ROLES);
  return Object.assign({}, DEFAULT_ROLES, stored);
}

export async function getRole(name) {
  const roles = await getRoles();
  return roles[name] || roles.viewer || DEFAULT_ROLES.viewer;
}

// ---- Users -----------------------------------------------------------------
async function getUsers() {
  const stored = await kvGet("errorengine_users");
  return (stored && typeof stored === "object") ? stored : {};
}

export async function getUser(username) {
  if (!username) return null;
  const users = await getUsers();
  return users[String(username).toLowerCase()] || null;
}

function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username, name: u.name || "", role: u.role,
    created: u.created || null, last_login: u.last_login || null,
  };
}

export async function listUsers() {
  const users = await getUsers();
  return Object.keys(users).map((k) => publicUser(users[k]));
}

export async function createUser({ username, password, name, role }) {
  const u = String(username || "").trim().toLowerCase();
  if (!u || !/^[a-z0-9._-]{3,32}$/.test(u)) {
    throw new Error("Username must be 3-32 chars, letters/numbers/._- only");
  }
  if (!password || String(password).length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const roles = await getRoles();
  if (!roles[role]) throw new Error("Unknown role: " + role);

  const users = await getUsers();
  if (users[u]) throw new Error("That username already exists");

  users[u] = {
    username: u, name: name || u, role,
    hash: hashPassword(password),
    created: new Date().toISOString(), last_login: null,
  };
  await kvSet("errorengine_users", users);
  return publicUser(users[u]);
}

export async function deleteUser(username) {
  const u = String(username || "").trim().toLowerCase();
  const users = await getUsers();
  if (!users[u]) throw new Error("No such user");
  const admins = Object.keys(users).filter((k) => users[k].role === "admin");
  if (users[u].role === "admin" && admins.length <= 1) {
    throw new Error("Cannot delete the last admin account");
  }
  delete users[u];
  await kvSet("errorengine_users", users);
  return true;
}

// Returns the public user on success, null on failure. Callers must not distinguish
// "no such user" from "wrong password" to the client.
export async function authenticate(username, password) {
  const u = String(username || "").trim().toLowerCase();
  const users = await getUsers();
  const rec = users[u];
  if (!rec) {
    hashPassword(String(password || ""), "0".repeat(32)); // burn equal time
    return null;
  }
  if (!verifyPassword(password, rec.hash)) return null;
  rec.last_login = new Date().toISOString();
  users[u] = rec;
  kvSet("errorengine_users", users).catch(() => {});
  return publicUser(rec);
}

// ---- Bootstrap -------------------------------------------------------------
// If NO users exist yet, allow creating the first admin (so a fresh deploy is usable
// without hand-editing Redis). Returns true if the store is empty.
export async function noUsersYet() {
  const users = await getUsers();
  return Object.keys(users).length === 0;
}
