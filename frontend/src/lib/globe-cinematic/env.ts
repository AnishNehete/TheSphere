/**
 * Sphere Cinematic Globe - Environment Contract (Phase 0)
 *
 * Reads and validates env vars used by the cinematic globe. Callers MUST
 * use these accessors, not raw process.env lookups, so missing config
 * fails loud at Phase 1 runtime instead of producing a silent blank globe.
 *
 * Note on Next.js env inlining:
 *   Next.js only inlines `process.env.NEXT_PUBLIC_*` when accessed via
 *   literal property notation (e.g. `process.env.NEXT_PUBLIC_FOO`). Do not
 *   refactor these reads into dynamic lookups such as
 *   `process.env[key]` - they will become undefined in the client bundle.
 */

/**
 * Retrieve the Google Maps Platform API key used by the 3D Tiles loader.
 *
 * @throws Error if the env var is missing or empty. The message explains
 *   exactly which key is required and what the key must have enabled.
 */
export function getGoogleMapsApiKey(): string {
  const value = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      "[globe-cinematic] Missing required env var: " +
        "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY. Set it in frontend/.env.local " +
        "with a Google Maps Platform API key that has Map Tiles API and " +
        "Photorealistic 3D Tiles enabled, with billing active on the " +
        "owning Google Cloud project.",
    );
  }
  return value;
}

/**
 * Non-throwing check, useful for conditional UI (e.g. rendering a
 * fallback "configure API key" state instead of crashing the tree).
 */
export function hasGoogleMapsApiKey(): boolean {
  const value = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  return typeof value === "string" && value.trim() !== "";
}
