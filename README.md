# Distributed Knowledge Site

Minimal Vercel site for Distributed Knowledge.

## Generate UX

`/generate` is public. HTTP Basic Auth (`INFOPACK_WEB_PASSWORD`) was removed in commit a60bc61, which deleted the old `middleware.ts`; the current `middleware.ts` does no authentication (it only switches between v3 and v4, below).
The form posts to `/api/generate`, which forwards to a backend generation endpoint configured by:

- `INFOPACK_BACKEND_URL`
- `INFOPACK_BACKEND_TOKEN`

Until those backend env vars are set, the page returns a clear `503` configuration error rather than pretending generation succeeded.

## v4 on `/generate` (with automatic v3 fallback)

`/generate` serves the **v4 form** whenever v4 is enabled, and the **unchanged v3 form** otherwise. The switch is `middleware.ts` (it only matches `/generate` and `/api/generate`); `app/generate/*` and `app/api/generate/*` are not modified.

v4 is enabled when **both** of these are set (non-empty), in Production or Preview:

- `DK_V4_STAGING_URL`: the v4 backend base URL. It must use HTTPS (plain HTTP is accepted only for a loopback host in local tests) and may include a path prefix;
- `DK_V4_STAGING_TOKEN`: the bearer token for the v4 backend (distinct from `INFOPACK_BACKEND_TOKEN`).

| `DK_V4_*` variables | `/generate` | `/api/generate` (v3) | `/api/v4/*` |
|---|---|---|---|
| both set | v4 form (served from the internal route `/generate-v4`) | `410` "Generation has moved to the new form; reload /generate." (no v3 upstream call; refused by `middleware.ts` and again by the route itself) | enabled |
| neither set | v3 form, byte-identical to before | v3, unchanged | `404` |
| only one set | v3 form (as above) | v3, unchanged | `404`; the server logs a `v4_partial_config` warning naming the variables (never their values) |

`middleware.ts` fails open: if it throws, the request continues to the unchanged route and a `v4_middleware_error` event (error name only) is logged. The v3 route (`app/api/generate/route.ts`) checks the same two variables itself and answers the same `410` before any v3 work when v4 is enabled, so a middleware failure or an edge/Node configuration mismatch never reaches the paid v3 backend.

Rollback: remove the `DK_V4_*` variables from the environment and redeploy; `/generate` is v3 again. The site never falls back to v3 automatically after a v4 refusal (busy, paused, rate limit, capacity).

Operational note: the route sends the backend's current lane cap as `ack_cap_usd`, and the backend binds an idempotency key to the whole body. If a lane cap changes while a submission is unresolved, its retry gets `409 idempotency_conflict`; the browser keeps the record (it never discards an unresolved submission) and asks the requester to contact Distributed Knowledge. Change lane caps only when no submission is pending.

The v4 form asks for the requester's email, a KIQ (SL-002 / SL-028 / SL-035) and a provider (OpenAI, Google, xAI or Anthropic). The expert packet is emailed to the requester.

- **Providers come from the backend.** The form offers a provider only if the backend's `GET /v1/config` `lanes` lists it, and shows the backend's generator model name (static fallback names are in `LANES`, `lib/v4Staging.ts`). While the config is loading or unavailable it offers today's three (OpenAI, Google, xAI) and never Anthropic. A lane whose `unavailablePilots` contains the selected KIQ is shown disabled with "Not available for this case", can't be submitted, and a previous selection of it is cleared. The rules are in `lib/v4Lanes.ts`.
- **Case descriptions.** Under the KIQ drop-down the form shows a short description of the selected case (`aria-describedby` on the select). The text is the `CASE_DESCRIPTIONS` table in `lib/v4Staging.ts`, written only from the public topic and questions of each frozen setup. Requests survive lost responses and reloads: each submission's idempotency key and exact body (including the email) are stored in the browser's IndexedDB before it is sent, retries reuse them, and every record change is serialised across tabs with a Web Lock. Browsers without Web Locks or usable storage cannot submit.

## v4 operator page (Preview only)

`/v4-staging` is the operator view of the same form (budget figures, reservation caps, acknowledgement). It returns `404` unless `VERCEL_ENV` is `preview` **and** v4 is enabled. On Preview the API also returns operator views (budget figures, backend messages). On Production the API responses and the rendered pages carry no monetary values, and every error message is replaced by public wording; the lane reservation caps in `lib/v4Staging.ts` are public source.

## v4 API routes

All Node.js runtime, dynamic, `Cache-Control: no-store`; `404` unless v4 is enabled.

| Route | Backend call | Notes |
|---|---|---|
| `GET /api/v4/config` | `GET /v1/config` | Sanitised view: spend state, run in progress, reconciliation, and the offered lanes (`lane`, generator `model`, `unavailablePilots` only); on Preview also remaining budget and lane caps. |
| `POST /api/v4/requests` | `GET /v1/config`, then `POST /v1/requests` | Same-origin only (`Sec-Fetch-Site` must be `same-origin`, a missing header is refused, and `Origin` must match). Body at most 2 KB with exactly `pilot`, `lane`, `recipient`. `recipient` must match the backend's requester grammar exactly: a local part of letters, digits, `_`, `%`, `+` and `-` in dot-separated parts, not starting with `-` or `.` and at most 64 characters; domain labels of letters, digits and inner hyphens; a 2–63 letter TLD; at most 254 characters in total (else `400 invalid_recipient`, before any backend call). Requires a UUID `Idempotency-Key`. `ack_cap_usd` is supplied from the backend config for the chosen lane. A lane the config does not list (`400 lane_unavailable`) or a lane/KIQ pair in its `unavailablePilots` (`400 lane_pilot_unavailable`) is refused without calling `POST /v1/requests`. |
| `GET /api/v4/requests/<id>` | `GET /v1/requests/<id>` | Status: state, reason code, timestamps (money fields on Preview only). |

The routes send the backend only `Authorization: Bearer`, `X-DK-Client-IP` (the first `x-forwarded-for` entry, if it is a valid IP), `Idempotency-Key` and a JSON content type. Browser cookies and other headers are never forwarded. The `Origin` and `Sec-Fetch-Site` checks are browser CSRF protection, not authorization: a non-browser client can set them; the backend's own per-IP and per-address limits and admission control apply. Known backend error codes (`rate_limited`, `daily_spend_ceiling_reached`, `run_in_progress`, `duplicate`, `idempotency_conflict`, `cap_ack_mismatch`, `spend_disabled`, `staging_budget_exhausted`, `reconciliation_required`, `recipient_not_allowed`, `invalid_recipient`, `origin_not_allowed`, `bad_client_ip`, `lane_pilot_unavailable`) keep their code; on Preview the backend message passes through, on Production the public wording replaces it. Anything else becomes a generic error. All backend JSON field names are kept in `BACKEND_FIELDS` in `lib/v4Staging.ts`.

Unit tests: `npm test` (Node's built-in test runner on a `tsc` build in `.test-dist/`; no extra dependencies).

No backend address or token belongs in this repository.
