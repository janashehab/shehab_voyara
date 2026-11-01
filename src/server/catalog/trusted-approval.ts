import type { ApprovalState } from "@/lib/catalog/travel/schema";

/**
 * A caller-supplied approval is not authority. A missing catalog row stays draft.
 */
export function approvalFromRepository(stored: ApprovalState | null): ApprovalState {
  return stored ?? "draft";
}

export function trustedSyncTarget<T extends { approval: ApprovalState }>(
  caller: T,
  stored: ApprovalState | null,
): T {
  return { ...caller, approval: approvalFromRepository(stored) };
}
