// Every entry MUST match a line in DoodleNet's class_names.txt exactly.
// Multi-word labels use underscores (ice_cream, not "ice cream"). A typo
// throws no error — the word simply becomes impossible to guess, forever.
// Verify before adding:
//   curl -sL https://cdn.jsdelivr.net/gh/ml5js/ml5-data-and-models@master/models/doodlenet/class_names.txt | grep -x "new_word"

export const WORDS = [
  // food
  'banana',
  'apple',
  'strawberry',
  'pineapple',
  'mushroom',
  'pizza',
  'donut',
  'sandwich',
  'ice_cream',
  'hot_dog',
  'birthday_cake',
  'coffee_cup',
  'wine_bottle',

  // animals
  'cat',
  'dog',
  'fish',
  'snake',
  'spider',
  'butterfly',
  'bee',
  'pig',
  'rabbit',
  'shark',
  'swan',
  'tiger',
  'zebra',

  // nature
  'tree',
  'flower',
  'sun',
  'moon',
  'star',
  'cloud',
  'rainbow',
  'mountain',
  'lightning',

  // vehicles
  'car',
  'truck',
  'train',
  'airplane',
  'bicycle',
  'sailboat',
  'school_bus',
  'police_car',
  'traffic_light',
  'fire_hydrant',

  // objects
  'house',
  'door',
  'clock',
  'key',
  'umbrella',
  'book',
  'camera',
  'candle',
  'cup',
  'ladder',
  'laptop',
  'pencil',
  'scissors',
  'light_bulb',
  'paper_clip',
  'envelope',
  'hammer',
  'headphones',
  'microphone',
  'guitar',

  // wearables and misc
  'eye',
  'hat',
  'shoe',
  't-shirt',
  'eyeglasses',
  'crown',
  'sword',
  'tent',
  'windmill',
  'teddy-bear',
];

// The AI can guess any of the 345 labels, not just the ones in WORDS, so this
// has to handle arbitrary labels — hence cleaning the raw string rather than
// looking it up in a table.
export function displayName(label) {
  return label.replace(/[_-]/g, ' ');
}

function shuffle(items) {
  const deck = [...items];
  // Fisher-Yates. Not `sort(() => Math.random() - 0.5)` — that comparator is
  // inconsistent, so the result is measurably biased, not shuffled.
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Deals every word once before repeating any — a shuffled deck, not repeated
// random draws.
//
// Independent draws repeat almost immediately: with 76 words the odds of having
// already seen a word pass 50% by round 11 (birthday paradox), which is exactly
// the "wait, this again?" the bag exists to stop. Draw-and-retry-if-seen fixes
// the repeats but degrades badly — the final word of a pass needs ~76 attempts
// on average. Popping a pre-shuffled deck is one operation and cannot repeat.
export function createWordBag() {
  let deck = shuffle(WORDS);
  let lastDealt = null;
  const seen = new Set();

  return {
    total: WORDS.length,
    seenCount: () => seen.size,
    seenWords: () => [...seen],

    next() {
      if (deck.length === 0) {
        deck = shuffle(WORDS);
        seen.clear();
        // A fresh deck can open with the word the old one just closed on —
        // back-to-back, the single repeat this whole thing exists to prevent.
        if (deck.length > 1 && deck[deck.length - 1] === lastDealt) {
          [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
        }
      }

      lastDealt = deck.pop();
      seen.add(lastDealt);
      return lastDealt;
    },
  };
}
