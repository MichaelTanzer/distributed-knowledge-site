/**
 * Styles for /v4-staging only; every selector uses the v4s- prefix. The page
 * also reuses .generate-shell and .notice from app/globals.css.
 *
 * Rendered as an inline <style> by page.tsx instead of an imported .css file:
 * a CSS import adds a CSS chunk to the shared webpack runtime, which changes
 * the runtime file referenced by every other page (including /generate).
 * Inline styles keep the shared build output byte-identical.
 */
export const V4_STAGING_CSS = `
.v4s-panel {
  width: min(640px, 100%);
  display: grid;
  gap: 22px;
}
.v4s-header { display: grid; gap: 6px; }
.v4s-title {
  margin: 0;
  font-size: clamp(28px, 4vw, 40px);
  font-weight: 300;
  letter-spacing: -0.01em;
}
.v4s-sub,
.v4s-muted {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  letter-spacing: 0.04em;
}
.v4s-label {
  margin: 0 0 6px;
  padding: 0;
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.v4s-budget,
.v4s-pending,
.v4s-status {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line);
  background: rgba(22, 24, 18, 0.18);
}
.v4s-facts {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px 18px;
}
.v4s-facts dt {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.v4s-facts dd {
  margin: 2px 0 0;
  font-size: 14px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.v4s-facts code { font-size: 12px; }
.v4s-form { display: grid; gap: 16px; }
.v4s-field { display: grid; gap: 6px; }
.v4s-form select,
.v4s-form input[type="text"],
.v4s-form input[type="email"],
.v4s-submit,
.v4s-link {
  border: 1px solid var(--line);
  background: rgba(245, 245, 241, 0.08);
  color: var(--ink);
  padding: 13px 14px;
  font: inherit;
}
.v4s-form select option { color: #11130f; }
.v4s-form input[readonly] { color: var(--muted); cursor: default; }
.v4s-lanes {
  margin: 0;
  padding: 0;
  border: 0;
  display: grid;
  gap: 8px;
}
.v4s-lane {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
  align-items: start;
  padding: 12px 14px;
  border: 1px solid var(--line);
  background: rgba(22, 24, 18, 0.18);
  cursor: pointer;
}
.v4s-lane:has(input:checked) { border-color: rgba(208, 173, 86, 0.7); }
.v4s-lane input { margin: 3px 0 0; accent-color: var(--gold); }
.v4s-lane-body { display: grid; gap: 3px; }
.v4s-lane-title { font-size: 15px; }
.v4s-lane-meta { font-size: 12px; line-height: 1.45; color: var(--muted); }
.v4s-ack {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: start;
  font-size: 13px;
  line-height: 1.5;
}
.v4s-ack input { margin: 3px 0 0; accent-color: var(--gold); }
.v4s-submit,
.v4s-link {
  background: rgba(22, 24, 18, 0.18);
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.v4s-link {
  justify-self: start;
  padding: 8px 12px;
  font-size: 11px;
}
.v4s-submit:disabled,
.v4s-link:disabled { opacity: .55; cursor: not-allowed; }
.v4s-warn { color: #ffd9a0; font-weight: 400; }
.v4s-message { margin: 0; }
.v4s-pending { border-color: rgba(255, 217, 160, 0.55); }
.v4s-message + .v4s-message { margin-top: 4px; }
.v4s-footnote { font-size: 11px; }
.v4s-notice { margin: 0; font-size: 13px; line-height: 1.5; color: var(--ink); }
.v4s-recipient-hint { margin: 0; }
.v4s-form input:disabled,
.v4s-form select:disabled { opacity: .6; }
.v4s-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.v4s-state {
  display: inline-block;
  padding: 2px 8px;
  border: 1px solid var(--line);
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.v4s-state-running,
.v4s-state-queued { border-color: rgba(208, 173, 86, 0.7); color: var(--gold-light); }
.v4s-state-delivered { border-color: rgba(198, 232, 170, 0.7); color: #e7f5d6; }
.v4s-state-failed,
.v4s-state-interrupted,
.v4s-state-interrupted_unreconciled { border-color: rgba(255, 190, 190, 0.7); color: #ffd0d0; }
`;
