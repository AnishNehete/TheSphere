/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001"],
  // Phase 17C beta-hardening — security response headers. Conservative
  // defaults applied to every response. Tightened for /share/* so a
  // shared snapshot cannot be cached and cannot be framed.
  async headers() {
    const baseSecurity = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=()",
      },
      // HSTS is silently ignored over plain HTTP, so it's safe to keep
      // on for local dev too — production HTTPS picks it up.
      {
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      },
    ];
    return [
      { source: "/:path*", headers: baseSecurity },
      {
        source: "/share/:path*",
        headers: [
          ...baseSecurity,
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
