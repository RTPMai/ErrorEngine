// lib/taxonomy-store.js — editable option lists (error types, root causes, statuses).
//
// These three lists started life as hardcoded arrays in lib/schema.js. Moving them
// into Upstash lets the Management role curate them without a deploy, while
// schema.js keeps its arrays as the SEED + fallback so nothing breaks if the key
// is missing or Redis is briefly unreachable.
//
// RETIRE, DON'T DELETE. An option carries { value, label, active }. Retiring sets
// active:false: it vanishes from the dropdowns for NEW records but still validates
// and still renders on the hundreds of historical records that reference it. Hard
// delete is allowed only when zero records use the value (see countUsage in
// api/taxonomy.js), which covers the real case — a typo added five minutes ago.
//
// NOTE: renamed from lib/taxonomy.js to avoid colliding with api/taxonomy.js.
//
// Stored under errorengine_data:taxonomy as { error_type: [...], root_cause: [...], status: [...] }.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "./data.js";
import { KEY_PREFIX, ERROR_TYPES, ROOT_CAUSES, STATUSES } from "./schema.js";

export const TAXONOMY_KEY = `${KEY_PREFIX}:taxonomy`;

// The three curated lists. `field` matches the record field each one populates.
export const LISTS = ["error_type", "root_cause", "status"];

// Seeds come from schema.js so there's exactly one source of the original values.
const SEEDS = {
  error_type: ERROR_TYPES,
  root_cause: ROOT_CAUSES,
  status: STATUSES,
};

// Statuses the dashboard is structurally built on. renderDashboard() counts
// "open" and "resolved" by name, pillClass() colors them, and applyDerived()
// stamps date_resolved off "resolved". These can be RELABELED but never retired
// or deleted, or those features silently stop working.
export const PROTECTED = {
  status: ["open", "resolved"],
  error_type: [],
  root_cause: [],
};

export function isProtected(field, value) {
  return (PROTECTED[field] || []).includes(value);
}

// Title-case for display, matching the front end's titleCase().
function defaultLabel(v) {
  return String(v).replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
}

function seedList(field) {
  return (SEEDS[field] || []).map((v) => ({ value: v, label: defaultLabel(v), active: true }));
}

// Normalize whatever came back from Redis into the canonical option shape.
// Tolerates a plain array of strings, in case an older/hand-written value is there.
function normalizeList(raw, field) {
  if (!Array.isArray(raw) || !raw.length) return seedList(field);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const value = typeof item === "string" ? item : item && item.value;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value: String(value),
      label: (item && item.label) || defaultLabel(value),
      // Anything not explicitly retired counts as active.
      active: item && item.active === false ? false : true,
      // Opt-in flag: when true, choosing this option reveals the fusion price
      // dropdown on the intake form. Keyed off a flag rather than a literal
      // string so renaming or reordering the option can't silently break it.
      ...(item && item.price_list === true ? { price_list: true } : {}),
    });
  }
  return out.length ? out : seedList(field);
}

// Full taxonomy, seeded on first read. Never throws on a missing key.
export async function getTaxonomy() {
  let stored = null;
  try {
    stored = await getRaw(TAXONOMY_KEY);
  } catch (e) {
    // Redis hiccup — fall back to seeds rather than taking the whole app down.
    console.error("taxonomy read failed, using seeds:", e.message);
  }
  const out = {};
  for (const field of LISTS) {
    out[field] = normalizeList(stored && stored[field], field);
  }
  return out;
}

export async function saveTaxonomy(tax) {
  await setRaw(TAXONOMY_KEY, tax);
  return tax;
}

// Values accepted by the validator: every option, active or retired. Historical
// records must keep validating after their option is retired.
export async function getValidValues(field) {
  const tax = await getTaxonomy();
  return (tax[field] || []).map((o) => o.value);
}

// Values offered in the UI for NEW records: active only.
export async function getActiveValues(field) {
  const tax = await getTaxonomy();
  return (tax[field] || []).filter((o) => o.active).map((o) => o.value);
}

// ---- mutations --------------------------------------------------------------
// Each returns the updated list, or throws a message meant for the user.

function findIndex(list, value) {
  return list.findIndex((o) => o.value === value);
}

export async function addOption(field, { value, label }) {
  if (!LISTS.includes(field)) throw new Error(`Unknown list: ${field}`);

  // Values are stored lowercase because every existing record and all the
  // front-end comparisons ('open', 'vendor defect') are lowercase.
  const v = String(value || "").trim().toLowerCase();
  if (!v) throw new Error("Value is required");
  if (v.length > 60) throw new Error("Value must be 60 characters or fewer");

  const tax = await getTaxonomy();
  const list = tax[field];
  const existing = findIndex(list, v);
  if (existing >= 0) {
    // Re-adding a retired option reactivates it instead of erroring — that's
    // almost always what was meant, and avoids a confusing "already exists".
    if (!list[existing].active) {
      list[existing].active = true;
      if (label) list[existing].label = String(label).trim();
      await saveTaxonomy(tax);
      return { list, reactivated: true };
    }
    throw new Error(`"${v}" already exists in ${field.replace("_", " ")}`);
  }

  list.push({ value: v, label: String(label || "").trim() || defaultLabel(v), active: true });
  await saveTaxonomy(tax);
  return { list, reactivated: false };
}

// Retire (active:false) or restore (active:true).
export async function setOptionActive(field, value, active) {
  if (!LISTS.includes(field)) throw new Error(`Unknown list: ${field}`);
  const tax = await getTaxonomy();
  const list = tax[field];
  const i = findIndex(list, value);
  if (i < 0) throw new Error(`"${value}" not found`);

  if (!active && isProtected(field, value)) {
    throw new Error(`"${value}" is a system ${field.replace("_", " ")} and can't be retired`);
  }
  // Refuse to retire the last usable option, which would leave the intake form
  // with an empty dropdown and make new records impossible to file.
  if (!active && list.filter((o) => o.active).length <= 1) {
    throw new Error(`At least one active ${field.replace("_", " ")} is required`);
  }

  list[i].active = !!active;
  await saveTaxonomy(tax);
  return list;
}

export async function renameOption(field, value, label) {
  if (!LISTS.includes(field)) throw new Error(`Unknown list: ${field}`);
  const l = String(label || "").trim();
  if (!l) throw new Error("Label is required");
  if (l.length > 60) throw new Error("Label must be 60 characters or fewer");

  const tax = await getTaxonomy();
  const list = tax[field];
  const i = findIndex(list, value);
  if (i < 0) throw new Error(`"${value}" not found`);

  // Only the LABEL changes. The stored value is what every record references, so
  // renaming it would orphan them all — protected entries included, which is why
  // relabeling stays available for "open" and "resolved".
  list[i].label = l;
  await saveTaxonomy(tax);
  return list;
}

// Toggle the price-list flag on an option. Only meaningful on root_cause today,
// but stored generically so any list could opt in later.
export async function setOptionPriceList(field, value, on) {
  if (!LISTS.includes(field)) throw new Error(`Unknown list: ${field}`);
  const tax = await getTaxonomy();
  const list = tax[field];
  const i = findIndex(list, value);
  if (i < 0) throw new Error(`"${value}" not found`);

  if (on) list[i].price_list = true;
  else delete list[i].price_list;

  await saveTaxonomy(tax);
  return list;
}

// ---- price list -------------------------------------------------------------
// Flat list of { id, label, unit_cost }, curated by Management. Picking an entry
// on an error line fills that line's unit cost; the value is copied onto the line,
// never referenced by id, so editing a price later never rewrites historical costs.

export const PRICE_KEY = `${KEY_PREFIX}:prices`;

const SEED_PRICES = [
  { label: "4x4", unit_cost: 8 },
  { label: "5x11", unit_cost: 10 },
  { label: "11x11", unit_cost: 12 },
];

function normalizePrices(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const p of raw) {
    if (!p || !p.label) continue;
    const cost = Number(p.unit_cost);
    if (Number.isNaN(cost)) continue;
    out.push({
      id: String(p.id || p.label).trim(),
      label: String(p.label).trim(),
      unit_cost: round2(cost),
    });
  }
  return out;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export async function getPrices() {
  let stored = null;
  try {
    stored = await getRaw(PRICE_KEY);
  } catch (e) {
    console.error("price list read failed, using seeds:", e.message);
  }
  const norm = normalizePrices(stored);
  // Seed on first read, but treat a deliberately emptied list as valid — only a
  // missing/corrupt key falls back to seeds.
  if (norm === null) return SEED_PRICES.map((p) => ({ ...p, id: p.label }));
  return norm;
}

export async function savePrices(list) {
  await setRaw(PRICE_KEY, list);
  return list;
}

export async function addPrice({ label, unit_cost }) {
  const l = String(label || "").trim();
  if (!l) throw new Error("Label is required");
  if (l.length > 60) throw new Error("Label must be 60 characters or fewer");
  const cost = Number(unit_cost);
  if (Number.isNaN(cost) || cost < 0) throw new Error("Cost must be a number of 0 or more");

  const list = await getPrices();
  if (list.some((p) => p.label.toLowerCase() === l.toLowerCase())) {
    throw new Error(`"${l}" already exists in the price list`);
  }
  list.push({ id: l, label: l, unit_cost: round2(cost) });
  await savePrices(list);
  return list;
}

export async function updatePrice(id, { label, unit_cost }) {
  const list = await getPrices();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`"${id}" not found`);

  if (label !== undefined) {
    const l = String(label).trim();
    if (!l) throw new Error("Label is required");
    if (list.some((p, j) => j !== i && p.label.toLowerCase() === l.toLowerCase())) {
      throw new Error(`"${l}" already exists in the price list`);
    }
    list[i].label = l;
  }
  if (unit_cost !== undefined) {
    const cost = Number(unit_cost);
    if (Number.isNaN(cost) || cost < 0) throw new Error("Cost must be a number of 0 or more");
    // Existing errors keep the cost copied onto their lines, so this only affects
    // errors logged from here on.
    list[i].unit_cost = round2(cost);
  }

  await savePrices(list);
  return list;
}

export async function deletePrice(id) {
  const list = await getPrices();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) throw new Error(`"${id}" not found`);
  await savePrices(next);
  return next;
}

// Hard delete. The caller MUST verify usage === 0 first; this enforces the
// protected/last-option rules but can't see the record set.
export async function deleteOption(field, value) {
  if (!LISTS.includes(field)) throw new Error(`Unknown list: ${field}`);
  if (isProtected(field, value)) {
    throw new Error(`"${value}" is a system ${field.replace("_", " ")} and can't be deleted`);
  }

  const tax = await getTaxonomy();
  const list = tax[field];
  const i = findIndex(list, value);
  if (i < 0) throw new Error(`"${value}" not found`);
  if (list.filter((o) => o.active).length <= 1 && list[i].active) {
    throw new Error(`At least one active ${field.replace("_", " ")} is required`);
  }

  list.splice(i, 1);
  await saveTaxonomy(tax);
  return list;
}
