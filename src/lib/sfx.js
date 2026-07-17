// Sound effects synthesized with the Web Audio API — no audio files, so
// nothing to download and nothing added to the bundle.

let ctx = null;

function context() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) ctx = new Ctx();
  return ctx;
}

// Browsers create the AudioContext suspended until the page is interacted
// with. Call this from a click handler or every sound is silently dropped.
export function primeSfx() {
  const audio = context();
  if (audio?.state === 'suspended') audio.resume();
}

function tone({ freq, start, duration, gain = 0.14, type = 'sine', slideTo }) {
  const audio = context();
  if (!audio) return;

  const at = audio.currentTime + start;
  const osc = audio.createOscillator();
  const amp = audio.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + duration);

  // Ramp both ends: a square-edged gain change is audible as a click.
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  osc.connect(amp).connect(audio.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

// Rising major arpeggio — C, E, G, C.
export function playWin() {
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    tone({ freq, start: i * 0.09, duration: 0.22, type: 'triangle', gain: 0.16 });
  });
}

// Two falling notes — the classic "aw, too bad".
export function playLose() {
  tone({ freq: 392, start: 0, duration: 0.22, type: 'sine', gain: 0.13 });
  tone({ freq: 311.13, start: 0.16, duration: 0.4, type: 'sine', gain: 0.13, slideTo: 246.94 });
}

// Soft blip when the AI changes its mind about the top guess.
export function playGuess() {
  tone({ freq: 880, start: 0, duration: 0.07, type: 'sine', gain: 0.05 });
}

// Dry tick for the last few seconds.
export function playTick() {
  tone({ freq: 1200, start: 0, duration: 0.04, type: 'square', gain: 0.035 });
}
