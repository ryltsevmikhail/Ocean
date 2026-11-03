import type { Pose } from './performance.js';
import { pencilRig } from './pencil.js';

function eyelid(eye: SVGGElement, crease: SVGPathElement) {
  const pupil = eye.querySelector<SVGGElement>('[data-pupil]')!;
  const iris = pupil.querySelector('ellipse')!;
  const white = eye.querySelector<SVGEllipseElement>('[data-sclera]')!;
  const px = iris.cx.baseVal.value,
    py = iris.cy.baseVal.value;
  const rx = white.rx.baseVal.value,
    ry = white.ry.baseVal.value;
  const top = Math.min(py, ry * Number(eye.dataset.gazeFloor ?? -0.43));
  const box = eye.getBBox();
  const cy = box.y + box.height / 2;
  return {
    apply(p: Pose, opening: number) {
      const lid = Math.min(1, Math.max(0, (0.55 - opening) / 0.3));
      eye.setAttribute(
        'transform',
        `translate(0 ${p.lift + cy * (1 - opening)}) scale(1 ${opening})`,
      );
      eye.setAttribute('opacity', String(1 - lid));
      crease.setAttribute('opacity', String(lid));
      const x = Math.max(-rx * 0.53, Math.min(rx * 0.53, px + p.x)) - px;
      const y = Math.max(top, Math.min(ry * 0.55, py + p.y)) - py;
      pupil.setAttribute('transform', `translate(${x} ${y})`);
    },
    reset() {
      eye.removeAttribute('transform');
      eye.removeAttribute('opacity');
      crease.setAttribute('opacity', '0');
      pupil.removeAttribute('transform');
    },
  };
}

export function rig(svg: SVGSVGElement) {
  const creases = svg.querySelectorAll<SVGPathElement>('[data-crease]');
  const [left, right] = Array.from(svg.querySelectorAll<SVGGElement>('[data-eye]'), (eye, i) =>
    eyelid(eye, creases[i]!),
  );
  const head = svg.querySelector('#head')!;
  const expression = svg.querySelector('#expression')!;
  const nose = svg.querySelector('#nose')!;
  const lips = svg.querySelector('#mouth')!;
  const pencil = pencilRig(svg);
  const brows = svg.querySelector<SVGGElement>('#brows')!;
  const mouth = svg.querySelector<SVGPathElement>('#mouth path')!;
  const rest = mouth.getAttribute('d')!;
  const numbers = /-?\d+(?:\.\d+)?/g;
  const target = mouth.dataset.smile!.match(numbers)!.map(Number);
  return {
    apply(p: Pose) {
      const squeeze = p.breath * 0.014;
      head.setAttribute(
        'transform',
        `translate(48 62) rotate(${p.roll}) scale(${1 + squeeze} ${1 - squeeze}) translate(-48 -62)`,
      );
      expression.setAttribute('transform', `translate(${p.turn * 4.3} ${p.nod * 3.2})`);
      nose.setAttribute('transform', `translate(${p.turn * 2.8} ${p.nod * 1.7})`);
      lips.setAttribute(
        'transform',
        `translate(${48 + p.turn * 1.2} 68) scale(${1 - 0.23 * p.purse} ${1 + 0.1 * p.purse}) translate(-48 -68)`,
      );
      pencil.apply(p);
      left!.apply(p, p.left);
      right!.apply(p, p.right);
      brows.setAttribute(
        'transform',
        `translate(${-2.6 * p.turn} ${0.55 * p.browY - 1.6 * p.nod}) rotate(${0.65 * p.browAngle} 48 32)`,
      );
      mouth.setAttribute('transform', `translate(${p.lipX} 0)`);
      let i = 0;
      mouth.setAttribute(
        'd',
        rest.replace(numbers, (n) => String(Number(n) + (target[i++]! - Number(n)) * p.smile)),
      );
    },
    reset() {
      left!.reset();
      right!.reset();
      pencil.reset();
      for (const part of [head, expression, nose, lips, brows, mouth])
        part.removeAttribute('transform');
      mouth.setAttribute('d', rest);
    },
  };
}
