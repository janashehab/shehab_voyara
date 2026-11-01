import { approvedCatalog, type CatalogSnapshot } from "@/lib/catalog";

/**
 * Turns one catalog load into the approved public snapshot.
 * A failed load throws a fixed error and does not return fixture or draft rows.
 * The caller rethrows framework interrupts before that fixed error is created.
 */
export async function readApprovedPublicCatalog(
  load: () => Promise<CatalogSnapshot>,
  rethrowFrameworkError: (error: unknown) => void,
): Promise<CatalogSnapshot> {
  try {
    return approvedCatalog(await load());
  } catch (error) {
    rethrowFrameworkError(error);
    console.error(catalogFailureLabel(error));
    throw new Error("The approved catalog could not be read.");
  }
}

function catalogFailureLabel(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^P\d{4}$/.test(code)) {
      return `Approved catalog read failed (${code}).`;
    }
  }
  if (
    error instanceof Error &&
    !/postgres(?:ql)?:\/\//i.test(error.message) &&
    !error.message.includes("@") &&
    !/password|secret|credential/i.test(error.message)
  ) {
    return `Approved catalog read failed. ${error.message}`;
  }
  return "Approved catalog read failed.";
}
