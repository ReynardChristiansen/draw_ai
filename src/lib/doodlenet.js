import * as tf from '@tensorflow/tfjs';

const BASE =
  'https://cdn.jsdelivr.net/gh/ml5js/ml5-data-and-models@master/models/doodlenet';
const MODEL_URL = `${BASE}/model.json`;
const LABELS_URL = `${BASE}/class_names.txt`;

const INPUT_SIZE = 28;

// Pixels lighter than this count as background when finding the bounding box.
const INK_CUTOFF = 250;

// Breathing room around the crop, relative to the drawing's longest side.
// Quick Draw bitmaps carry a small margin; 0 pushes strokes flush against the
// edge and accuracy drops.
const PAD_RATIO = 0.08;

let model = null;
let labels = [];

export function getLabels() {
  return labels;
}

export async function loadDoodleNet() {
  if (model) return;

  const [loadedModel, labelText] = await Promise.all([
    tf.loadLayersModel(MODEL_URL),
    fetch(LABELS_URL).then((res) => {
      if (!res.ok) throw new Error(`Failed to load labels: HTTP ${res.status}`);
      return res.text();
    }),
  ]);

  model = loadedModel;
  labels = labelText
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (labels.length !== 345) {
    throw new Error(`Unexpected label count: ${labels.length}, expected 345.`);
  }

  tf.tidy(() => {
    model.predict(tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 1])).dispose();
  });
}

// Quick Draw normalizes every image to its stroke bounding box, so we have to
// do the same. Without this, a small drawing in a corner shrinks to a few
// pixels on resize and can never be guessed (measured: a house in the corner
// went from 17% to 65% once cropped).
function cropToContent(canvas) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4] < INK_CUTOFF) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null; // blank canvas

  // Square box so the drawing isn't squashed when scaled.
  const side = Math.max(maxX - minX, maxY - minY);
  const box = side * (1 + PAD_RATIO * 2);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const out = document.createElement('canvas');
  out.width = INPUT_SIZE;
  out.height = INPUT_SIZE;
  const outCtx = out.getContext('2d');
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(
    canvas,
    centerX - box / 2,
    centerY - box / 2,
    box,
    box,
    0,
    0,
    INPUT_SIZE,
    INPUT_SIZE,
  );
  return out;
}

function toTensor(cropped) {
  return tf.tidy(() => {
    // numChannels 3 drops alpha. On a transparent canvas the empty pixels read
    // as black, then inversion turns them into strokes and the whole
    // background becomes "drawing". Hence the canvas must be filled opaque
    // white.
    const rgb = tf.browser.fromPixels(cropped, 3).toFloat();

    // Canvas is black strokes on white. The model wants white strokes on
    // black. Skip this line and it guesses nonsense with no error at all.
    const inverted = tf.scalar(1).sub(rgb.div(255));

    // Do NOT binarize. Quick Draw bitmaps are anti-aliased and the model
    // relies on that gradient. Measured on 8 real Quick Draw banana bitmaps:
    // grayscale got 8/8 right (98%, 94%, 97%...), binarized got 1/8. This is
    // also why ml5's .floor() should not be copied.
    return inverted.mean(2).reshape([1, INPUT_SIZE, INPUT_SIZE, 1]);
  });
}

export async function predict(canvas, topK = 3) {
  if (!model) throw new Error('Model not loaded. Call loadDoodleNet() first.');

  const cropped = cropToContent(canvas);
  if (!cropped) return [];

  const probsTensor = tf.tidy(() => model.predict(toTensor(cropped)).squeeze());
  const probs = await probsTensor.data();
  probsTensor.dispose();

  return Array.from(probs, (p, i) => ({ label: labels[i], p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, topK);
}
