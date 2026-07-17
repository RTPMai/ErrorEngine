// api/customers.js — read-only customer list from backbone_data, for the intake dropdown.
//
// This is the ErrorEngine <-> BackBone connection in one route: it reads the shared
// backbone_data key and returns { customer_id, name } pairs. ErrorEngine never writes
// backbone_data — this endpoint is GET-only and touches nothing.
//
// ESM handler, requireAuth-guarded, same shape as BackBone.

import { requireAuth } from "../lib/session.js";
import { listBackboneCustomers, getBackboneData } from "../lib/data.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { lastSynced } = await getBackboneData();
    const customers = await listBackboneCustomers();
    return res.status(200).json({ customers, lastSynced, source: "backbone_data (read-only)" });
  } catch (e) {
    console.error("customers error:", e);
    return res.status(500).json({ error: e.message });
  }
}
