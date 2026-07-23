'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   proxy_kick.js — the "Proxy" owner-action for the Owner Decisions docket.

   Owner intent (2026-07-11): "add a Proxy button so I can kick the decision to
   the proxy if it is out of my domain." The owner-proxy is a standing protocol
   (corpus + pressure-test + morning adjudication scorecard) that rules on a
   decision instead of the owner.

   This file is SELF-CONTAINED so three concurrent surgeons editing app.js /
   serve.mjs / style.css don't collide with it:
     • pure logic on window.ProxyKick (esc, humanReason, isHumanRequired,
       buttonHtml, derivedBanner) — unit-testable in Node with a window shim.
     • its own <style> block, injected on load — zero style.css edit.
   app.js touches are 4 tiny guarded additive hooks (see PROXY-KICK markers).

   WRITE PATH (unchanged): the button renders `data-do="proxy"`, so app.js's
   existing delegated [data-do] handler routes it through postResponse() →
   POST /api/respond with {decision_id, action:'proxy', note:''} on the exact
   token-gated append-only path. serve.mjs additively whitelists 'proxy'. Like
   Approve/Park, Proxy is a note-less routing action; the proxy agent supplies
   the ruling + note downstream (its own ledger + morning scorecard).

   KICKED STATE is DERIVED FROM THE LEDGER, never local UI state: app.js folds
   /data/owner_responses.json to the latest response per decision on every 15s
   poll; when that latest action is 'proxy', the card renders derivedBanner().

   HONESTY GUARD (LAW 3): some decision categories are human-required by standing
   protocol (calibrated values, publishes/releases, deletions, naming, money,
   keys, anything irreversible; and fail-closed when there is no on-record
   recommendation). For those the Proxy button STILL WORKS (it is the owner's
   call) but shows an inline caution that any proxy ruling is advisory and an
   echo-confirm is still required. The matcher enumeration is transcribed from
   test_results/dashboard_wave_2026-07-11/proxy_recommendations.md Part 3
   ("Testable predicate summary"). Never blocks, never silently accepts.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Human-gate matcher — transcribed from proxy_recommendations.md Part 3.
  // Each class is advisory-caution-triggering; the button still fires either way.
  const RX = {
    calibrated: /\bSOLVER_|\bsigma\b|σ|\bgate\b|calibrat|\brecal/i,   // calibrated / gate constants (echo-confirm)
    publish:    /public|installer|distribution|\bR2\b|latest\.json|\brelease\b/i, // public distribution
    keys:       /login|\bauth\b|credential|\bkey\b|password|cloudflare|signing/i, // keys / auth / money-adjacent
    naming:     /rename|\bbrand\b|\bname\b|\bURI\b|endpoint/i,          // naming / brand / structural interaction
    deletion:   /delete|retire|archive|mark dead|deprecat/i,           // deletion / archive / retire
  };
  const IRREVERSIBLE = /\b(one-way|irreversible|permanent|no rollback)\b/i;

  /** The concatenated DECISION CONTENT a decision is matched against.
   *  NB: dc.source (a file path) is DELIBERATELY excluded — a path like
   *  data_distribution_plan.md would false-positive the publish rule. Source is
   *  used only in the calibrated-sign-off predicate below (RECAL_TABLE/GATES.md). */
  function hay(dc) {
    const parts = [dc.category, dc.title, dc.summary, dc.recommendation];
    if (Array.isArray(dc.blocking)) parts.push(dc.blocking.join(' '));
    else if (dc.blocking != null) parts.push(String(dc.blocking));
    return parts.filter((x) => x != null).join(' ');
  }

  /**
   * Return a short human-required reason string, or null if proxy-eligible.
   * Fail-closed: a decision with no on-record recommendation is NEVER
   * proxy-eligible (mirrors the classifier's `recommendation==null → HUMAN`).
   */
  function humanReason(dc) {
    if (!dc || typeof dc !== 'object') return 'unclassifiable — treat as human-required';
    if (dc.recommendation == null) return 'fail-closed: no on-record recommendation';
    // calibrated sign-off: category==sign-off ∧ source∈{RECAL_TABLE,GATES.md}
    if (String(dc.category ?? '') === 'sign-off' && /RECAL_TABLE|GATES\.md/i.test(String(dc.source ?? ''))) {
      return 'calibrated sign-off — echo-confirm required';
    }
    const h = hay(dc);
    if (RX.calibrated.test(h)) return 'calibrated / gate constants — echo-confirm required';
    if (RX.publish.test(h))    return 'publish / public distribution';
    if (RX.keys.test(h))       return 'keys / auth / money';
    if (RX.naming.test(h))     return 'naming / brand / structural interaction';
    if (RX.deletion.test(h))   return 'deletion / archive / retire';
    if (IRREVERSIBLE.test(h))  return 'irreversible action';
    return null;
  }

  function isHumanRequired(dc) { return humanReason(dc) != null; }

  /** The Proxy button (+ inline caution when human-required). Fed dc so the
   *  guard can classify. Always enabled — the caution never blocks. */
  function buttonHtml(id, dc) {
    const reason = humanReason(dc);
    const btn = `<button type="button" class="dc-btn proxy${reason ? ' human-req' : ''}" data-do="proxy" data-id="${esc(id)}"`
      + ` title="kick this decision to the owner-proxy (out-of-domain) — proxy rules + morning scorecard">⇄ Proxy</button>`;
    const caution = reason
      ? `<div class="proxy-caution" title="${esc(reason)}">⚠ Human-required category — proxy ruling will be advisory; echo-confirm still required.</div>`
      : '';
    return btn + caution;
  }

  /** The from-ledger "kicked to proxy" state. Called by app.js when the latest
   *  folded response for a decision has action==='proxy'. Re-derived every poll. */
  function derivedBanner(resp, dc) {
    const advisory = dc && isHumanRequired(dc)
      ? ' <span class="pk-advisory">· human-required — ruling advisory, echo-confirm still required</span>'
      : '';
    return `<div class="proxy-kicked">⇄ KICKED TO PROXY — pending proxy ruling + morning scorecard${advisory}</div>`;
  }

  // ---- self-injected styles (no shared style.css edit) ----------------------
  function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('proxy-kick-styles')) return;
    const css = `
      .dc-btn.proxy { border-color:#5b6ea8; color:#c7d2f0; }
      .dc-btn.proxy:hover { background:#2a335a; }
      .dc-btn.proxy.human-req { border-color:#7a6a3a; }
      .proxy-caution { flex-basis:100%; margin-top:6px; font-size:11px; line-height:1.4;
        color:#d8b56a; background:#2a2513; border:1px solid #5c5027; border-radius:4px; padding:5px 8px; }
      .proxy-kicked { margin-top:8px; font-size:12px; font-weight:600; letter-spacing:.02em;
        color:#c7d2f0; background:#232c4c; border:1px solid #46538a; border-radius:4px; padding:7px 10px; }
      .proxy-kicked .pk-advisory { font-weight:400; color:#d8b56a; }
      .chip.resp-proxy { background:#2b3560; color:#c7d2f0; border:1px solid #46538a; }
    `;
    const el = document.createElement('style');
    el.id = 'proxy-kick-styles';
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }
  injectStyles();

  const api = { esc, hay, humanReason, isHumanRequired, buttonHtml, derivedBanner };
  if (typeof window !== 'undefined') window.ProxyKick = api;
  else if (typeof globalThis !== 'undefined') globalThis.ProxyKick = api;
})();
