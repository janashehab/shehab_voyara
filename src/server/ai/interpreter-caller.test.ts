import assert from "node:assert/strict";
import test from "node:test";

import { interpreterCallerId, trustedProxyHopCount } from "./interpreter-caller";

test("forwarded addresses are ignored until a trusted hop count is configured", () => {
  const forwarded = "203.0.113.8, 198.51.100.2";
  assert.equal(interpreterCallerId({ forwardedFor: forwarded, trustedProxyHops: undefined }), "direct");
  assert.equal(interpreterCallerId({ forwardedFor: forwarded, trustedProxyHops: "" }), "direct");
  assert.equal(interpreterCallerId({ forwardedFor: forwarded, trustedProxyHops: "0" }), "direct");
  assert.equal(interpreterCallerId({ forwardedFor: forwarded, trustedProxyHops: "many" }), "direct");
  assert.equal(interpreterCallerId({ forwardedFor: forwarded, trustedProxyHops: "6" }), "direct");
  assert.equal(trustedProxyHopCount(" 1 "), 1);
  assert.equal(trustedProxyHopCount("5"), 5);
  assert.equal(trustedProxyHopCount("6"), null);
  assert.equal(trustedProxyHopCount(undefined), null);

  const oneHop = interpreterCallerId({ forwardedFor: forwarded, trustedProxyHops: "1", pepper: "test-pepper" });
  const sameProxy = interpreterCallerId({
    forwardedFor: "198.51.100.9, 198.51.100.2",
    trustedProxyHops: "1",
    pepper: "test-pepper",
  });
  const spoofedLeft = interpreterCallerId({
    forwardedFor: "198.51.100.2, 203.0.113.8",
    trustedProxyHops: "1",
    pepper: "test-pepper",
  });
  assert.equal(oneHop, sameProxy);
  assert.notEqual(oneHop, spoofedLeft);
  assert.equal(oneHop.startsWith("ip:"), true);
  assert.equal(oneHop.includes("203.0.113.8"), false);
  assert.equal(oneHop.includes("198.51.100.2"), false);

  const twoHops = interpreterCallerId({ forwardedFor: forwarded, trustedProxyHops: "2", pepper: "test-pepper" });
  assert.notEqual(twoHops, oneHop);
  assert.equal(interpreterCallerId({ forwardedFor: "203.0.113.8", trustedProxyHops: "2" }), "unverified");
  assert.equal(interpreterCallerId({ forwardedFor: "not-an-ip", trustedProxyHops: "1" }), "unverified");
  assert.notEqual(
    interpreterCallerId({ forwardedFor: "203.0.113.8", trustedProxyHops: "1", pepper: "one" }),
    interpreterCallerId({ forwardedFor: "203.0.113.8", trustedProxyHops: "1", pepper: "two" }),
  );
});
