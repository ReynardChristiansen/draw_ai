import { useCallback, useEffect, useRef } from 'react';

const SIZE = 420;

// What the MODEL sees — always, regardless of the player's brush setting.
// Measured against DoodleNet: at 22px+ a square is classified "picture_frame"
// and a line becomes "pencil"; below ~14px strokes evaporate in the 28x28
// downscale. So the player's brush size must never reach the model. Every
// stroke is rendered twice: once at their size for the eye, once at this size
// for the model. Changing this silently degrades accuracy — retest if you do.
const MODEL_STROKE_WIDTH = 16;

// The model's twin is the ONLY canvas bound by the preprocessing contract
// (opaque white paper, black ink — see doodlenet.js). The visible canvas is
// purely cosmetic and free to follow the theme, which is why it can be dark.
const MODEL_PAPER = '#ffffff';
const MODEL_INK = '#000000';

function themeColor(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export default function DrawCanvas({
  canvasRef,
  modelCanvasRef,
  clearRef,
  onDraw,
  disabled,
  won = false,
  strokeWidth = MODEL_STROKE_WIDTH,
}) {
  const isDrawing = useRef(false);

  const clear = useCallback(() => {
    const display = canvasRef.current?.getContext('2d');
    if (display) {
      display.fillStyle = themeColor('--paper', '#ffffff');
      display.fillRect(0, 0, SIZE, SIZE);
    }

    const model = modelCanvasRef.current?.getContext('2d');
    if (model) {
      // Opaque white, never transparent: fromPixels() drops alpha, so empty
      // pixels would read as black and invert into a fully inked canvas.
      model.fillStyle = MODEL_PAPER;
      model.fillRect(0, 0, SIZE, SIZE);
    }
  }, [canvasRef, modelCanvasRef]);

  useEffect(() => {
    if (!modelCanvasRef.current) {
      const offscreen = document.createElement('canvas');
      offscreen.width = SIZE;
      offscreen.height = SIZE;
      modelCanvasRef.current = offscreen;
    }
    clear();
    if (clearRef) clearRef.current = clear;
  }, [clear, clearRef, modelCanvasRef]);

  // Repaint the visible canvas when the OS flips light/dark, or its paper stays
  // the old theme's colour behind the new one.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const repaint = () => clear();
    query.addEventListener('change', repaint);
    return () => query.removeEventListener('change', repaint);
  }, [clear]);

  const positionOf = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * SIZE,
      y: ((event.clientY - rect.top) / rect.height) * SIZE,
    };
  };

  const surfaces = () => [
    { canvas: canvasRef.current, width: strokeWidth, ink: themeColor('--ink', '#000000') },
    { canvas: modelCanvasRef.current, width: MODEL_STROKE_WIDTH, ink: MODEL_INK },
  ];

  const start = (event) => {
    if (disabled) return;
    isDrawing.current = true;
    canvasRef.current.setPointerCapture(event.pointerId);

    const { x, y } = positionOf(event);
    for (const { canvas, width, ink } of surfaces()) {
      const ctx = canvas?.getContext('2d');
      if (!ctx) continue;
      ctx.strokeStyle = ink;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      // A tap with no movement should still leave a dot.
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    onDraw?.();
  };

  const move = (event) => {
    if (!isDrawing.current || disabled) return;

    const { x, y } = positionOf(event);
    for (const { canvas } of surfaces()) {
      const ctx = canvas?.getContext('2d');
      if (!ctx) continue;
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    onDraw?.();
  };

  const end = () => {
    isDrawing.current = false;
  };

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      // touch-none: without it a drag scrolls the page on mobile instead of drawing.
      // The win reads on the canvas itself — a ring costs no space and covers
      // none of the drawing.
      className={`aspect-square w-full touch-none rounded-2xl border bg-paper shadow-sm transition-all duration-300 ${
        won
          ? 'cursor-default ring-2 ring-primary'
          : disabled
            ? 'cursor-not-allowed'
            : 'cursor-crosshair ring-2 ring-primary/25'
      }`}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
