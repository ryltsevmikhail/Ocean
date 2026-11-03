import type { Character, Reaction } from './characters.js';

import { activity, pulse, rest } from './performance.js';

export const duration = {
  blink: 180,
  gaze: 640,
  smile: 800,
  signature: 1180,
  think: 2380,
  write: 2460,
  search: 2120,
} as const;
const directions = {
  curious: [4, -3],
  skeptic: [-4, 1],
  calm: [3, 1],
  joyful: [3, -2],
  impish: [5, 0],
  dreamer: [3, -4],
  resolute: [3, 0],
  surprised: [0, -3],
  pensive: [-3, 3],
} as const;

export function sample(id: Character, kind: Reaction, t: number) {
  const p = pulse(t);
  const pose = { ...rest };
  const [dx, dy] = directions[id];
  function glance(amount: number) {
    pose.x = dx * amount;
    pose.y = dy * amount;
  }
  if (kind === 'blink') {
    pose.left = pose.right = 1 - 0.75 * p;
  } else if (kind === 'gaze') {
    glance(p);
    pose.turn = 0.075 * dx * pulse(t, 0.14, 0.46, 0.7, 1);
  } else if (kind === 'smile') {
    pose.smile = p;
    pose.lift = -1.2 * pulse(t, 0.08, 0.49, 0.64, 1);
  } else if (kind !== 'signature') {
    activity(kind, t, pose);
  } else {
    const late = pulse(t, 0.26, 0.53, 0.74, 1);
    switch (id) {
      case 'curious':
        pose.roll = -4 * late;
        pose.turn = 0.65 * late;
        pose.browY = -4 * p;
        glance(late);
        pose.smile = late * 0.65;
        break;
      case 'skeptic':
        pose.turn = -0.74 * late;
        pose.roll = 2.6 * late;
        pose.left = pose.right = 1 - 0.18 * p;
        glance(late);
        pose.browAngle = -6 * p;
        pose.smile = late * 0.7;
        break;
      case 'impish':
        pose.roll = 4.4 * late;
        pose.turn = 0.8 * p;
        glance(pulse(t, 0, 0.18, 0.46, 0.85));
        pose.right = 1 - 0.8 * pulse(t, 0.35, 0.43, 0.48, 0.55);
        pose.smile = late;
        break;
      case 'calm':
        pose.breath = -p + 0.8 * late;
        pose.nod = 0.6 * late;
        pose.left = pose.right = 1 - 0.48 * p;
        pose.lift = 2.5 * p;
        pose.browY = 2 * p;
        pose.smile = late * 0.6;
        break;
      case 'joyful':
        pose.breath = p - 1.5 * late;
        pose.roll = -3 * late;
        pose.smile = p;
        pose.lift = -3 * late;
        pose.left = pose.right = 1 - 0.25 * late;
        break;
      case 'dreamer':
        pose.nod = -0.9 * late;
        pose.roll = 4 * p;
        glance(p);
        pose.x = dx * late;
        pose.browAngle = -4 * p;
        pose.smile = late;
        break;
      case 'resolute':
        pose.nod = -0.65 * p + 1.4 * late;
        pose.breath = 0.8 * late;
        pose.browY = 2 * p;
        pose.lift = -1.5 * late;
        pose.left = pose.right = 1 + 0.12 * late;
        pose.smile = late * 0.45;
        break;
      case 'surprised':
        pose.nod = -0.8 * p;
        pose.roll = -3 * late;
        pose.breath = -p;
        pose.browY = -4 * p;
        pose.left = pose.right = 1 + 0.22 * p;
        pose.smile = late * 0.8;
        break;
      case 'pensive':
        pose.turn = -0.7 * late;
        pose.nod = 0.7 * late;
        pose.purse = 0.7 * p;
        glance(p);
        pose.browAngle = -5 * late;
        pose.lipX = 3.5 * late;
        pose.smile = 0.4 * late;
        break;
    }
  }
  return pose;
}
