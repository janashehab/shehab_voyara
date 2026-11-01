export type IdFactory = {
  tripId: () => string;
  itemId: () => string;
};

export function createIdFactory(prefix = "plan"): IdFactory {
  let tripCount = 0;
  let itemCount = 0;

  return {
    tripId() {
      tripCount += 1;
      return `trp_${prefix}_${tripCount}`;
    },
    itemId() {
      itemCount += 1;
      return `itm_${prefix}_${itemCount}`;
    },
  };
}
