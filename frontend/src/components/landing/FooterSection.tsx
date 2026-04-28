"use client";

const STACK_TAGS = [
  "Next.js",
  "TypeScript",
  "Three.js",
  "FastAPI",
  "PostgreSQL / PostGIS",
  "Redis",
  "WebSockets",
  "Zustand",
];

export function FooterSection() {
  return (
    <footer className="site-footer" id="architecture">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <div className="site-footer__logo">
            <div className="site-footer__logo-mark" />
            <span>SPHERE</span>
          </div>
          <p className="site-footer__tagline">
            Search-first operational risk investigation platform with hybrid retrieval,
            grounded evidence, and analyst export workflows.
          </p>
        </div>

        <div className="site-footer__stack">
          <span className="site-footer__stack-label">Technology Stack</span>
          <div className="site-footer__stack-tags">
            {STACK_TAGS.map((tag) => (
              <span key={tag} className="site-footer__tag">
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="site-footer__bottom">
        <span>Built with discipline. Designed for analysts.</span>
      </div>
    </footer>
  );
}
