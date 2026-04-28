/**
 * Sphere Cinematic Globe - Route entry (Phase 0 placeholder)
 *
 * Phase 0 deliverable: empty route that builds and renders without
 * importing anything from the investigation app. Phase 1 will replace
 * this body with the R3F Canvas + GlobeCanvas mount.
 *
 * KNOWN LIMITATION - root layout conflict:
 *   src/app/layout.tsx globally mounts the investigation <GlobeCanvas />
 *   inside a `.globe-stage` wrapper. Every route, including /globe,
 *   inherits that mount, so the cinematic globe cannot cleanly take the
 *   viewport until the conflict is resolved. Three candidate fixes
 *   (decision deferred to Phase 1 start, explicit user greenlight
 *   required):
 *     (a) Modify root layout to conditionally mount the investigation
 *         globe based on pathname. Minimal, one-line change, but touches
 *         investigation app code.
 *     (b) Split root layout via a route group `(investigation)` that
 *         owns the existing globe, cinematic globe gets a sibling group
 *         `(cinematic)` with its own bare layout. Cleanest Next.js
 *         pattern, more churn.
 *     (c) CSS suppression: add a route-specific wrapper that hides
 *         `.globe-stage` on /globe. Hackiest, fragile.
 *   See src/components/globe-cinematic/README.md for the trade-off
 *   analysis and Phase 1 resolution plan.
 *
 * This placeholder uses fixed positioning with a high z-index so it sits
 * on top of the investigation globe during Phase 0. It is NOT the final
 * layout strategy.
 */

export default function GlobeCinematicPage() {
  return (
    <main
      data-globe-cinematic-route
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        color: "#888",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 12,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        zIndex: 10,
      }}
    >
      Cinematic Globe &mdash; Phase 0 placeholder
    </main>
  );
}
