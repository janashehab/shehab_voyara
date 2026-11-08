import type { NextConfig } from "next";
import path from "node:path";

import { indexingResponseHeaders, readIndexingEnv } from "./src/lib/indexing-policy";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  headers() {
    return indexingResponseHeaders(readIndexingEnv(process.env));
  },
  turbopack: {
    // A lockfile in the home directory sits above this repo. Pin the
    // Turbopack root to this project so resolution stays inside the git root.
    root: path.join(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
