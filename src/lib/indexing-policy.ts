/**
 * Public indexing is fail-closed.
 *
 * A deployment may be indexed only when both are true:
 * - VOYARA_INDEXING is exactly "approved" (no extra characters or different case)
 * - VERCEL_ENV is exactly "production"
 *
 * VERCEL_ENV is set by Vercel for each deployment and is not NODE_ENV.
 * Preview deployments are "preview". A local production build leaves it unset.
 * Either one keeps the site non-indexable, including when the flag is approved.
 *
 * next.config headers() and the root metadata object are read when that
 * deployment is built. Vercel builds preview and production separately, so
 * each artifact keeps the decision from its own build. A later env edit does
 * not change an existing deployment until it is built again.
 */

export const INDEXING_APPROVED = "approved";
export const PRODUCTION_DEPLOYMENT = "production";
export const ROBOTS_HEADER = "X-Robots-Tag";
export const NOINDEX_DIRECTIVE = "noindex, nofollow";

export type IndexingEnv = {
  VOYARA_INDEXING?: string | undefined;
  VERCEL_ENV?: string | undefined;
};

export function readIndexingEnv(env: NodeJS.ProcessEnv): IndexingEnv {
  return {
    VOYARA_INDEXING: env["VOYARA_INDEXING"],
    VERCEL_ENV: env["VERCEL_ENV"],
  };
}

export function isPubliclyIndexable(env: IndexingEnv): boolean {
  return (
    env.VOYARA_INDEXING === INDEXING_APPROVED && env.VERCEL_ENV === PRODUCTION_DEPLOYMENT
  );
}

export function robotsMetadata(env: IndexingEnv): { index: false; follow: false } | { index: true; follow: true } {
  if (isPubliclyIndexable(env)) {
    return { index: true, follow: true };
  }

  return { index: false, follow: false };
}

export function indexingResponseHeaders(env: IndexingEnv): {
  source: string;
  headers: { key: string; value: string }[];
}[] {
  if (isPubliclyIndexable(env)) {
    return [];
  }

  return [
    {
      source: "/:path*",
      headers: [{ key: ROBOTS_HEADER, value: NOINDEX_DIRECTIVE }],
    },
  ];
}
