# ErrorEngine

Quality/accountability layer for P&M Apparel. Logs production errors (misprints,
wrong garments, replacements, late ships, art errors, vendor defects), attributes
root cause and owner, quantifies cost, and surfaces patterns for continuous improvement.

Built to match BackBone's real conventions and read its data — not a separate silo.

## How it connects to BackBone

Both apps share one Upstash Redis instance. That shared DB *is* the connection —
no app-to-app API needed.

- **BackBone** owns and writes the `backbone_data` key: `{ synced, enrichment, lastSynced }`.
- **ErrorEngine** reads `backbone_data` **read-only** to resolve customer + AM owner,
  and writes only its own `errorengine_data:*` keys.

So logging an error against a customer auto-fills the company name (from `synced`)
and the accountable AM (from `enrichment[customer_id].account_manager`). This is why
the AM roster file isn't needed — BackBone already holds it in Redis.

```
ErrorEngine  ──reads──►  backbone_data        (read-only, never written)
ErrorEngine  ──writes─►  errorengine_data:*   (its own namespace)
```

## Conventions matched from BackBone

- **ESM everywhere** (`import` / `export default`). BackBone's own comments document that
  mixing CJS/ESM caused `requireAuth is undefined` and `setSessionCookie is not a function`
  outages. ErrorEngine is 100% ESM — `package.json` sets `"type": "module"`.
- **`lib/session.js`, not `lib/auth.js`.** BackBone hit a trap where `api/auth.js` overwrote
  `lib/auth.js`. ErrorEngine avoids the name entirely.
- **`requireAuth(req, res, requiredRole)`** — sends its own 401/403, returns session or null.
  Called inside the handler, not as a wrapper.
- **KV split**: reads via `GET /get/{key}`, writes via `POST /pipeline` + SET (never `/set/key`).
- **Defensive unwrap** of double-encoded / chunked KV values, copied from BackBone's `data.js`.
- **Own login, shared crypto**: cookie is `errorengine_session` but signed with the same
  `SESSION_SECRET` and HMAC-SHA256/base64url format, 12-hour expiry.

## Structure

```
lib/schema.js      Error-record schema + validation. errorengine_data: prefix.
lib/session.js     Signed session cookies (mirrors BackBone lib/session.js).
lib/data.js        KV access (/get + /pipeline, unwrap) + READ-ONLY backbone_data reader.
api/intake.js      GET list / POST log. requireAuth-guarded. Auto-resolves from BackBone.
api/customers.js   GET BackBone customer roster (read-only) for the intake dropdown.
public/index.html  Intake form + dashboard. BackBone styling (Inter / #F4F6F8 / #3D9A5C).
package.json       "type": "module" — ESM.
vercel.json        Routing.
```

## Deploy

1. **Env vars in Vercel** (redeploy after — env only applies to new deployments):
   - `KV_REST_API_URL` / `KV_REST_API_TOKEN` — from Upstash (`UPSTASH_REDIS_REST_URL` / `_TOKEN`).
     Same shared instance as BackBone; ErrorEngine only writes `errorengine_data:*`.
   - `SESSION_SECRET` — **must be the same value as BackBone's** so the cookie format matches.
   - `PRINTAVO_API_TOKEN` / `PRINTAVO_EMAIL` — only if you later add direct Printavo lookup;
     not required, since customer/owner already come from `backbone_data`.
2. Deploy. `public/index.html` probes `/api/intake`; if reachable it runs live, otherwise it
   falls back to an in-memory demo so the page always works.

## Still open

- **api/auth.js + lib/users.js** — ErrorEngine needs a login route + user store. If you want
  it to reuse BackBone's users, share those two files and I'll point ErrorEngine at the same
  user records. Until then, `requireAuth` works against any valid same-format session cookie.
- **PRICE_CHART_2.xlsx** — to auto-compute `cost` (reprint qty x chart) instead of manual entry.
- **Role scoping** — currently all authenticated users see all errors. BackBone's `data.js` has
  an "own vs all" scope; easy to mirror for AMs once wanted.
