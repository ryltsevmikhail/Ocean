/// <reference types="vite/client" />
import type { Character, Reaction } from './characters.js';
import { rig } from './rig.js';
import { duration, sample } from './motion.js';
import { material } from './material.js';

const drawings = import.meta.glob<string>('./faces/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const templates = new Map<Character, SVGSVGElement>();
const sheet = new CSSStyleSheet();
sheet.replaceSync(
  ':host{display:inline-block;container-type:inline-size}svg{display:block;width:100%;height:100%}@container(max-width:32px){.grain,.glint{display:none}}',
);

export function mountFace(host: HTMLElement) {
  const root = host.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [sheet];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new AbortController();
  let drawing: SVGSVGElement;
  let character: Character;
  let pose: ReturnType<typeof rig> | undefined;
  let frame: number | undefined;
  function stop() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    pose?.reset();
  }
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) stop();
    },
    { signal: listeners.signal },
  );
  reduced.addEventListener('change', stop, { signal: listeners.signal });
  return {
    render(id: Character, color: string) {
      stop();
      if (id !== character) {
        let template = templates.get(id);
        if (!template) {
          const source = drawings['./faces/' + id + '.svg'];
          if (!source) throw new Error('missing_character');
          const svg = new DOMParser().parseFromString(source, 'image/svg+xml').querySelector('svg');
          if (!svg) throw new Error('invalid_character');
          template = svg;
          templates.set(id, svg);
        }
        drawing = template.cloneNode(true) as SVGSVGElement;
        root.replaceChildren(drawing);
        character = id;
        pose = undefined;
      }
      for (const [key, value] of Object.entries(material(color)))
        drawing.style.setProperty(key, value);
    },
    play(kind: Reaction) {
      stop();
      if (reduced.matches || document.hidden || !host.getClientRects().length) return;
      const actor = (pose ??= rig(drawing));
      let start: number | undefined;
      const tick = (now: number) => {
        start ??= now;
        const t = (now - start) / duration[kind];
        if (t >= 1) {
          stop();
          return;
        }
        actor.apply(sample(character, kind, t));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    },
    stop,
    destroy() {
      stop();
      listeners.abort();
    },
  };
}
