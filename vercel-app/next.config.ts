import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this app (the repo root has no lockfile,
  // so Next would otherwise try to infer the root by walking up).
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
