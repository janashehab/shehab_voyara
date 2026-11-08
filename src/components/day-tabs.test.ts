import assert from "node:assert/strict";
import test from "node:test";

import { nextTabIndex } from "./day-tabs";

test("day tabs move and wrap with the arrow keys", () => {
  assert.equal(nextTabIndex(0, 3, "ArrowRight"), 1);
  assert.equal(nextTabIndex(2, 3, "ArrowRight"), 0);
  assert.equal(nextTabIndex(0, 3, "ArrowLeft"), 2);
  assert.equal(nextTabIndex(1, 3, "ArrowLeft"), 0);
  assert.equal(nextTabIndex(2, 1, "ArrowRight"), 0);
  assert.equal(nextTabIndex(0, 1, "ArrowLeft"), 0);
});

test("home and end select the first and last day", () => {
  assert.equal(nextTabIndex(2, 4, "Home"), 0);
  assert.equal(nextTabIndex(0, 4, "End"), 3);
  assert.equal(nextTabIndex(0, 3, "Enter"), null);
  assert.equal(nextTabIndex(0, 0, "ArrowRight"), null);
});
