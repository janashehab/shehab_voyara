import assert from "node:assert/strict";
import test from "node:test";

import { getPrototypeCatalog } from "@/lib/catalog";
import { getHomeFeature } from "@/features/destinations/queries";
import { featuredDestinationLink, homeProcessSteps } from "@/features/home/featured-link";

test("an approved featured destination can be linked", () => {
  assert.deepEqual(featuredDestinationLink(getHomeFeature(getPrototypeCatalog())), {
    href: "/destinations/paris",
    name: "Paris",
  });
});

test("an empty approved catalog has no destination to promote", () => {
  assert.equal(featuredDestinationLink({ destinations: [] }), null);
});

test("an approved Paris catalog keeps the concierge step and its plan link", () => {
  const step = homeProcessSteps(getHomeFeature(getPrototypeCatalog()))[1];
  assert.equal(
    step?.body,
    "The concierge plans Paris. Choose a length, what the days lean toward, and a pace. The draft uses approved places only.",
  );
  assert.equal(step?.href, "/plan");
  assert.equal(step?.actionLabel, "Plan the Paris trip");
});

test("an empty approved catalog does not promote a destination in the concierge step", () => {
  const step = homeProcessSteps({ destinations: [] })[1];
  assert.equal(
    step?.body,
    "When a destination is approved, the concierge drafts the trip from approved places only.",
  );
  assert.equal(step?.href, undefined);
  assert.equal(step?.actionLabel, undefined);
  assert.equal(step?.body.includes("Paris"), false);
});
