import assert from "node:assert/strict";
import test from "node:test";

import { PUBLIC_DESTINATION_SLUG_MAX_LENGTH, destinationSlugGate, isPublicDestinationSlug } from "./slug";

test("a public destination slug is lowercase words joined by single hyphens", () => {
  assert.equal(isPublicDestinationSlug("paris"), true);
  assert.equal(isPublicDestinationSlug("bangkok"), true);
  assert.equal(isPublicDestinationSlug("not-a-place"), true);
  assert.equal(isPublicDestinationSlug("chiang-mai"), true);
  assert.equal(destinationSlugGate("paris"), "allow");
  assert.equal(destinationSlugGate("not-a-place"), "allow");
});

test("malformed destination slugs miss before any catalog lookup", () => {
  const malformed = [
    "",
    "Paris",
    "not a place",
    "paris lyon",
    "-paris",
    "paris-",
    "paris--lyon",
    "paris_lyon",
    "paris.lyon",
    "paris/lyon",
    "a".repeat(PUBLIC_DESTINATION_SLUG_MAX_LENGTH + 1),
    "%",
    "%20",
  ];

  for (const slug of malformed) {
    assert.equal(isPublicDestinationSlug(slug), false, slug);
    assert.equal(destinationSlugGate(slug), "miss", slug);
  }
  assert.equal(destinationSlugGate(undefined), "allow");
});
