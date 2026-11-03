import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ids, characters, type Reaction } from './characters.js';
import { duration, sample } from './motion.js';

const reactions = Object.keys(duration) as Reaction[];
describe.each(ids)('%s', (id) => {
  it.each(reactions)('%s starts and ends at rest and changes the drawing in between', (kind) => {
    const rest = sample(id, kind, 0);
    expect(sample(id, kind, 1)).toEqual(rest);
    expect(sample(id, kind, 0.45)).not.toEqual(rest);
    for (let frame = 0; frame <= 60; frame++) {
      const p = sample(id, kind, frame / 60);
      expect(Object.values(p).every(Number.isFinite)).toBe(true);
      expect(Math.min(p.left, p.right)).toBeGreaterThan(0);
      expect(p.smile).toBeGreaterThanOrEqual(0);
      expect(p.smile).toBeLessThanOrEqual(1);
    }
  });
  it('keeps the static SVG and its morph compatible', () => {
    const svg = readFileSync(new URL(`./faces/${id}.svg`, import.meta.url), 'utf8');
    expect(svg).toContain(`aria-label="${characters[id][0]}"`);
    expect(svg).toContain('viewBox="0 0 96 96"');
    for (const part of ['face', 'eyes', 'brows', 'mouth']) expect(svg).toContain(`id="${part}"`);
    // SVG paint order must keep the eyes in front of the moving mouth.
    expect(svg.indexOf('<g id="mouth">')).toBeLessThan(svg.indexOf('<g id="eyes">'));
    const [, rest, smile] = svg.match(/<path d="([^"]+)" data-smile="([^"]+)"/) ?? [];
    const topology = (d: string) => d.replace(/-?\d+(?:\.\d+)?/g, '#');
    expect(topology(rest!)).toBe(topology(smile!));
  });
});
it('preserves nine distinct signatures and gives the imp a two-eyed blink and a separate wink', () => {
  const signatures = ids.map((id) => JSON.stringify(sample(id, 'signature', 0.45)));
  expect(new Set(signatures).size).toBe(9);
  expect(sample('impish', 'blink', 0.45).left).toBe(sample('impish', 'blink', 0.45).right);
  expect(sample('impish', 'signature', 0.45).left).toBe(1);
  expect(sample('impish', 'signature', 0.45).right).toBeLessThan(0.25);
});
