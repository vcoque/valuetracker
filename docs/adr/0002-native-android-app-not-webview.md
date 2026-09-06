# ADR 0002 — Native Android application, not a WebView shell

- **Status:** Accepted
- **Date:** 2026-09-06

## Context

The mobile client could be built three ways: an installable PWA, a WebView shell
(Capacitor) wrapping the web application, or a native application sharing only
logic with the web.

A WebView has real advantages for this product. Charts are the centre of
ValueTracker, and the web charting ecosystem is materially stronger than the
native one; the usage pattern is read-heavy, which WebViews handle well; and it
avoids a second user-interface codebase, which for a small team is the largest
cost multiplier available.

Against that: the intent is to offer native capabilities — home-screen widgets
showing portfolio value, biometric-gated opening, and a genuinely native feel —
and to do so as the product matures rather than as a one-off.

## Decision

Build a native Android application. Do not ship a WebView shell.

Priority order is backend, then web frontend, then Android. iOS is explicitly not
a priority and is not planned.

## Consequences

- **Charting is now a real cost, not a free ride.** The native charting
  ecosystem is weaker than the web's. This is mitigated architecturally rather
  than by library choice: `SPEC-reporting.md` requires the API to return
  chart-ready, pre-aggregated, already-converted series, so the client plots a
  prepared series instead of reducing a dataset.
- **Authentication cannot rely on cookies.** A native client has no browser
  cookie jar, which forces the token design in
  [ADR 0003](./0003-jwt-access-tokens-with-refresh-sessions.md). Had a WebView
  been chosen, the web cookie session would have worked unchanged.
- **`packages/contract` becomes more valuable**, since it is now the only thing
  preventing drift between three consumers rather than two.
- **No shared user-interface layer.** Native Android and the web share patterns
  and the contract, not components. Attempting to share components would leak
  the constraint into every screen for little return.
- `apps/mobile` sits outside the container toolchain; see ADR 0001.

## Alternatives considered

**PWA only.** Rejected as the end state: no widgets, and no biometric unlock.
Still worth shipping as an interim step, since it costs nothing beyond the web
application.

**Capacitor WebView shell.** Rejected. It would have been the cheaper path and a
defensible one, but it is hard to migrate *out* of once users expect native
behaviour, and Apple's guideline 4.2 (irrelevant here, given iOS is not planned)
illustrates the general fragility of thin wrappers. The deciding factor is the
stated intent to invest in native capabilities.

**Cross-platform native (React Native, Flutter, KMP).** Not settled by this ADR.
The decision recorded here is *native rather than WebView*; which native
toolchain to use is deferred until Android work is actually planned. Android-only
scope widens the field, since cross-platform's main advantage does not apply.
