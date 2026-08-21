import type { NextConfig } from "next";

/** Same-origin embed в reporting: UI и ассеты под /voice/, без конфликта с reporting /assets/. */
const basePath = (process.env.VOICE_BASE_PATH || "/voice").replace(/\/$/, "") || "";

const nextConfig: NextConfig = {
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  env: {
    NEXT_PUBLIC_VOICE_BASE_PATH: basePath,
  },
};

export default nextConfig;
