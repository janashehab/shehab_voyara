/** Next roving-tab index. A null result means the key does not change the selected day. */
export function nextTabIndex(current: number, length: number, key: string): number | null {
  if (length <= 0) {
    return null;
  }
  if (key === "ArrowRight") {
    return (current + 1) % length;
  }
  if (key === "ArrowLeft") {
    return (current - 1 + length) % length;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return length - 1;
  }
  return null;
}
