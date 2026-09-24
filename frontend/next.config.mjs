/**
 * Next.js rewrites API calls to the EchoLabs backend (the "tool gateway").
 * Run `npm run dev --workspace=backend` alongside `npm run dev --workspace=frontend`.
 */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:4000/api/:path*",
      },
    ];
  },
};

export default nextConfig;