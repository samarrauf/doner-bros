// Tests for the order confirmation gate. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkConfirmation } = require("./confirmation");

test("plain, explicit confirmations count", () => {
  for (const reply of [
    "yes", "Yes!", "YES PLEASE", "yes, place the order", "Yes please, thank you", "Yep", "confirm", "Confirmed.",
    "I confirm", "Go ahead", "Place my order", "That's correct", "yes that’s right", "Haan", "ji haan", "جی ہاں",
  ]) {
    assert.deepEqual(checkConfirmation(reply), { confirmed: true }, reply);
  }
});

test("ambiguous, hedged or casual replies don't count", () => {
  for (const reply of [
    "ok", "okay", "sure", "fine", "sounds good", "alright", "theek hai", "maybe", "I think so", "probably",
    "hmm", "yes?", "is that everything?", "yes but no onions", "yes, and add a coke", "yes actually wait",
    "yes, change it to rice", "yes if it's ready by 9", "yes later", "yes probably", "not yet", "no", "nahi",
    "thanks", "great", "👍", "", "   ",
  ]) {
    assert.equal(checkConfirmation(reply).confirmed, false, JSON.stringify(reply));
  }
});

test("negatives next to a yes still don't count", () => {
  assert.match(checkConfirmation("yes no problem").reason, /"no"/);
  assert.match(checkConfirmation("don't place it yet, yes").reason, /"don't"/);
});

test("a yes that carries anything extra doesn't count, since it may be a change", () => {
  for (const reply of ["yes with chips", "yes make it 2", "yes, deliver at 10pm", "yes and a coke", "yes for 3 people", "yes, Street 5"]) {
    assert.match(checkConfirmation(reply).reason, /says more than yes/, reply);
  }
});

test("a long message is never taken as a plain yes", () => {
  const long = "yes " + "the food here is always great and my family loves it ".repeat(2);
  assert.match(checkConfirmation(long).reason, /too long/);
});
