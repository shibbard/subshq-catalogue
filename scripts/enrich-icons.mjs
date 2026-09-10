#!/usr/bin/env node
// Enriches catalogue entries from Simple Icons (CC0): brand colours and
// official monochrome logos.
//
// WHY THIS RATHER THAN FAVICONS
//
// Favicons are a lottery. Sizes range from 16px to 180px, several large sites
// answer /favicon.ico with an HTML error page, and the results are a mix of
// full-bleed tiles and transparent glyphs that never look like one set.
//
// Simple Icons are single-path monochrome SVGs with a verified brand hex. Drawn
// as a white glyph on the brand colour they are crisp at any size and uniform
// across the catalogue, and they carry no resolution to run out of.
//
// The icon files are CC0. The marks themselves remain the trademarks of their
// owners and are used here to identify the services described.
//
// Writes colours back into data/*.json and SVGs into icons/.
// Run: node scripts/enrich-icons.mjs

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const DATA_DIR = path.join(root, 'data');
const ICON_SRC = path.join(root, 'icons');

const DATA_URL = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/_data/simple-icons.json';
const svgUrl = (slug) => `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`;

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
 * Matches a catalogue entry to a brand. Tries the full name, then aliases,
 * then progressively drops trailing words — "Xbox Game Pass" is not a brand in
 * Simple Icons but "Xbox" is, and that is the right mark for it.
 */
function findBrand(entry, index) {
  // Order matters. `aliases` in this catalogue are bank-statement descriptors
  // and search terms, not brand names — "Claude Pro" lists "anthropic", which
  // is a real Simple Icons brand and the wrong mark. The name and its trimmed
  // forms are tried first; aliases are a last resort.
  const candidates = [entry.name];

  const words = entry.name.split(/\s+/);
  for (let n = words.length - 1; n >= 1; n -= 1) {
    candidates.push(words.slice(0, n).join(' '));
  }

  candidates.push(...(entry.aliases ?? []));

  for (const c of candidates) {
    const hit = index.get(slugify(c));
    if (hit) return { brand: hit, matchedOn: c };
  }
  return null;
}

async function main() {
  console.log('Fetching Simple Icons…');
  const res = await fetch(DATA_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Simple Icons fetch failed: ${res.status}`);
  const raw = await res.json();
  const brands = raw.icons ?? raw;

  const index = new Map();
  for (const b of brands) {
    const slug = b.slug ?? slugify(b.title);
    index.set(slug, { ...b, slug });
    for (const aka of b.aliases?.aka ?? []) index.set(slugify(aka), { ...b, slug });
  }
  console.log(`  ${brands.length} brands indexed\n`);

  await mkdir(ICON_SRC, { recursive: true });

  const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  let matched = 0;
  let missed = 0;
  let recoloured = 0;
  const misses = [];

  for (const file of files) {
    const full = path.join(DATA_DIR, file);
    const parsed = JSON.parse(await readFile(full, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    let touched = false;

    for (const entry of entries) {
      const hit = findBrand(entry, index);
      if (!hit) {
        missed += 1;
        misses.push(entry.name);
        continue;
      }

      const hex = `#${hit.brand.hex.toUpperCase()}`;
      if (entry.color && entry.color.toUpperCase() !== hex) {
        console.log(`  ~ ${entry.name}: ${entry.color} → ${hex} (Simple Icons is the source of truth)`);
        recoloured += 1;
      }
      entry.color = hex;
      entry.icon = `${entry.id}.svg`;
      touched = true;
      matched += 1;

      const svgRes = await fetch(svgUrl(hit.brand.slug), { signal: AbortSignal.timeout(15000) });
      if (svgRes.ok) {
        await writeFile(path.join(ICON_SRC, `${entry.id}.svg`), await svgRes.text(), 'utf8');
      } else {
        delete entry.icon;
      }
    }

    if (touched) {
      await writeFile(full, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    }
  }

  console.log(`\n${matched} entries matched to a brand mark`);
  console.log(`${recoloured} brand colours corrected`);
  console.log(`${missed} unmatched — these fall back to a monogram:`);
  console.log(`  ${misses.slice(0, 20).join(', ')}${misses.length > 20 ? `, …and ${misses.length - 20} more` : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
