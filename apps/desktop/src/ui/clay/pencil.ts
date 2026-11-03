import type { Pose } from './performance.js';

export function pencilRig(svg: SVGSVGElement) {
  // The stylus stays in the foreground as the face leans towards the page.
  svg.insertAdjacentHTML(
    'beforeend',
    `<g data-writing="" opacity="0" aria-hidden="true">
    <g fill="none" stroke="#60778a" stroke-width="1.9" stroke-linecap="round" stroke-dasharray="1">
      <path d="M57 86q4 -1.2 8 0t10 0" pathLength="1" stroke-dashoffset="1"/>
      <path d="M57 90q4 -1.2 8 0t5.5 0" pathLength="1" stroke-dashoffset="1"/>
    </g>
    <g data-stylus="" transform="translate(57 86)">
      <path d="M0 0l1.1 -5.2 9 -13.5q1.7 -2.3 4 .1 1.1 1.2 .1 2.8L4.7 -2.9Z" fill="#ffc748" stroke="#89512d" stroke-width=".85" stroke-linejoin="round"/>
      <path d="M0 0l1.1 -5.2 3.6 2.3Z" fill="#f4dfb6"/><path d="M0 0l.5 -2.4 1.8 1.2Z" fill="#29262e"/>
      <path d="M3.2 -5.2l8.3 -12.6" stroke="#ffe7a0" stroke-width="1.25" stroke-linecap="round"/>
    </g></g>`,
  );
  const group = svg.querySelector<SVGGElement>('[data-writing]')!;
  const pen = group.querySelector('[data-stylus]')!;
  const [first, second] = group.querySelectorAll('path[pathLength]');
  return {
    apply(p: Pose) {
      group.setAttribute('opacity', String(p.pen));
      pen.setAttribute('transform', `translate(${57 + p.penX} ${86 + p.penY})`);
      first!.setAttribute('stroke-dashoffset', String(1 - p.first));
      second!.setAttribute('stroke-dashoffset', String(1 - p.second));
    },
    reset() {
      group.setAttribute('opacity', '0');
      pen.setAttribute('transform', 'translate(57 86)');
      first!.setAttribute('stroke-dashoffset', '1');
      second!.setAttribute('stroke-dashoffset', '1');
    },
  };
}
