// Doner Bros — decides whether the customer's reply to the order summary is an explicit "yes".
// Deliberately strict: only a short, plain confirmation counts. Anything hedged, conditional,
// negative, a question, or asking for a change is ambiguous, and the bot must ask again.

const MAX_CONFIRMATION_LENGTH = 80;

// Whole words or phrases that say yes to placing the order (English and romanised Urdu).
const AFFIRMATIVE = [
  "yes", "yeah", "yep", "yup", "yes please", "confirm", "confirmed", "i confirm",
  "place the order", "place my order", "place it", "go ahead", "correct", "that's correct",
  "that is correct", "that's right", "all correct", "haan", "han", "ji haan", "jee haan", "ji han",
  "ہاں", "جی ہاں",
];

// Any of these makes the reply ambiguous, even next to a yes. "ok", "sure", "fine" and "sounds
// good" are on this list on purpose: they're too easily said in passing.
const NOT_CLEAR = [
  "no", "not", "nope", "don't", "dont", "do not", "wait", "hold on", "hang on", "cancel", "stop",
  "change", "but", "except", "instead", "actually", "maybe", "perhaps", "probably", "might",
  "think", "guess", "unsure", "not sure", "later", "hmm", "um", "uh", "if", "add", "remove",
  "without", "extra", "also", "ok", "okay", "sure", "fine", "sounds good", "alright", "theek",
  "nahi", "nahin", "mat", "نہیں",
];

// Polite words that may go with a yes. Anything else left over ("yes with chips", "yes make it 2")
// might be asking for a change, so the reply isn't a plain yes.
const FILLER = ["please", "thank you", "thanks", "ji", "jee", "sir", "bhai"];
const PLAIN_YES_PHRASES = [...AFFIRMATIVE, ...FILLER].sort((a, b) => b.length - a.length);

function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[.,!;:()"*_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasPhrase(text, phrase) {
  return ` ${text} `.includes(` ${phrase} `);
}

// What's left of the reply once the yes phrases and polite words are taken out.
function leftOver(text) {
  let rest = ` ${text} `;
  for (const phrase of PLAIN_YES_PHRASES) {
    while (rest.includes(` ${phrase} `)) rest = rest.replace(` ${phrase} `, " ");
  }
  return rest.trim();
}

// Returns { confirmed: true } or { confirmed: false, reason }.
function checkConfirmation(reply) {
  const text = normalise(reply);
  if (!text) return { confirmed: false, reason: "the reply was empty." };
  if (text.length > MAX_CONFIRMATION_LENGTH) return { confirmed: false, reason: "the reply was too long to be a plain yes." };
  if (text.includes("?")) return { confirmed: false, reason: "the reply was a question." };
  const unclear = NOT_CLEAR.find((phrase) => hasPhrase(text, phrase));
  if (unclear) return { confirmed: false, reason: `the reply contains "${unclear}", so it isn't a clear yes.` };
  if (!AFFIRMATIVE.some((phrase) => hasPhrase(text, phrase))) {
    return { confirmed: false, reason: "the reply doesn't clearly say yes." };
  }
  const extra = leftOver(text);
  if (extra) return { confirmed: false, reason: `the reply says more than yes ("${extra}"), so it may be asking for a change.` };
  return { confirmed: true };
}

module.exports = { checkConfirmation };
