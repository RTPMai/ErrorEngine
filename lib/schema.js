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
  cost:          { type: "number", required: true,  source: "computed/user", def: "Dollar cost (reprint qty x price chart)." },
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
      if (def.source !== "generated") errors.push(`${name} is required`);
    }

    if (val !== undefined) rec[name] = val;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}
