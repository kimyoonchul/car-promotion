import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_PATH = fileURLToPath(new URL('../data/state.json', import.meta.url));

export function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    state.extracts ??= {};
    return state;
  } catch {
    return { seen: {}, extracts: {} };
  }
}

export function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
