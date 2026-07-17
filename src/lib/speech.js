// Web Speech API — built into the browser, free, no dependencies.
//
// Wrapping this in a TTS library would not help: every browser TTS library
// calls this same API, with the same voices, and hits the same two traps
// documented below.

// One fixed voice, so the game sounds the same everywhere it can.
const VOICE_NAME = 'Samantha';
const VOICE_LANG = 'en-US';

// macOS ships joke voices that are sound effects, not narrators — and they are
// perfectly valid English voices as far as the API is concerned. Only matters
// on machines without Samantha, where we have to fall back to something.
const NOVELTY =
  /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|Bruce|Junior|Ralph|Kathy|Princess|Fred)/i;

let allVoices = [];
let voice = null;
let ready = false;
let initPromise = null;

// Bumped by stopSpeaking(). Lets an in-flight speak() tell "I was cancelled"
// apart from "this voice is broken" — the two are indistinguishable from the
// utterance's own events, and confusing them blacklists healthy voices.
let generation = 0;

// Voices the OS advertises but cannot actually play. They accept an utterance,
// never fire onstart, and wedge speechSynthesis at speaking=true so every later
// phrase queues behind them forever — with no error raised anywhere. Daniel
// (en-GB) does exactly this on some Macs, and it is the browser default there.
const broken = new Set();

function pickVoice() {
  const usable = allVoices.filter((v) => !broken.has(v.name));
  const english = usable.filter((v) => v.lang?.toLowerCase().startsWith('en'));

  return (
    english.find((v) => v.name === VOICE_NAME && v.lang === VOICE_LANG) ??
    english.find((v) => v.name.startsWith(VOICE_NAME)) ??
    english.find((v) => v.localService && v.lang === VOICE_LANG && !NOVELTY.test(v.name)) ??
    english.find((v) => v.localService && !NOVELTY.test(v.name)) ??
    english.find((v) => !NOVELTY.test(v.name)) ??
    usable[0] ??
    null
  );
}

export function isSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Chrome populates getVoices() asynchronously and can take several seconds on a
// cold load; Safari fills it synchronously, which is why Safari worked while
// Chrome stayed mute.
//
// Do NOT "just" resolve on a timeout. An earlier version gave up after 1s and
// resolved with the empty list, which permanently left the app with zero
// voices — measured against a 3s-delayed list: timeout got 0 voices, polling
// got 199. voiceschanged is not enough either; it can fire late or never.
function loadVoices() {
  return new Promise((resolve) => {
    const existing = speechSynthesis.getVoices();
    if (existing.length) return resolve(existing);

    let settled = false;
    const finish = (list) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(list);
    };

    speechSynthesis.addEventListener(
      'voiceschanged',
      () => finish(speechSynthesis.getVoices()),
      { once: true },
    );

    let tries = 0;
    const poll = setInterval(() => {
      const list = speechSynthesis.getVoices();
      tries += 1;
      if (list.length || tries > 40) finish(list); // give up after 10s
    }, 250);
  });
}

export function initSpeech() {
  if (!isSupported()) return Promise.resolve();

  // Latch on completion, NOT on the list being non-empty. Retrying while empty
  // looks safer but isn't: on a browser that genuinely has no voices, every
  // speak() would re-enter the 10s poll below — stalling each guess by 10s and
  // freezing the Start button. Late-arriving voices are covered by the
  // voiceschanged listener instead.
  if (ready) return Promise.resolve();

  // Share one in-flight load. Mount and the first speak() both call this, and
  // without this they would each register a listener and run their own poll.
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Chrome can add voices well after startup.
    speechSynthesis.addEventListener('voiceschanged', () => {
      const list = speechSynthesis.getVoices();
      if (!list.length) return;
      allVoices = list;
      if (!voice) voice = pickVoice();
    });

    allVoices = await loadVoices();
    voice = pickVoice();
    ready = true;
  })();

  return initPromise;
}

// Call from a click handler — Chrome refuses to speak until the page has been
// interacted with. Do not "prime" by speaking a volume-0 utterance: if the
// voice turns out to be one of the broken ones, that utterance never ends and
// wedges the queue before the game says a single word.
export function primeSpeech() {
  if (!isSupported()) return;
  speechSynthesis.cancel();
  speechSynthesis.resume();
}

function speakOnce(text, v, gen) {
  return new Promise((resolve) => {
    let started = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const u = new SpeechSynthesisUtterance(text);
    u.voice = v;
    u.lang = v.lang;
    u.rate = 1.1;

    u.onstart = () => {
      started = true;
    };
    u.onend = () => finish('ok');
    u.onerror = (event) => finish(event.error);

    // A working voice starts within milliseconds. Silence past this point means
    // the voice is listed but not actually playable — UNLESS we were cancelled,
    // which produces identical silence. Blaming the voice for a cancel would
    // blacklist a healthy one on every single round until none are left.
    setTimeout(() => {
      if (started) return;
      finish(gen === generation ? 'no-start' : 'cancelled');
    }, 1200);

    // Backstop so the narration loop can never wedge on a stuck utterance — a
    // hidden tab suppresses speech and withholds onend indefinitely.
    setTimeout(() => finish('timeout'), 5000);

    speechSynthesis.speak(u);
  });
}

export async function speak(text) {
  if (!isSupported() || !text) return;

  if (!voice) {
    await initSpeech();
    if (!voice) return;
  }

  const gen = generation;

  // Self-healing: a voice that never starts gets blacklisted and the next
  // candidate is tried immediately, so the game cannot go silently mute.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await speakOnce(text, voice, gen);

    // Something cancelled us — the round ended, or the user hit mute. Stop
    // dead: retrying from here would speak over the next round.
    if (gen !== generation) return;
    if (result !== 'no-start') return;

    broken.add(voice.name);
    speechSynthesis.cancel();
    voice = pickVoice();
    if (!voice) return;
  }
}

export function stopSpeaking() {
  if (!isSupported()) return;
  // Invalidate any in-flight speak() so it neither retries nor mistakes this
  // cancel for a broken voice.
  generation += 1;
  speechSynthesis.cancel();
}
