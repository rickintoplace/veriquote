/** Load the pinned benchmark corpus and sample quote-sized passages from it. */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');

/** @returns {{title: string, revid: number, text: string}[]} sorted by title. */
export function loadCorpus() {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')));
}

/**
 * Split into sentences, then emit every 1-3 sentence window whose length falls
 * in `range` — the quote length the EVI1 prompt asks the model to produce.
 */
export function samplePassages(text, { range = [80, 240], max = 40, rng } = {}) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  const candidates = [];
  for (let i = 0; i < sentences.length; i++) {
    for (let n = 1; n <= 3 && i + n <= sentences.length; n++) {
      const passage = sentences.slice(i, i + n).join(' ');
      if (passage.length >= range[0] && passage.length <= range[1]) {
        candidates.push(passage);
        break; // shortest window starting here that fits
      }
    }
  }

  if (!rng || candidates.length <= max) return candidates.slice(0, max);

  // Deterministic reservoir-free sample: shuffle a copy with the seeded rng.
  const shuffled = candidates.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, max);
}
