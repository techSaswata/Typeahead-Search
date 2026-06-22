/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // avoid double-invoking engine bootstrap in dev
  // better-sqlite3 is a native module; keep it external to the server bundle.
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
};

export default nextConfig;
