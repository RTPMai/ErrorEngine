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

// The one error type that collects the "Replaced?" flag. Kept as a named constant
// so the intake form, the detail view, applyDerived, and the dashboard stat all
// key off the same string. NOTE: Manage Lists can retire this option; if it is,
// nothing breaks, but the flag simply stops being collected on new records.
export const VENDOR_DEFECT = "vendor defect";

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
  units:         { type: "number", required: true,  source: "computed/user", def: "Units affected. Sum of line units when the record has lines; typed directly otherwise." },
  unit_cost:     { type: "number", required: false, source: "user",          def: "Dollar cost per unit. Used only for single-line (legacy-style) records; records with lines carry per-line costs instead." },
  lines:         { type: "array",  required: false, source: "user",          def: "Line items: [{ label, units, unit_cost }]. One incident can span several priced items (e.g. 4x4 and 11x11 fusion) without being logged as separate errors." },
  replaced:      { type: "boolean", required: false, source: "user",          def: "Whether the vendor replaced the goods. Only collected for vendor defects; absent on other error types and on records logged before this field existed." },
  cost:          { type: "number", required: true,  source: "computed",      def: "Total dollar cost — always unit_cost x units. Recomputed server-side; never trusted from the client." },
  status:        { type: "enum",   required: true,  enum: STATUSES,          source: "user",          def: "Lifecycle state." },
  logged_by:     { type: "string", required: false, source: "session",       def: "Username of whoever recorded the error (from session, not user-editable)." },
  logged_by_name:{ type: "string", required: false, source: "session",       def: "Display name of whoever recorded the error." },
  date_logged:   { type: "date",   required: true,  source: "generated",     def: "When logged." },
  date_resolved: { type: "date",   required: false, source: "user",          def: "When resolved — for cycle-time analytics." },
};

// Coerce a checkbox/JSON boolean. Forms submit "on"/"true"/"false" as STRINGS, so
// Boolean("false") would be true — parse explicitly instead. Returns undefined for
// values that aren't recognizably boolean, which the caller reports as an error.
export function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === 0) return !!v;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "on" || s === "yes" || s === "1") return true;
  if (s === "false" || s === "off" || s === "no" || s === "0" || s === "") return false;
  return undefined;
}

// ---- line items -------------------------------------------------------------
// A record's cost is the sum of its lines. Records created before lines existed
// (and simple single-item errors) carry a flat units + unit_cost instead; both
// shapes are supported permanently so nothing needs migrating.

export function normalizeLines(raw) {
  if (!Array.isArray(raw)) return { lines: null, errors: [] };
  const errors = [];
  const lines = [];

  raw.forEach((l, i) => {
    if (!l || typeof l !== "object") { errors.push(`line ${i + 1} is malformed`); return; }
    const units = Number(l.units);
    const unitCost = Number(l.unit_cost);
    if (Number.isNaN(units)) { errors.push(`line ${i + 1}: units must be a number`); return; }
    if (Number.isNaN(unitCost)) { errors.push(`line ${i + 1}: unit cost must be a number`); return; }
    if (units < 0 || unitCost < 0) { errors.push(`line ${i + 1}: values can't be negative`); return; }

    lines.push({
      // Free text so a line can describe itself even without a price-list entry.
      label: String(l.label || "").trim(),
      units,
      unit_cost: round2(unitCost),
      total: round2(units * unitCost),
    });
  });

  return { lines, errors };
}

// Total cost + total units for a record, whichever shape it uses.
export function totalsFor(rec) {
  if (Array.isArray(rec.lines) && rec.lines.length) {
    let cost = 0, units = 0;
    for (const l of rec.lines) {
      cost += (Number(l.unit_cost) || 0) * (Number(l.units) || 0);
      units += Number(l.units) || 0;
    }
    return { cost: round2(cost), units };
  }
  const u = Number(rec.units), uc = Number(rec.unit_cost);
  if (Number.isNaN(u) || Number.isNaN(uc)) return null;
  return { cost: round2(u * uc), units: u };
}

// Validate + normalize an incoming record.
// Returns { ok: true, record } or { ok: false, errors: [...] }.
export function validateRecord(input) {
  const errors = [];
  const rec = {};

  // cost is DERIVED, never accepted from the client. If units and unit_cost are
  // both present and numeric, cost = unit_cost x units. Otherwise leave it unset
  // and let the required-check below report the underlying missing field.
  input = { ...input };

  // Lines win when present: cost AND units are both derived from them, so a
  // multi-line error can never disagree with its own total. Falls back to the
  // flat units x unit_cost shape for simple and pre-existing records.
  if (input.lines !== undefined) {
    const { lines, errors: lineErrors } = normalizeLines(input.lines);
    if (lineErrors.length) {
      return { ok: false, errors: lineErrors };
    }
    if (lines && lines.length) {
      input.lines = lines;
      const t = totalsFor({ lines });
      input.cost = t.cost;
      input.units = t.units;
      delete input.unit_cost;
    } else {
      // An explicitly empty array means "no lines" — drop it and fall through.
      delete input.lines;
    }
  }

  if (input.lines === undefined) {
    const _u = Number(input.units);
    const _uc = Number(input.unit_cost);
    if (!Number.isNaN(_u) && !Number.isNaN(_uc) && input.units !== "" && input.unit_cost !== "" &&
        input.units != null && input.unit_cost != null) {
      input.cost = round2(_uc * _u);
    } else {
      delete input.cost;
    }
  }

  for (const [name, def] of Object.entries(FIELDS)) {
    let val = input[name];

    if (def.type === "number" && val !== undefined && val !== "" && val !== null) {
      val = Number(val);
      if (Number.isNaN(val)) errors.push(`${name} must be a number`);
    }

    if (def.type === "boolean" && val !== undefined && val !== null) {
      const b = toBool(val);
      if (b === undefined) errors.push(`${name} must be true or false`);
      else val = b;
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

  // Every record needs a cost from one shape or the other. Without this a record
  // with no lines and no unit_cost would save with an undefined cost and quietly
  // drop out of every dollar total.
  if (!errors.length && rec.cost === undefined) {
    errors.push("Provide either line items or a cost per unit");
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

    if (def.type === "boolean" && val !== undefined && val !== null) {
      const b = toBool(val);
      if (b === undefined) { errors.push(`${name} must be true or false`); continue; }
      val = b;
    }

    if (def.type === "array" && val !== undefined && val !== null) {
      const { lines, errors: lineErrors } = normalizeLines(val);
      if (lineErrors.length) { errors.push(...lineErrors); continue; }
      // An empty array clears the lines and hands cost back to units x unit_cost.
      val = lines;
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

  input = { ...input };

  // Lines win when present: cost AND units are both derived from them, so a
  // multi-line error can never disagree with its own total. Falls back to the
  // flat units x unit_cost shape for simple and pre-existing records.
  if (input.lines !== undefined) {
    const { lines, errors: lineErrors } = normalizeLines(input.lines);
    if (lineErrors.length) {
      return { ok: false, errors: lineErrors };
    }
    if (lines && lines.length) {
      input.lines = lines;
      const t = totalsFor({ lines });
      input.cost = t.cost;
      input.units = t.units;
      delete input.unit_cost;
    } else {
      // An explicitly empty array means "no lines" — drop it and fall through.
      delete input.lines;
    }
  }

  if (input.lines === undefined) {
    const _u = Number(input.units);
    const _uc = Number(input.unit_cost);
    if (!Number.isNaN(_u) && !Number.isNaN(_uc) && input.units !== "" && input.unit_cost !== "" &&
        input.units != null && input.unit_cost != null) {
      input.cost = round2(_uc * _u);
    } else {
      delete input.cost;
    }
  }

  for (const [name, def] of Object.entries(FIELDS)) {
    let val = input[name];

    if (def.type === "number" && val !== undefined && val !== "" && val !== null) {
      val = Number(val);
      if (Number.isNaN(val)) errors.push(`${name} must be a number`);
    }

    if (def.type === "boolean" && val !== undefined && val !== null) {
      const b = toBool(val);
      if (b === undefined) errors.push(`${name} must be true or false`);
      else val = b;
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

  // Every record needs a cost from one shape or the other. Without this a record
  // with no lines and no unit_cost would save with an undefined cost and quietly
  // drop out of every dollar total.
  if (!errors.length && rec.cost === undefined) {
    errors.push("Provide either line items or a cost per unit");
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

    if (def.type === "boolean" && val !== undefined && val !== null) {
      const b = toBool(val);
      if (b === undefined) { errors.push(`${name} must be true or false`); continue; }
      val = b;
    }

    if (def.type === "array" && val !== undefined && val !== null) {
      const { lines, errors: lineErrors } = normalizeLines(val);
      if (lineErrors.length) { errors.push(...lineErrors); continue; }
      // An empty array clears the lines and hands cost back to units x unit_cost.
      val = lines;
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
  // Lines are authoritative when present — recompute both cost and units from
  // them so an edited line can't leave a stale total behind.
  const t = totalsFor(merged);
  if (t) {
    merged.cost = t.cost;
    merged.units = t.units;
  }
  if (Array.isArray(merged.lines) && merged.lines.length) {
    merged.lines = merged.lines.map((l) => ({
      label: String(l.label || "").trim(),
      units: Number(l.units) || 0,
      unit_cost: round2(Number(l.unit_cost) || 0),
      total: round2((Number(l.units) || 0) * (Number(l.unit_cost) || 0)),
    }));
    delete merged.unit_cost;
  }

  // "Replaced?" is only meaningful for vendor defects. If a record is edited to a
  // different error type, drop the flag rather than leaving a value that no longer
  // applies and would skew the replacement stat.
  if (merged.error_type !== VENDOR_DEFECT) delete merged.replaced;

  // Status drives the resolution timestamp both ways, so reopening a record
  // clears a stale date_resolved instead of leaving it to contradict the status.
  if (merged.status === "resolved") {
    if (!merged.date_resolved) merged.date_resolved = new Date().toISOString();
  } else {
    delete merged.date_resolved;
  }
  return merged;
}
