import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

// RC2 requires the push layout at 1024: the overlay must stop at 1023 and the initial
// Details threshold must agree with the CSS, otherwise the overlay covers the composer.
it('starts the details push layout at 1024 instead of the old 1080 overlay boundary', () => {
  const adaptive = source('adaptive.css');
  const overlay = /@media \(max-width: (\d+)px\) \{\n {2}\.shell\.with-details \{/.exec(adaptive);
  expect(overlay).not.toBeNull();
  const desktop = source('Desktop.vue');
  const initial = /const details = ref\(window\.innerWidth >= (\d+)\)/.exec(desktop);
  const media = /matchMedia\('\(min-width:(\d+)px\)'\)/.exec(desktop);
  expect(initial).not.toBeNull();
  expect(media).not.toBeNull();
  expect(Number(overlay![1])).toBe(1023);
  expect(Number(initial![1])).toBe(1024);
  expect(Number(media![1])).toBe(1024);
  expect(source('ocean.css')).toContain(
    'grid-template-columns: var(--rail-width) minmax(0, 1fr) clamp(210px, 19.17vw, 276px);',
  );
});

it('keeps the ≤800 single-column details overlay unchanged', () => {
  const adaptive = source('adaptive.css');
  const overlay = adaptive.indexOf('.with-details .details {');
  const narrow = adaptive.indexOf('@media (max-width: 800px)');
  expect(overlay).toBeGreaterThan(-1);
  expect(narrow).toBeGreaterThan(overlay);
  expect(adaptive.slice(narrow)).toContain(
    '.shell,\n  .shell.with-details {\n    grid-template-columns: minmax(0, 1fr);\n  }',
  );
});
