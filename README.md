# Distributed Knowledge Site

Minimal Vercel site for Distributed Knowledge.

## Generate UX

`/generate` is protected by HTTP Basic Auth via `INFOPACK_WEB_PASSWORD`.
The form posts to `/api/generate`, which forwards to a backend generation endpoint configured by:

- `INFOPACK_BACKEND_URL`
- `INFOPACK_BACKEND_TOKEN`

Until those backend env vars are set, the page returns a clear `503` configuration error rather than pretending generation succeeded.
