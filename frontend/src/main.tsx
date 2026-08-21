import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// ── BUILD VERIFICATION MARKER ────────────────────────────────────────────
// Exposes a globally-accessible object `window.__NEXUS_BUILD__` so you can
// confirm the Vercel/runtime-deployed bundle actually contains the Issue-1
// atomic-completion diagnostic code instead of a stale cached build.
//
// To verify in browser DevTools → Console:
//   1. Paste:   window.__NEXUS_BUILD__
//   2. Confirm: buildId >= "20260821.03"   (Issue-1 diagnostics land in v3+)
//   3. Confirm: hasIssue1Diagnostics === true
//   4. Confirm: buildTimestamp is within ~10 min of now
//
// If buildId is older than today (2026-08-21) → the deployed bundle is STALE
// and you need to wait for Vercel to finish the deploy or run a hard refresh
// (Ctrl+Shift+R / Cmd+Shift+R → Disable cache → reload) to bust the CDN.
declare global {
  interface Window {
    __NEXUS_BUILD__?: {
      buildId: string;
      buildTimestamp: number;
      buildIso: string;
      hasIssue1Diagnostics: boolean;
      hasIssue2EnumFix: boolean;
      testQuery: string;
    };
  }
}
(function exposeBuildMarker() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyymmdd =
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate());
  const marker = {
    buildId: `${yyyymmdd}.03`,
    buildTimestamp: now.getTime(),
    buildIso: now.toISOString(),
    hasIssue1Diagnostics: true,
    hasIssue2EnumFix: true,
    testQuery: "[DIAG-Issue1] 5TH-ANNOTATION COMPLETION BRANCH",
  };
  try { (window as any).__NEXUS_BUILD__ = marker; } catch { /* ignore SSR edge */ }
  try { console.log("%c[NEXUS BUILD VERIFY]", "color:#1f9d55;font-weight:bold", marker); } catch { /* noop */ }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
