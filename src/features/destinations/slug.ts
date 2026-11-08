/** Public URL shape only. Approval stays in the catalog lookup. */
export const PUBLIC_DESTINATION_SLUG_MAX_LENGTH = 64;

const publicDestinationSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isPublicDestinationSlug(slug: string): boolean {
  return slug.length <= PUBLIC_DESTINATION_SLUG_MAX_LENGTH && publicDestinationSlug.test(slug);
}

/** Proxy gate for one destination path segment. A miss is not a catalog decision. */
export function destinationSlugGate(segment: string | undefined): "allow" | "miss" {
  if (segment === undefined) {
    return "allow";
  }
  try {
    return isPublicDestinationSlug(decodeURIComponent(segment)) ? "allow" : "miss";
  } catch {
    return "miss";
  }
}
