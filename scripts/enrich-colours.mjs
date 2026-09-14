#!/usr/bin/env node
// Sets each entry's brand colour from Simple Icons (CC0).
//
// Colours only. Logos aren't part of this public data — it's public domain, and
// nobody can grant that for a company's logo — so apps bundle their own. A brand
// colour is a fact about the brand, used to draw a letter tile, and belongs here.
//
// Writes colours back into data/*.json.
// Run: node scripts/enrich-colours.mjs

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const DATA_URL = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/_data/simple-icons.json';

/** Simple Icons' own slug rules, close enough for lookup. */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/\./g, 'dot')
    .replace(/&/g, 'and')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Matches a catalogue entry to a brand. Tries the full name, then drops trailing
 * words — "Xbox Game Pass" isn't a brand in Simple Icons but "Xbox" is. Aliases
 * come last: they're bank-statement descriptors and search terms, and "Claude
 * Pro" lists "anthropic", which is a real brand and the wrong one.
 */
function findBrand(entry, index) {
  const candidates = [entry.name];
  const words = entry.name.split(/\s+/);
  for (let n = words.length - 1; n >= 1; n -= 1) candidates.push(words.slice(0, n).join(' '));
  candidates.push(...(entry.aliases ?? []));
  for (const c of candidates) {
    const hit = index.get(slugify(c));
    if (hit) return hit;
  }
  return null;
}

async function main() {
  console.log('Fetching Simple Icons…');
  const res = await fetch(DATA_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Simple Icons fetch failed: ${res.status}`);
  const raw = await res.json();
  const index = new Map();
  for (const b of raw.icons ?? raw) {
    index.set(b.slug ?? slugify(b.title), b);
    for (const aka of b.aliases?.aka ?? []) index.set(slugify(aka), b);
  }

  let matched = 0;
  let changed = 0;
  for (const file of (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json'))) {
    const full = path.join(DATA_DIR, file);
    const text = await readFile(full, 'utf8');
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    let touched = false;

    for (const entry of entries) {
      const brand = findBrand(entry, index);
      if (!brand) continue;
      matched += 1;
      const hex = `#${brand.hex.toUpperCase()}`;
      if (entry.color?.toUpperCase() === hex) continue;
      if (entry.color) console.log(`  ~ ${entry.name}: ${entry.color} → ${hex}`);
      entry.color = hex;
      changed += 1;
      touched = true;
    }

    if (touched) {
      let out = `${JSON.stringify(parsed, null, 2)}\n`;
      if (text.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
      await writeFile(full, out, 'utf8');
    }
  }
  console.log(`\n${matched} entries matched a brand · ${changed} colours set or corrected`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
