import assert from 'node:assert/strict';
import test from 'node:test';
import { checkReachable } from './layout-measure.mjs';

const rect = (x, y, width, height) => ({
  x,
  y,
  width,
  height,
  right: x + width,
  bottom: y + height,
});
const hit = (target = true, insideDetails = false) => ({
  x: 300,
  y: 620,
  tag: 'TEXTAREA',
  className: null,
  target,
  insideDetails,
  insideComposer: !insideDetails,
});
function pushLayout(width = 1024) {
  return {
    viewport: { width, height: 800, dpr: 1 },
    columns: '220px 594px 210px',
    rects: {
      rail: rect(0, 0, 220, 800),
      main: rect(220, 0, 594, 800),
      composer: rect(250, 600, 533, 80),
      textarea: rect(270, 615, 430, 40),
      send: rect(735, 615, 40, 40),
      history: rect(220, 76, 594, 524),
      details: rect(814, 0, 210, 800),
    },
    details: { position: 'static', zIndex: 'auto', visible: true },
    controls: {
      textarea: {
        disabled: false,
        readOnly: false,
        value: 'draft text',
        visible: true,
        focused: false,
      },
      send: { disabled: false, label: 'Отправить', visible: true },
    },
    hits: { textarea: hit(), send: hit() },
    overlaps: {
      composer: { width: 0, height: 0, area: 0 },
      textarea: { width: 0, height: 0, area: 0 },
      send: { width: 0, height: 0, area: 0 },
    },
    history: { pinned: true, scrollable: true },
  };
}
const codes = (problems) => problems.map((problem) => problem.code);

test('accepts the three-column push layout with details open', () => {
  assert.deepEqual(
    checkReachable(pushLayout(), 1024, { detailsOpen: true, draft: 'draft text' }),
    [],
  );
});

test('rejects the pre-fix 280px overlay covering composer and Send', () => {
  const overlay = pushLayout();
  overlay.columns = '220px 804px';
  overlay.rects.details = rect(744, 0, 280, 800);
  overlay.rects.main = rect(220, 0, 804, 800);
  overlay.details = { position: 'absolute', zIndex: '2', visible: true };
  overlay.hits.send = hit(false, true);
  overlay.overlaps.send = { width: 40, height: 40, area: 1600 };
  const problems = codes(checkReachable(overlay, 1024, { detailsOpen: true, draft: 'draft text' }));
  for (const expected of [
    'covered-send',
    'overlay-details',
    'overlap-send',
    'details-not-beside-main',
  ])
    assert.ok(problems.includes(expected), expected);
});

test('rejects layout defects other than the details overlay', () => {
  const outside = pushLayout();
  outside.rects.send = rect(1100, 615, 40, 40);
  outside.hits.send = hit(false);
  assert.ok(
    codes(checkReachable(outside, 1024, { detailsOpen: true })).includes('outside-viewport-send'),
  );
  const disabled = pushLayout();
  disabled.controls.send.disabled = true;
  assert.ok(
    codes(checkReachable(disabled, 1024, { detailsOpen: true, draft: 'x' })).includes(
      'disabled-send',
    ),
  );
  const lost = pushLayout();
  lost.controls.textarea.value = '';
  assert.ok(
    codes(checkReachable(lost, 1024, { detailsOpen: true, draft: 'x' })).includes('draft-changed'),
  );
  const stale = pushLayout();
  assert.ok(
    codes(checkReachable(stale, 1024, { detailsOpen: false })).includes('unexpected-details'),
  );
  const wrongWidth = pushLayout();
  assert.ok(
    codes(checkReachable(wrongWidth, 1280, { detailsOpen: true })).includes('viewport-width'),
  );
});
