"use client";

// Phase 14 — tasteful GitHub support affordance.
// One icon button. Secondary weight. No banner, no popup, no marketing noise.
// The repo URL is resolved from NEXT_PUBLIC_GITHUB_REPO so deployments can
// retarget a fork without a code change, with a safe default.
const DEFAULT_REPO_URL = "https://github.com/anishnehete/TheSphere";

function resolveRepoUrl(): string {
  const env =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_GITHUB_REPO
      : undefined;
  return env && env.length > 0 ? env : DEFAULT_REPO_URL;
}

export function GithubStarCTA() {
  const href = resolveRepoUrl();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="ws-github-cta"
      aria-label="Star Sphere on GitHub"
      title="If you like Sphere, consider starring the project"
      data-testid="github-star-cta"
    >
      <svg
        className="ws-github-cta__icon"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden
      >
        <path
          fill="currentColor"
          d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.72 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.82 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"
        />
      </svg>
      <span className="ws-github-cta__label">Star</span>
    </a>
  );
}
