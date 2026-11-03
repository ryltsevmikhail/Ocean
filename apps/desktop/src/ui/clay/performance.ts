export function pulse(t: number, start = 0, peak = 0.38, release = 0.58, end = 1) {
  if (t <= start || t >= end) return 0;
  const u = t < peak ? (t - start) / (peak - start) : Math.min(1, (end - t) / (end - release));
  return u * u * (3 - 2 * u);
}
export const rest = {
  x: 0,
  y: 0,
  lift: 0,
  left: 1,
  right: 1,
  browY: 0,
  browAngle: 0,
  smile: 0,
  lipX: 0,
  turn: 0,
  nod: 0,
  roll: 0,
  breath: 0,
  purse: 0,
  pen: 0,
  first: 0,
  second: 0,
  penX: 0,
  penY: 0,
};
export type Pose = typeof rest;
function sweep(t: number, from: number, to: number) {
  const u = Math.min(1, Math.max(0, (t - from) / (to - from)));
  return u * u * (3 - 2 * u);
}

export function activity(kind: 'think' | 'write' | 'search', t: number, pose: Pose) {
  // The gaze anticipates the head. A later, smaller gesture releases each pose.
  if (kind === 'think') {
    const look = pulse(t, 0.06, 0.23, 0.6, 0.78);
    const lean = pulse(t, 0.15, 0.38, 0.64, 0.91);
    const exhale = pulse(t, 0.64, 0.78, 0.83, 1);
    pose.x = -5.5 * look + 1.5 * exhale;
    pose.y = -4.8 * look;
    pose.turn = -0.86 * lean;
    pose.nod = -0.85 * lean + 0.45 * exhale;
    pose.roll = -5.2 * lean;
    pose.browAngle = -6 * look;
    pose.browY = -2.6 * lean;
    pose.lipX = 3.8 * lean;
    pose.purse = lean;
    pose.smile = 0.42 * exhale;
    pose.left = pose.right = 1 - 0.64 * pulse(t, 0.62, 0.67, 0.69, 0.75);
    pose.breath = -0.6 * lean + 0.8 * exhale;
  } else if (kind === 'write') {
    const lean = pulse(t, 0, 0.16, 0.82, 1);
    const first = sweep(t, 0.19, 0.47),
      second = sweep(t, 0.56, 0.79);
    const lineReturn = sweep(t, 0.47, 0.56);
    const follow = pulse(t, 0.21, 0.46, 0.49, 0.56) + 0.76 * pulse(t, 0.57, 0.78, 0.81, 0.97);
    const angle = first - lineReturn + second * 0.75;
    pose.x = -3.5 * lean + 7 * angle * lean;
    pose.y = (4 + 1.5 * lineReturn) * lean;
    pose.turn = -0.55 * lean + 0.94 * follow;
    pose.nod = lean;
    pose.roll = -3 * lean + 4 * follow;
    pose.lift = 1.5 * lean;
    pose.browY = 1.5 * lean;
    pose.purse = 0.75 * lean;
    pose.lipX = -2 * lean;
    pose.left = pose.right = 1 - 0.5 * pulse(t, 0.47, 0.5, 0.51, 0.55);
    pose.breath = 0.65 * lean;
    pose.pen = pulse(t, 0.02, 0.15, 0.84, 0.98);
    // Store only visible ink. At rest even the trace is completely reset.
    pose.first = pose.pen * first;
    pose.second = pose.pen * second;
    pose.penX = angle * 18 * pose.pen;
    pose.penY =
      (4 * lineReturn - 3 * pulse(t, 0.47, 0.5, 0.51, 0.57) + 0.9 * Math.sin(angle * Math.PI * 4)) *
      pose.pen;
  } else {
    const left = pulse(t, 0, 0.16, 0.27, 0.45),
      right = pulse(t, 0.35, 0.52, 0.68, 0.84);
    const reachLeft = pulse(t, 0.07, 0.25, 0.32, 0.55),
      reachRight = pulse(t, 0.43, 0.63, 0.73, 0.96);
    const peer = pulse(t, 0.68, 0.78, 0.83, 1);
    pose.x = 6.3 * (right - left);
    pose.y = -2.5 * left + 1.8 * right;
    pose.turn = reachRight - reachLeft;
    pose.roll = 4.8 * (reachRight - reachLeft);
    pose.nod = -0.5 * reachLeft + 0.7 * peer;
    pose.browY = -2.6 * (left + right);
    pose.browAngle = 5 * (right - left);
    pose.purse = 0.6 * reachLeft;
    pose.left = pose.right = 1 + 0.14 * right - 0.25 * peer;
    pose.lipX = 2 * reachRight;
    pose.breath = -0.7 * peer;
  }
}
