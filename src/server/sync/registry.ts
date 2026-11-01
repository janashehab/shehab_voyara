import { applyFailedRefresh, applySupplierPayload, type ApplyContext, type ApplyResult } from "./policy";
import {
  adapterDomain,
  permittedFields,
  type AdapterRegistry,
  type SupplierAdapter,
  type SyncState,
} from "./types";

export function createAdapterRegistry(): AdapterRegistry {
  return { adapters: [] };
}

export function registerAdapter(registry: AdapterRegistry, adapter: SupplierAdapter): AdapterRegistry {
  if (adapter.domain !== adapterDomain[adapter.adapter]) {
    throw new Error("Adapter domain does not match its interface.");
  }
  if (registry.adapters.some((item) => item.key === adapter.key)) {
    throw new Error("Adapter key is already registered.");
  }
  const allowed = new Set<string>(permittedFields[adapter.adapter]);
  for (const field of adapter.permittedFields) {
    if (!allowed.has(field)) {
      throw new Error("Adapter declares a field the policy does not permit.");
    }
  }
  return { adapters: [...registry.adapters, adapter] };
}

/**
 * Resolves an in-memory adapter and then applies the pure policy.
 * A missing adapter is a failed refresh. This function does not open a socket.
 */
export async function executeRefresh(input: {
  registry: AdapterRegistry;
  state: SyncState;
  context: ApplyContext;
  linkId: string;
}): Promise<ApplyResult> {
  const link = input.state.links.find((item) => item.id === input.linkId);
  if (!link) {
    return applyFailedRefresh(input.state, input.context, {
      linkId: input.linkId,
      errorCode: "unknown_link",
    });
  }

  const adapter = input.registry.adapters.find((item) => item.key === link.providerKey);
  if (!adapter) {
    return applyFailedRefresh(input.state, input.context, {
      linkId: link.id,
      errorCode: "adapter_missing",
    });
  }

  try {
    const payload = await adapter.fetchUpdate({
      subjectType: link.subjectType,
      subjectId: link.subjectId,
      providerKey: link.providerKey,
      externalId: link.externalId,
    });
    return applySupplierPayload(input.state, input.context, payload);
  } catch {
    return applyFailedRefresh(input.state, input.context, {
      linkId: link.id,
      errorCode: "adapter_error",
    });
  }
}
