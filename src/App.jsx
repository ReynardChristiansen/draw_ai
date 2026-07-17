import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Eraser, PenLine, Play, RotateCw, Volume2, VolumeX, X } from 'lucide-react';

import DrawCanvas from '@/components/DrawCanvas';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { loadDoodleNet, predict } from '@/lib/doodlenet';
import { playGuess, playLose, playTick, playWin, primeSfx } from '@/lib/sfx';
import { initSpeech, isSupported, primeSpeech, speak, stopSpeaking } from '@/lib/speech';
import { createWordBag, displayName } from '@/lib/words';

const ROUND_SECONDS = 40;
const PREDICT_EVERY_MS = 250;
const TOP_K = 5;

// A healthy voice finishes a single word in ~1.4s. Past this the loop stops
// waiting: the win must never hang on the speech engine.
const SPEAK_CEILING_MS = 2500;

const BRUSH_MIN = 6;
const BRUSH_MAX = 40;
const URGENT_AT = 10;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function App() {
  const canvasRef = useRef(null);
  // The model reads this offscreen twin, never the visible canvas — see
  // MODEL_STROKE_WIDTH in DrawCanvas for why the brush slider must not reach it.
  const modelCanvasRef = useRef(null);
  const clearRef = useRef(null);
  const hasDrawn = useRef(false);
  const guessesRef = useRef([]);

  // Bumped whenever the drawing is invalidated (new round, Clear). Effect
  // cleanup is not enough: Clear changes no state, so the predict loop never
  // restarts and its `cancelled` flag never fires — an in-flight predict, whose
  // pixels were snapshotted before the wipe, would write the erased drawing's
  // guesses back over the reset and let the AI win on a blank canvas.
  const roundEpoch = useRef(0);

  // Lazy initializer, so the deck is built once and survives every re-render.
  // NOT useMemo: that is a cache, not storage — React is free to discard it at
  // any time, which would silently reshuffle the deck and hand back words the
  // player has already had.
  const [bag] = useState(createWordBag);

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [word, setWord] = useState(null);
  const [seenCount, setSeenCount] = useState(0);
  const [status, setStatus] = useState('idle'); // idle | playing | won | lost
  const [narration, setNarration] = useState('');
  const [showWin, setShowWin] = useState(false);
  const [soundOn, setSoundOn] = useState(isSupported());
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS);
  const [brush, setBrush] = useState(16);

  // shadcn's dark variant keys off a `.dark` class, so nothing follows the OS
  // on its own the way a prefers-color-scheme media query would.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    loadDoodleNet()
      .then(() => setReady(true))
      .catch((err) => setLoadError(err.message));

    // Deliberately not awaited alongside the model. A browser with no voices
    // polls for 10s (40s in a background tab, where timers are throttled), and
    // gating Start on that leaves the button dead the whole time for a purely
    // decorative feature. Measured: 41s in a hidden tab.
    initSpeech();
  }, []);

  const startRound = useCallback(() => {
    primeSpeech();
    primeSfx();
    setWord(bag.next());
    setSeenCount(bag.seenCount());
    setNarration('');
    setShowWin(false);
    setTimeLeft(ROUND_SECONDS);
    roundEpoch.current += 1;
    hasDrawn.current = false;
    guessesRef.current = [];
    clearRef.current?.();
    setStatus('playing');
  }, [bag]);

  useEffect(() => {
    if (status !== 'playing') return undefined;
    if (timeLeft <= 0) {
      setStatus('lost');
      return undefined;
    }
    if (soundOn && timeLeft <= URGENT_AT) playTick();
    const timer = setTimeout(() => setTimeLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [status, timeLeft, soundOn]);

  useEffect(() => {
    if (status !== 'playing' || !word) return undefined;

    let cancelled = false;

    // Self-scheduling rather than setInterval: setInterval does not wait for an
    // async callback, so if predict ever takes longer than the interval the
    // calls overlap and pile up — tensors accumulate and the page locks up.
    // Seen for real in a background tab, where the GPU readback crawls.
    (async () => {
      while (!cancelled) {
        if (hasDrawn.current && modelCanvasRef.current) {
          const epoch = roundEpoch.current;

          let top;
          try {
            top = await predict(modelCanvasRef.current, TOP_K);
          } catch {
            // A transient GPU/WebGL failure must not end this loop. Unguarded,
            // one rejection kills the IIFE for good: deps [status, word] never
            // restart it, so every later round is silently unwinnable.
            await wait(PREDICT_EVERY_MS);
            continue;
          }

          if (cancelled) return;
          // The canvas was wiped while this was in flight, so `top` describes a
          // drawing that no longer exists. Publishing it would let the AI win
          // on a blank canvas.
          if (epoch !== roundEpoch.current) continue;

          // Nothing renders the guess list, so this stays a ref — writing it to
          // state would re-render the whole app 4x a second for nothing.
          //
          // The win is NOT decided here. This loop runs ~4x/s while the AI
          // speaks at ~1.8s/word, so declaring a win the instant the model ranks
          // the target first means the player wins seconds before ever hearing
          // the guess — or never hears it at all. The narration loop owns it.
          guessesRef.current = top;
        }
        await wait(PREDICT_EVERY_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, word]);

  // This loop owns both the AI's voice and the win, so the two can never
  // disagree. Paced by speech finishing, not by a fixed timer: with a fixed
  // timer the utterances pile up in the speechSynthesis queue and drift further
  // and further behind the drawing.
  useEffect(() => {
    if (status !== 'playing') return undefined;

    let stopped = false;
    let altStep = 0;
    let lastTopName = null;

    (async () => {
      while (!stopped) {
        const current = guessesRef.current;
        if (current.length === 0) {
          // Empty means the canvas was just wiped (Clear) or nothing is drawn
          // yet. Forget the last announcement so the first guess after a redraw
          // is spoken fresh, not muttered as a repeat.
          lastTopName = null;
          await wait(300);
          continue;
        }

        const top = current[0];
        const topName = displayName(top.label);

        let pick;
        if (topName !== lastTopName) {
          // The model changed its mind. Announcing the new top guess is the
          // whole point — it's what a Quick Draw narrator says as you draw.
          pick = top;
          lastTopName = topName;
          altStep = 0;
          if (soundOn) playGuess();
        } else {
          // Belief unchanged, so there is nothing new to announce. Mutter a
          // runner-up instead, or the AI falls silent whenever the player
          // pauses. Never mutter the target itself: hearing the AI say the word
          // and not win reads as a bug.
          const alts = current.slice(1).filter((g) => g.label !== word);
          if (alts.length === 0) {
            await wait(400);
            continue;
          }
          pick = alts[altStep % alts.length];
          altStep += 1;
        }

        // Capture the canvas version we're about to speak for. If a Clear or a
        // new round bumps it while we speak, this guess no longer describes what
        // is on the canvas and must not win.
        const pickedEpoch = roundEpoch.current;
        setNarration(displayName(pick.label));

        // Capped, because the win now rides on this await. Speech pathologies
        // (a voiceless browser, a hidden tab withholding onend) must not become
        // game-logic pathologies — the loop keeps its own clock and speech stays
        // decorative.
        if (soundOn) await Promise.race([speak(displayName(pick.label)), wait(SPEAK_CEILING_MS)]);
        else await wait(800);

        // The word left the AI's mouth, so it is earned — checked BEFORE
        // `stopped`, because the timer expiring mid-word also sets `stopped`,
        // and losing a round you just won reads as theft. The epoch guard only
        // blocks the WIN, never the loop: a mid-round Clear used to `break` here,
        // killing narration for the rest of the round (draw again → AI frozen).
        // Now the loop keeps running and simply won't win on a wiped guess.
        if (pick.label === word && pickedEpoch === roundEpoch.current) {
          setStatus('won');
          break;
        }

        if (stopped) break;

        await wait(200);
      }
    })();

    return () => {
      stopped = true;
      stopSpeaking();
    };
    // `word` is a restart key, not a used value: pressing "Next word" mid-round
    // leaves status at 'playing', so without it this loop never restarts and
    // straddles the round boundary carrying a stale step/lastTopName.
  }, [status, word, soundOn]);

  useEffect(() => {
    if (status !== 'won') return undefined;
    if (soundOn) playWin();
    setShowWin(true);
    const timer = setTimeout(() => setShowWin(false), 2000);
    return () => clearTimeout(timer);
  }, [status, soundOn]);

  useEffect(() => {
    if (status !== 'lost') return;
    if (soundOn) playLose();
  }, [status, soundOn]);

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 p-6">
        <h1 className="text-xl font-semibold">Could not load the model</h1>
        <p className="font-mono text-sm text-destructive">{loadError}</p>
        <p className="text-sm text-muted-foreground">
          Check your connection — the model is downloaded once from the jsDelivr CDN.
        </p>
      </main>
    );
  }

  const playing = status === 'playing';
  const urgent = playing && timeLeft <= URGENT_AT;
  const over = status === 'won' || status === 'lost';

  // Floored at 1: the AI needs ~2s to say a word, so it can't truly win in zero
  // seconds — but the timer ticks whole seconds, so a fast win can land before
  // the first tick and render a "correct in 0s" that just looks broken.
  const solveSeconds = Math.max(1, ROUND_SECONDS - timeLeft);

  // Derived at render, never stored. `narration` holds whichever guess the loop
  // last spoke, which is almost never the word that won. Once the round ends the
  // loop stops, so a stored value would freeze on that unrelated guess — the
  // round would read "You win" next to "cactus". Deriving makes that
  // unrepresentable, for both won and lost.
  const narrationText =
    status === 'idle'
      ? null
      : status === 'playing'
        ? narration || null
        : displayName(word);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 p-5 sm:py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <PenLine className="size-4" />
          </span>
          <div className="leading-none">
            <h1 className="text-lg font-semibold tracking-tight">Inkling</h1>
            <p className="mt-0.5 text-[11px] text-muted-foreground">draw it, I&rsquo;ll guess</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label={soundOn ? 'Mute' : 'Unmute'}
          onClick={() => {
            stopSpeaking();
            setSoundOn((on) => !on);
          }}
        >
          {soundOn ? <Volume2 /> : <VolumeX />}
        </Button>
      </header>

      <section className="rounded-2xl border bg-card p-4">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {status === 'idle' ? 'ready' : over ? 'the word was' : 'draw this'}
              {seenCount > 0 && (
                <span className="text-muted-foreground/50">
                  {' · '}
                  {seenCount} of {bag.total}
                </span>
              )}
            </p>
            <p className="truncate text-2xl font-semibold tracking-tight">
              {word && status !== 'idle' ? displayName(word) : ready ? 'Press start' : 'Loading…'}
            </p>
          </div>
          {/* Icons, not emoji: emoji render as a different vendor's sticker on
              every OS and read as clip-art next to real type. */}
          <span className="flex h-8 shrink-0 items-center">
            {playing && (
              <span
                className={`text-2xl font-semibold tabular-nums transition-colors ${
                  urgent ? 'animate-pulse text-destructive' : 'text-muted-foreground'
                }`}
              >
                {timeLeft}s
              </span>
            )}
            {status === 'won' && <Check className="size-7 text-primary" />}
            {status === 'lost' && <X className="size-7 text-muted-foreground" />}
          </span>
        </div>

        {/* A bar reads as draining time at a glance; a number has to be read. */}
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${
              urgent ? 'bg-destructive' : 'bg-primary'
            }`}
            style={{ width: playing ? `${(timeLeft / ROUND_SECONDS) * 100}%` : over ? '0%' : '100%' }}
          />
        </div>
      </section>

      <div className="relative">
        <DrawCanvas
          canvasRef={canvasRef}
          modelCanvasRef={modelCanvasRef}
          clearRef={clearRef}
          disabled={!playing}
          won={status === 'won'}
          strokeWidth={brush}
          onDraw={() => {
            hasDrawn.current = true;
          }}
        />

        {/* Idle only. Once a round has been played the canvas holds the player's
            drawing, and any centred text lands on top of it — after the win
            popup faded, "nice one" was left sitting across their own strokes. */}
        {status === 'idle' && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <p className="text-sm text-muted-foreground">your canvas</p>
          </div>
        )}

        {/* A bar at the foot of the canvas, not a box in the middle of it: the
            drawing is the thing being celebrated, so covering it is backwards.
            solveSeconds is read here at render, never inside the narration loop:
            timeLeft is not one of that effect's deps, so its closure holds a
            stale value. The timer stops the moment status leaves 'playing', so
            by the time this renders the number has frozen at the right one. */}
        {showWin && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
            <div className="animate-in slide-in-from-bottom-4 fade-in flex items-baseline justify-between gap-3 rounded-xl bg-primary px-4 py-3 shadow-lg duration-300">
              <span className="truncate text-lg font-bold text-primary-foreground">
                {displayName(word)}
              </span>
              <span className="shrink-0 text-xs font-medium tabular-nums text-primary-foreground/70">
                correct in {solveSeconds}s
              </span>
            </div>
          </div>
        )}
      </div>

      {/* The guess, and nothing else. It sits directly under the drawing it
          describes, so "I see…" was narrating what the layout already said.
          key= restarts the animation on every change, so each guess lands. */}
      <div className="flex min-h-10 items-center">
        {narrationText && (
          <span
            key={narrationText}
            className={`animate-in fade-in slide-in-from-bottom-1 rounded-full px-4 py-1.5 text-lg font-semibold duration-200 ${
              status === 'won'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground'
            }`}
          >
            {narrationText}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {/* Clear is a canvas tool, not a round control — it belongs with the
            brush, not beside "Next word" where it competed with the primary
            action for weight. */}
        <div className="flex items-center gap-3 rounded-2xl border bg-card py-2 pl-4 pr-2">
          <PenLine className="size-4 shrink-0 text-muted-foreground" />
          <Slider
            value={[brush]}
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            step={1}
            onValueChange={([v]) => setBrush(v)}
            aria-label="Brush size"
          />
          {/* A dot at the real size beats a number: it's the actual thing. The
              well around it stops it reading as a stray speck. */}
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-paper">
            <span
              className="rounded-full bg-ink transition-all duration-150"
              style={{ width: brush / 2.4, height: brush / 2.4 }}
            />
          </span>
          <span className="h-6 w-px shrink-0 bg-border" />
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground"
            aria-label="Clear canvas"
            disabled={!playing}
            onClick={() => {
              // Bump first: an in-flight predict already holds the old pixels.
              roundEpoch.current += 1;
              clearRef.current?.();
              hasDrawn.current = false;
              guessesRef.current = [];
              setNarration('');
            }}
          >
            <Eraser />
          </Button>
        </div>

        <Button size="lg" className="h-12 w-full font-semibold" onClick={startRound} disabled={!ready}>
          {status === 'idle' ? <Play /> : <RotateCw />}
          {status === 'idle' ? 'Start' : 'Next word'}
        </Button>
      </div>
    </main>
  );
}
