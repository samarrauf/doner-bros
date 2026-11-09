// Tests for the kitchen board's allowed status moves. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedMove } = require("./kitchen");

test("the board moves an order one step on, one step back, or cancels it", () => {
  assert.ok(isAllowedMove("NEW", "PREPARING"));
  assert.ok(isAllowedMove("PREPARING", "READY"));
  assert.ok(isAllowedMove("READY", "COMPLETED"));
  assert.ok(isAllowedMove("PREPARING", "NEW"));
  assert.ok(isAllowedMove("READY", "PREPARING"));
  for (const from of ["NEW", "PREPARING", "READY"]) assert.ok(isAllowedMove(from, "CANCELLED"));
});

test("no skipped steps, no moves out of a closed order, nothing unknown", () => {
  assert.ok(!isAllowedMove("NEW", "READY"));
  assert.ok(!isAllowedMove("NEW", "COMPLETED"));
  assert.ok(!isAllowedMove("READY", "NEW"));
  assert.ok(!isAllowedMove("COMPLETED", "READY"));
  assert.ok(!isAllowedMove("COMPLETED", "CANCELLED"));
  assert.ok(!isAllowedMove("CANCELLED", "NEW"));
  assert.ok(!isAllowedMove("NEW", "NEW"));
  assert.ok(!isAllowedMove(undefined, "CANCELLED"));
  assert.ok(!isAllowedMove("NEW", "DELETED"));
});
