// lib/user-store.js — ErrorEngine user store (Upstash, errorengine_data: prefix).
//
// Users live in ONE key as { [username]: record }. Roles live in another.
// Password hashing: scrypt via node:crypto — no native deps, Vercel-safe
// (bcrypt would need a native build).
//
// Stored hash format: scrypt$N$salt_b64$hash_b64
//
// Consumed by api/auth.js (login / bootstrap / me) and api/users.js (admin CRUD).
// NOTE: renamed from lib/users.js to avoid a filename collision with api/users.js.
// Session shape is set by api/auth.js as { username, name, role } — lib/session.js
// checks sess.role, so `role` is a single string, not an array.
//
// ESM. Do NOT convert to module.exports — mixing module systems is what produced
// "requireAuth is undefined" in BackBone.

import crypto from "crypto";
import { getRaw, setRaw } from "./data.js";
import { keys } from "./schema.js";

const SCRYPT_N = 16384;
const KEYLEN = 64;

export const DEFAULT_ROLES = {
  admin:      { label: "Administrator" },
  management: { label: "Management" },
  user:       { label: "Standard User" },
  viewer:     { label: "Read Only" },
};

function scrypt(password, salt, len = KEYLEN, n = SCRYPT_N) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, len, { N: n }, (err, dk) =>
      err ? reject(err) : resolve(dk)
    );
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt);
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, saltB64, hashB64] = String(stored || "").split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const dk = await scrypt(password, salt, expected.length, Number(n));
    if (dk.length !== expected.length) return false;
    return crypto.timingSafeEqual(dk, expected);
  } catch (e) {
    return false;
  }
}

// ---- store helpers ----------------------------------------------------------

const norm = (u) => String(u || "").trim().toLowerCase();

async function readUsers() {
  const data = await getRaw(keys.users());
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

async function writeUsers(map) {
  await setRaw(keys.users(), map);
  return map;
}

// Public shape — NEVER includes password_hash.
function publicUser(u) {
  return {
    username: u.username,
    name: u.name || u.username,
    role: u.role,
    created_at: u.created_at || null,
    last_login: u.last_login || null,
  };
}

// ---- roles ------------------------------------------------------------------

export async function getRoles() {
  const stored = await getRaw(keys.roles());
  // Merge rather than return stored wholesale: if a roles map was written before
  // "management" existed, returning it as-is would permanently hide the new role
  // and make createUser reject it. Stored labels still win for any role present
  // in both, so custom relabeling survives.
  if (stored && typeof stored === "object" && Object.keys(stored).length) {
    return { ...DEFAULT_ROLES, ...stored };
  }
  return DEFAULT_ROLES;
}

// ---- reads ------------------------------------------------------------------

// Drives the "create first admin" screen in api/auth.js.
export async function noUsersYet() {
  const map = await readUsers();
  return Object.keys(map).length === 0;
}

export async function listUsers() {
  const map = await readUsers();
  return Object.values(map)
    .map(publicUser)
    .sort((a, b) => a.username.localeCompare(b.username));
}

// Full record INCLUDING the hash — for login only. Never send to a client.
export async function getUserRecord(username) {
  const map = await readUsers();
  return map[norm(username)] || null;
}

export async function getUser(username) {
  const rec = await getUserRecord(username);
  return rec ? publicUser(rec) : null;
}

export async function countAdmins() {
  const map = await readUsers();
  return Object.values(map).filter((u) => u.role === "admin").length;
}

// ---- writes -----------------------------------------------------------------

export async function createUser({ username, password, name, role }) {
  const u = norm(username);
  if (!u) throw new Error("Username is required");
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) {
    throw new Error("Username must be 3-32 chars: letters, numbers, dot, dash, underscore");
  }
  if (!password || String(password).length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const roles = await getRoles();
  const r = String(role || "user");
  if (!roles[r]) throw new Error(`Unknown role: ${r}`);

  const map = await readUsers();
  if (map[u]) throw new Error(`User "${u}" already exists`);

  const rec = {
    username: u,
    name: String(name || u).trim(),
    role: r,
    password_hash: await hashPassword(password),
    created_at: new Date().toISOString(),
    last_login: null,
  };

  map[u] = rec;
  await writeUsers(map);
  return publicUser(rec);
}

export async function deleteUser(username) {
  const u = norm(username);
  const map = await readUsers();
  if (!map[u]) throw new Error(`User "${u}" not found`);

  if (map[u].role === "admin" && (await countAdmins()) <= 1) {
    throw new Error("Can't delete the last admin");
  }

  delete map[u];
  await writeUsers(map);
  return true;
}

export async function updateUser(username, patch = {}) {
  const u = norm(username);
  const map = await readUsers();
  const rec = map[u];
  if (!rec) throw new Error(`User "${u}" not found`);

  if (patch.name !== undefined) rec.name = String(patch.name).trim();

  if (patch.role !== undefined) {
    const roles = await getRoles();
    if (!roles[patch.role]) throw new Error(`Unknown role: ${patch.role}`);
    if (rec.role === "admin" && patch.role !== "admin" && (await countAdmins()) <= 1) {
      throw new Error("Can't demote the last admin");
    }
    rec.role = patch.role;
  }

  if (patch.password !== undefined) {
    if (String(patch.password).length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    rec.password_hash = await hashPassword(patch.password);
  }

  map[u] = rec;
  await writeUsers(map);
  return publicUser(rec);
}

export async function touchLastLogin(username) {
  const u = norm(username);
  const map = await readUsers();
  if (!map[u]) return null;
  map[u].last_login = new Date().toISOString();
  await writeUsers(map);
  return publicUser(map[u]);
}

// Login helper — verifies and returns the public user, or null.
export async function authenticate(username, password) {
  const rec = await getUserRecord(username);
  if (!rec) {
    // Burn comparable work so a missing user isn't distinguishable by timing.
    await hashPassword("dummy");
    return null;
  }
  const ok = await verifyPassword(password, rec.password_hash);
  return ok ? publicUser(rec) : null;
}
