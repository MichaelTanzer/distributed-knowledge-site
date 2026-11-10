# Distributed Knowledge Site

Minimal Vercel site for Distributed Knowledge.

## Generate UX

`/generate` is public. HTTP Basic Auth (`INFOPACK_WEB_PASSWORD`) was removed in commit a60bc61, which deleted `middleware.ts`.
The form posts to `/api/generate`, which forwards to a backend generation endpoint configured by:

- `INFOPACK_BACKEND_URL`
- `INFOPACK_BACKEND_TOKEN`

Until those backend env vars are set, the page returns a clear `503` configuration error rather than pretending generation succeeded.

## v4 staging page (Preview only)

`/v4-staging` is a technical-trial form for the DK v4 staging backend. It exists only on the Vercel Preview of branch `feat/v4-staging`, behind Vercel Authentication. The page and its API routes return `404` unless all of these hold:

- `VERCEL_ENV` is `preview` (Vercel sets this; production and local builds never match);
- `DK_V4_STAGING_URL` is set: the staging backend base URL. It must use HTTPS (plain HTTP is accepted only for a loopback host in local tests) and may include a path prefix;
- `DK_V4_STAGING_TOKEN` is set: the bearer token for the staging backend (distinct from `INFOPACK_BACKEND_TOKEN`).

Scope both `DK_V4_*` variables to **Preview, branch `feat/v4-staging`** only. Never add them to Production. No backend address or token belongs in this repository.

Routes (all Node.js runtime, dynamic, `Cache-Control: no-store`):

| Route | Backend call | Notes |
|---|---|---|
| `GET /api/v4/config` | `GET /v1/config` | Returns a sanitised view: allowlisted recipient, remaining daily and total budget, spend state, lane caps. |
| `POST /api/v4/requests` | `POST /v1/requests` | Same-origin only (`Sec-Fetch-Site` must be `same-origin`, a missing header is refused, and `Origin` must match). Body at most 2 KB with exactly `pilot`, `lane`, `ack_cap_usd`. Requires a UUID `Idempotency-Key`. The recipient comes from the backend config, never from the browser. |
| `GET /api/v4/requests/<id>` | `GET /v1/requests/<id>` | Status: state, committed USD, reason code. |

The routes send the backend only `Authorization: Bearer`, `X-DK-Client-IP` (the first `x-forwarded-for` entry, if it is a valid IP), `Idempotency-Key` and a JSON content type. Browser cookies and other headers are never forwarded. Known backend error codes (`rate_limited`, `daily_spend_ceiling_reached`, `run_in_progress`, `duplicate`, `idempotency_conflict`, `cap_ack_mismatch`, `spend_disabled`, `staging_budget_exhausted`, `reconciliation_required`, `recipient_not_allowed`, `origin_not_allowed`, `bad_client_ip`) pass their message through; anything else becomes a generic error. All backend JSON field names are kept in `BACKEND_FIELDS` in `lib/v4Staging.ts`.
