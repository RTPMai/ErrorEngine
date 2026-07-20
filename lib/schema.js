// lib/schema.js — ErrorEngine error-record schema (v1).
//
// ESM (`export`), matching BackBone. Do NOT convert to module.exports —
// mixing module systems is what produced "requireAuth is undefined" in BackBone.
//
// One record = one production error. Follows the field/def discipline from
// Exec_Sum__Data_Schema.xlsx. Stored in the SHARED Upstash instance under the
// errorengine_data: prefix so it never collides with backbone_data or DecoBoard/ShopStock.

export const KEY_PREFIX = "errorengine_data";

// Redis keys — everything ErrorEngine writes lives under its prefix.
export const keys = {
  record: (id) => `${KEY_PREFIX}:error:${id}`,
  index: () => `${KEY_PREFIX}:index`, // set of all error_ids
  counter: () => `${KEY_PREFIX}:counter`, // incrementing id source
  users: () => `${KEY_PREFIX}:users`, // { [username]: userRecord }
  roles: () => `${KEY_PREFIX}:roles`, // { [roleName]: { label } }
};

// ---- Enumerations (single source of truth) ----

export const ERROR_TYPES = [
  "misprint",
  "wrong garment",
  "wrong size/color",
  "short ship",
  "late",
  "art error",
  "vendor defect",
  "replacement/reprint",
];

export const ROOT_CAUSES = [
  "art",
  "production",
  "purchasing",
  "vendor",
  "CSR",
  "customer-supplied",
];

export const STATUSES = ["open", "in review", "resolved", "written-off"];

// Field definitions — modeled on Exec_Sum schema (type, required, enum, source, def).
export const FIELDS = {
  error_id:      { type: "string", required: true,  source: "generated",     def: "Unique error ID (EE-#####)." },
  invoice_ref:   { type: "string", required: true,  source: "printavo",      def: "Printavo invoice / visual ID the error belongs to." },
  customer_id:   { type: "string", required: true,  source: "backbone",      def: "BackBone customer_id — the join key into backbone_data." },
  customer:      { type: "string", required: false, source: "backbone",      def: "Resolved company name (from backbone_data.synced)." },
  error_type:    { type: "enum",   required: true,  enum: ERROR_TYPES,       source: "user",          def: "What went wrong." },
  root_cause:    { type: "enum",   required: true,  enum: ROOT_CAUSES,       source: "user",          def: "Where the error originated." },
  owner:         { type: "string", required: false, source: "backbone/user", def: "AM/CSR/vendor responsible (from backbone_data enrichment)." },
  description:   { type: "string", required: true,  source: "user",          def: "What happened and why." },
  units:         { type: "number", required: true,  source: "user",          def: "Units affected." },
  unit_cost:     { type: "number", required: true,  source: "user",          def: "Dollar cost per unit." },
  cost:          { type: "number", required: true,  source: "computed",      def: "Total dollar cost — always unit_cost x units. Recomputed server-side; never trusted from the client." },
  status:        { type: "enum",   required: true,  enum: STATUSES,          source: "user",          def: "Lifecycle state." },
  logged_by:     { type: "string", required: false, source: "session",       def: "Username of whoever recorded the error (from session, not user-editable)." },
  logged_by_name:{ type: "string", required: false, source: "session",       def: "Display name of whoever recorded the error." },
  date_logged:   { type: "date",   required: true,  source: "generated",     def: "When logged." },
  date_resolved: { type: "date",   required: false, source: "user",          def: "When resolved — for cycle-time analytics." },
};

// Validate + normalize an incoming record.
// Returns { ok: true, record } or { ok: false, errors: [...] }.
export function validateRecord(input) {
  const errors = [];
  const rec = {};

  // cost is DERIVED, never accepted from the client. If units and unit_cost are
  // both present and numeric, cost = unit_cost x units. Otherwise leave it unset
  // and let the required-check below report the underlying missing field.
  const _u = Number(input.units);
  const _uc = Number(input.unit_cost);
  input = { ...input };
  if (!Number.isNaN(_u) && !Number.isNaN(_uc) && input.units !== "" && input.unit_cost !== "" &&
      input.units != null && input.unit_cost != null) {
    input.cost = round2(_uc * _u);
  } else {
    delete input.cost;
  }

  for (const [name, def] of Object.entries(FIELDS)) {
    let val = input[name];

    if (def.type === "number" && val !== undefined && val !== "" && val !== null) {
      val = Number(val);
      if (Number.isNaN(val)) errors.push(`${name} must be a number`);
    }

    if (def.enum && val && !def.enum.includes(val)) {
      errors.push(`${name} must be one of: ${def.enum.join(", ")}`);
    }

    if (def.required && (val === undefined || val === "" || val === null)) {
      // "generated" (error_id, date_logged) and "computed" (cost) are filled in by
      // the server, not the caller — a missing cost always traces back to units or
      // unit_cost, which report their own errors above.
      if (def.source !== "generated" && def.source !== "computed") {
        errors.push(`${name} is required`);
      }
    }

    if (val !== undefined) rec[name] = val;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

// Round to cents. Money math on floats drifts (0.1*3 = 0.30000000000000004),
// so every computed cost goes through this.
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Validate a PARTIAL update (PATCH). Unlike validateRecord this does NOT enforce
// required-ness — only the fields actually present are checked. Returns
// { ok, patch } or { ok: false, errors }.
//
// Fields the client must never set directly are stripped rather than rejected, so
// a UI that round-trips a whole record can't escalate by echoing them back.
const IMMUTABLE = new Set(["error_id", "date_logged", "logged_by", "logged_by_name", "cost"]);

export function validatePatch(input) {
  const errors = [];
  const patch = {};

  for (const [name, val0] of Object.entries(input || {})) {
    if (IMMUTABLE.has(name)) continue; // silently ignored
    const def = FIELDS[name];
    if (!def) continue;               // unknown field — ignore

    let val = val0;

    if (def.type === "number" && val !== undefined && val !== "" && val !== null) {
      val = Number(val);
      if (Number.isNaN(val)) { errors.push(`${name} must be a number`); continue; }
    }

    if (def.enum && val && !def.enum.includes(val)) {
      errors.push(`${name} must be one of: ${def.enum.join(", ")}`);
      continue;
    }

    // Don't let a required field be blanked out via PATCH.
    if (def.required && (val === undefined || val === "" || val === null)) {
      errors.push(`${name} cannot be empty`);
      continue;
    }

    patch[name] = val;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, patch };
}

// ---- taxonomy-aware validation ----------------------------------------------
// The enum arrays above are the SEED values. Once lib/taxonomy-store.js is in play the
// live lists live in Redis, so these variants check enum fields against the stored
// taxonomy — including RETIRED values, since historical records must keep
// validating after an option is retired.
//
// `allowed` is { error_type: [...], root_cause: [...], status: [...] }. Any list
// that's missing or empty falls back to the seed enum in FIELDS.
//
// The sync validateRecord/validatePatch stay exported and unchanged for callers
// that don't need the live lists.

const TAXONOMY_FIELDS = ["error_type", "root_cause", "status"];

// Resolve the enum for a field: live list if provided, else the seed.
function enumFor(name, def, allowed) {
  if (allowed && TAXONOMY_FIELDS.includes(name)) {
    const live = allowed[name];
    if (Array.isArray(live) && live.length) return live;
  }
  return def.enum;
}

export function validateRecordWith(input, allowed) {
  const errors = [];
  const rec = {};

  const _u = Number(input.units);
  const _uc = Number(input.unit_cost);
  input = { ...input };
  if (!Number.isNaN(_u) && !Number.isNaN(_uc) && input.units !== "" && input.unit_cost !== "" &&
      input.units != null && input.unit_cost != null) {
    input.cost = round2(_uc * _u);
  } else {
    delete input.cost;
  }

  for (const [name, def] of Object.entries(FIELDS)) {
    let val = input[name];

    if (def.type === "number" && val !== undefined && val !== "" && val !== null) {
      val = Number(val);
      if (Number.isNaN(val)) errors.push(`${name} must be a number`);
    }

    const allowedVals = enumFor(name, def, allowed);
    if (allowedVals && val && !allowedVals.includes(val)) {
      errors.push(`${name} must be one of: ${allowedVals.join(", ")}`);
    }

    if (def.required && (val === undefined || val === "" || val === null)) {
      if (def.source !== "generated" && def.source !== "computed") {
        errors.push(`${name} is required`);
      }
    }

    if (val !== undefined) rec[name] = val;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

export function validatePatchWith(input, allowed) {
  const errors = [];
  const patch = {};

  for (const [name, val0] of Object.entries(input || {})) {
    if (IMMUTABLE.has(name)) continue;
    const def = FIELDS[name];
    if (!def) continue;

    let val = val0;

    if (def.type === "number" && val !== undefined && val !== "" && val !== null) {
      val = Number(val);
      if (Number.isNaN(val)) { errors.push(`${name} must be a number`); continue; }
    }

    const allowedVals = enumFor(name, def, allowed);
    if (allowedVals && val && !allowedVals.includes(val)) {
      errors.push(`${name} must be one of: ${allowedVals.join(", ")}`);
      continue;
    }

    if (def.required && (val === undefined || val === "" || val === null)) {
      errors.push(`${name} cannot be empty`);
      continue;
    }

    patch[name] = val;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, patch };
}

// Given an existing record plus a patch, recompute derived fields.
// Kept here (not in data.js) so the cost formula lives in exactly one place.
export function applyDerived(merged) {
  const u = Number(merged.units);
  const uc = Number(merged.unit_cost);
  if (!Number.isNaN(u) && !Number.isNaN(uc)) merged.cost = round2(uc * u);

  // Status drives the resolution timestamp both ways, so reopening a record
  // clears a stale date_resolved instead of leaving it to contradict the status.
  if (merged.status === "resolved") {
    if (!merged.date_resolved) merged.date_resolved = new Date().toISOString();
  } else {
    delete merged.date_resolved;
  }
  return merged;
}
