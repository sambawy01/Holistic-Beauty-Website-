import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this app (the repo root has no lockfile,
  // so Next would otherwise try to infer the root by walking up).
  turbopack: {
    root: __dirname,
  },
  // The letterhead PDF (src/lib/assistant/letterhead-pdf.ts) reads its
  // embedded Cyrillic-capable TTFs with fs at runtime — static tracing can't
  // see that, so include them in the serverless bundle explicitly for every
  // route that renders a PDF: Vassili's Telegram webhook, the admin finance
  // P&L download, and the monthly P&L cron.
  outputFileTracingIncludes: {
    "/api/telegram/webhook": ["./src/assets/fonts/*.ttf"],
    "/api/admin/finance/pdf": ["./src/assets/fonts/*.ttf"],
    "/api/cron/monthly-pnl": ["./src/assets/fonts/*.ttf"],
  },
};

export default nextConfig;
