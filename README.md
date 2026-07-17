# Inkling

Draw something and an AI guesses it out loud. Runs entirely in the browser — no
server, no API key, no cost.

```bash
npm install
npm run dev
```

## How it works

**DoodleNet** — a CNN trained on all 345 [Quick, Draw!](https://quickdraw.withgoogle.com/data)
categories, 50k images per class — is fetched once from a CDN (2.2 MB) and runs
on the GPU via TensorFlow.js. Inference takes ~10ms, so guesses update every
250ms while you're still drawing. The AI narrates each new guess with the Web
Speech API, and you win when it says your word.

```
src/lib/doodlenet.js  model loading, preprocessing, predict
src/lib/words.js      word list + the shuffle bag
src/lib/speech.js     Web Speech API, voice selection
src/lib/sfx.js        win/lose/tick sounds, synthesized
src/components/ui/    shadcn/ui components
src/App.jsx           game loop
```

Stack: React + Vite, shadcn/ui on **Tailwind v4** (CSS-first — no
`tailwind.config.js`; the theme lives in `src/index.css`). Plain JavaScript, so
`components.json` sets `"tsx": false` and the CLI emits `.jsx`.

## Preprocessing rules

These bind the **offscreen model canvas** — the one `predict()` reads. The
visible canvas is cosmetic and deliberately dark; it never reaches the model.

Three of the four fail **without raising any error**. The model just guesses
nonsense and you conclude the model is bad.

**1. Fill it opaque white.** `fromPixels(canvas, 3)` drops alpha, so transparent
pixels read as black, then invert into strokes — the whole background becomes
"drawing".

**2. Invert it.** Canvas is black-on-white; the model wants white-on-black
(confirmed against the real Quick Draw bitmaps: background is 0).

**3. Do not binarize.** Quick Draw bitmaps are anti-aliased and the model relies
on that gradient. Measured on 8 real Quick Draw banana bitmaps:

| preprocessing | result |
|---|---|
| grayscale | **8/8 correct** — 98%, 94%, 97%, 90%, 88%, 83%, 75%, 48% |
| binarized | **1/8** — necklace, marker, saw, toothpaste, kangaroo… |

The official ml5.js example uses `.floor()`, which binarizes. Don't copy it.

**4. Normalize to the bounding box.** Quick Draw scales every image to its stroke
bounds. Without it, a small drawing in a corner is unguessable:

| drawing | without | with |
|---|---|---|
| house, centered | bread 12% | house 39% / barn 51% |
| house, small in corner | smiley_face 17% | **house 65%** |
| star | animal_migration 50% | **star 94%** |

## The brush slider never reaches the model

Stroke width is a model parameter, not a style choice — the 420px drawing is
scaled to 28px, so thin strokes vanish and thick ones read as filled shapes:

| brush | if the model saw it | with the split canvas |
|---|---|---|
| 6px | `line` 35% | **`square` 95%** |
| 16px | `square` 95% | `square` 95% |
| 40px | `picture_frame` 91% | **`square` 95%** |

`DrawCanvas` renders every stroke twice — once at the player's size onto the
visible canvas, once at `MODEL_STROKE_WIDTH` (16) onto an offscreen twin that is
the only thing `predict()` reads. Point the model at the visible canvas and the
slider silently breaks the game at both ends.

## The narration loop owns the win

`predict()` runs ~4x/s; the AI speaks at ~1.8s per word. Declaring a win the
instant the model ranks the target first means the player wins seconds before
ever hearing the guess — or never hears it. So the narration loop owns both, and
they cannot disagree. Runner-up mutters filter out the target, which makes "the
AI said the word but I didn't win" structurally impossible.

`await speak()` is capped at 2.5s: winning must never hang on the speech engine.

## Speech traps

Each produces **no sound and no error**. A TTS library saves you from none of
them — they all wrap this same API.

**`getVoices()` is async in Chrome, sync in Safari.** This is why Safari worked
while Chrome stayed mute. An earlier version gave up after a 1s timeout and
latched the *empty* list forever. Measured against a 3s-delayed list: timeout
got **0** voices, polling got **199**. `loadVoices()` polls until non-empty.

**Some voices are listed but unplayable.** They accept an utterance, never fire
`onstart`, and wedge `speechSynthesis` at `speaking=true` — every later phrase
queues behind them forever. Daniel (en-GB) does this on some Macs, *and it is
the browser default there*. `speak()` treats "no `onstart` within 1.2s" as
broken, blacklists the voice, and switches mid-sentence.

**Never prime with an empty or volume-0 utterance.** It never ends, and wedges
the queue before the game says a word. `primeSpeech()` only calls `cancel()` +
`resume()`; the user's click already satisfies Chrome's autoplay rule.

The voice is fixed to **Samantha (en-US)**. `speak()` also has a 5s backstop: a
hidden tab suppresses speech and withholds `onend` forever.

## No repeats in a session

`createWordBag()` deals from a shuffled deck, so every word appears once before
any repeat:

| approach | problem |
|---|---|
| independent random | with 75 words, odds of a repeat pass 50% by round 11 |
| random, retry if seen | the last word of a pass needs ~75 attempts |
| **shuffled deck** | one `pop()`; repeats impossible until the deck is empty |

The deck lives in a `useState` lazy initializer, **not `useMemo`** — `useMemo` is
a cache, not storage, and React may discard it at any time, silently reshuffling
mid-session. Verified over 152 draws: 75/75 unique per pass, zero adjacent
repeats, zero repeats across the reshuffle boundary.

## Adding words

Each entry in `src/lib/words.js` must match a line in `class_names.txt` exactly.
Multi-word labels use underscores (`ice_cream`, not `ice cream`). A typo raises
no error — the word simply becomes unguessable. Verify first:

```bash
curl -sL https://cdn.jsdelivr.net/gh/ml5js/ml5-data-and-models@master/models/doodlenet/class_names.txt \
  | grep -x "new_word"
```

## Limits

- **345 fixed categories.** Custom words need a multimodal model, not DoodleNet.
- Bundle is ~1.8 MB (320 KB gzip), almost all TensorFlow.js.
- Some categories are genuinely ambiguous to draw. A plain circle gets guessed as
  `bracelet` — that's the model, not a bug.

## Deploy

Static build — `npm run build`, then serve `dist/`.

## Credits

- [Quick, Draw! Dataset](https://github.com/googlecreativelab/quickdraw-dataset) — Google Creative Lab
- [DoodleNet](https://github.com/yining1023/doodleNet) — Yining Shi, via [ml5.js](https://ml5js.org/)
