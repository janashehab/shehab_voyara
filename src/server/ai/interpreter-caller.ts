import { createHash } from "node:crypto";

/**
 * Caller identity for the AI request ledger.
 * The deployment in this repository does not name its edge proxy, so
 * X-Forwarded-For is ignored unless VOYARA_TRUSTED_PROXY_HOPS is set.
 * That value is the number of proxies this app trusts to append an address.
 * The client address is that many hops from the right. Entries to the left
 * are not used.
 */

export function interpreterCallerId(input: {
  forwardedFor: string | null;
  trustedProxyHops: string | undefined;
  pepper?: string | undefined;
}): string {
  const hops = trustedProxyHopCount(input.trustedProxyHops);
  if (hops === null) {
    return "direct";
  }
  const parts = (input.forwardedFor ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const candidate = parts[parts.length - hops];
  if (!candidate || !isIp(candidate)) {
    return "unverified";
  }
  const pepper = input.pepper?.trim() ?? "";
  const digest = createHash("sha256")
    .update(`voyara-interpreter-caller\n${pepper}\n${candidate}`)
    .digest("hex");
  return `ip:${digest}`;
}

export function trustedProxyHopCount(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d{0,1}$/.test(trimmed)) {
    return null;
  }
  const hops = Number(trimmed);
  if (hops < 1 || hops > 5) {
    return null;
  }
  return hops;
}

function isIp(value: string): boolean {
  if (value.length > 64) {
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  if (!/^[0-9a-fA-F:]+$/.test(value) || !value.includes(":")) {
    return false;
  }
  const sides = value.split("::");
  if (sides.length > 2) {
    return false;
  }
  const groups = sides.join(":").split(":").filter((group) => group.length > 0);
  return groups.length >= 2 && groups.length <= 8 && groups.every((group) => group.length <= 4);
}
