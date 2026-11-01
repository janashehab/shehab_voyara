export type FieldDecision = "apply" | "keep" | "hold";

export type FieldHold = {
  field: string;
  reason: string;
};

/**
 * Source-owned fields can refresh from an import. Approval is never one of
 * them. An identity-critical change is held while an admin attestation is
 * active, the row is no longer draft, or an admin has locked the field.
 */
export function decideField(input: {
  changed: boolean;
  identityCritical: boolean;
  adminLocked: boolean;
  hasActiveAttestation: boolean;
  approval: string;
}): FieldDecision {
  if (!input.changed) {
    return "keep";
  }
  if (input.adminLocked) {
    return input.identityCritical ? "hold" : "keep";
  }
  if (input.identityCritical && (input.hasActiveAttestation || input.approval !== "draft")) {
    return "hold";
  }
  return "apply";
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }
  return (left ?? null) === (right ?? null);
}

export function mergeFields(input: {
  existing: Record<string, unknown> | null;
  incoming: Record<string, unknown>;
  sourceOwned: readonly string[];
  identityFields: readonly string[];
  adminLockedFields: readonly string[];
  hasActiveAttestation: boolean;
}): { values: Record<string, unknown>; holds: FieldHold[] } {
  if (input.existing === null) {
    return { values: { ...input.incoming }, holds: [] };
  }

  const approval = typeof input.existing.approval === "string" ? input.existing.approval : "draft";
  const values: Record<string, unknown> = { ...input.existing };
  const holds: FieldHold[] = [];
  const identity = new Set(input.identityFields);

  for (const field of input.sourceOwned) {
    const decision = decideField({
      changed: !valuesEqual(input.existing[field], input.incoming[field]),
      identityCritical: identity.has(field),
      adminLocked: input.adminLockedFields.includes(field),
      hasActiveAttestation: input.hasActiveAttestation,
      approval,
    });
    if (decision === "apply") {
      values[field] = input.incoming[field];
      continue;
    }
    if (decision === "hold") {
      holds.push({
        field,
        reason: `Held ${field} for review. The import did not replace an admin-verified value.`,
      });
    }
  }

  values.approval = input.existing.approval;
  values.adminLockedFields = [...input.adminLockedFields];
  return { values, holds };
}
