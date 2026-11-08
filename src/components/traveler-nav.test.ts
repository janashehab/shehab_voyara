import assert from "node:assert/strict";
import test from "node:test";

import { travelerNav } from "./traveler-nav";

const paris = { href: "/destinations/paris", label: "Paris" };

test("home nav offers Paris and the concierge without a current page", () => {
  assert.deepEqual(travelerNav({ destination: paris }), [
    { href: "/destinations/paris", label: "Paris", current: false },
    { href: "/plan", label: "Concierge", current: false },
  ]);
});

test("destination nav marks Paris as the current page", () => {
  const links = travelerNav({ current: "destination", destination: paris });

  assert.equal(links[0]?.current, true);
  assert.equal(links[1]?.current, false);
  assert.equal(links[0]?.href, "/destinations/paris");
});

test("plan nav marks the concierge as the current page", () => {
  const links = travelerNav({ current: "plan", destination: paris });

  assert.equal(links[0]?.current, false);
  assert.equal(links[1]?.current, true);
  assert.equal(links[1]?.href, "/plan");
  assert.equal(links[1]?.label, "Concierge");
});

test("nav omits a destination link when none is approved", () => {
  assert.deepEqual(travelerNav({ destination: null }), [
    { href: "/plan", label: "Concierge", current: false },
  ]);
});
