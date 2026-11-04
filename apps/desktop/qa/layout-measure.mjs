/* eslint-disable no-undef -- page.evaluate callbacks run in the renderer, not in Node. */
// Measurement and pure assertions for the 1024/1280/1920 composer reachability GUI regression.
// Browser-side code runs only through page.evaluate; checkReachable is pure so node --test can
// exercise the obstruction logic without launching Electron.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function measureLayout(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        x: round(box.x),
        y: round(box.y),
        width: round(box.width),
        height: round(box.height),
        right: round(box.right),
        bottom: round(box.bottom),
      };
    };
    const visible = (el) =>
      !!el &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden' &&
      getComputedStyle(el).display !== 'none';
    const elements = {
      shell: document.querySelector('.shell'),
      rail: document.querySelector('.shell > .rail'),
      main: document.querySelector('.shell > main'),
      details: document.querySelector('.shell > aside.details'),
      composer: document.querySelector('#composer'),
      textarea: document.querySelector('#composer textarea'),
      send: document.querySelector('#composer .send'),
      history: document.querySelector('#history'),
    };
    const hit = (target) => {
      if (!target) return null;
      const box = target.getBoundingClientRect();
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      const found = document.elementFromPoint(x, y);
      const className = typeof found?.className === 'string' ? found.className : null;
      return {
        x,
        y,
        tag: found?.tagName ?? null,
        className,
        target: !!found && (found === target || target.contains(found)),
        insideDetails: !!elements.details && elements.details.contains(found),
        insideComposer: !!elements.composer && elements.composer.contains(found),
      };
    };
    const overlap = (a, b) => {
      if (!a || !b) return null;
      const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
      const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
      return { width: round(width), height: round(height), area: round(width * height) };
    };
    const rects = {
      rail: rect(elements.rail),
      main: rect(elements.main),
      composer: rect(elements.composer),
      textarea: rect(elements.textarea),
      send: rect(elements.send),
      history: rect(elements.history),
      details: rect(elements.details),
    };
    const details = elements.details;
    const history = elements.history;
    const columns = elements.shell ? getComputedStyle(elements.shell).gridTemplateColumns : null;
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      rects,
      columns,
      details: details
        ? {
            position: getComputedStyle(details).position,
            zIndex: getComputedStyle(details).zIndex,
            visible: visible(details),
          }
        : null,
      controls: {
        textarea: elements.textarea
          ? {
              disabled: elements.textarea.disabled,
              readOnly: elements.textarea.readOnly,
              value: elements.textarea.value,
              visible: visible(elements.textarea),
              focused: document.activeElement === elements.textarea,
            }
          : null,
        send: elements.send
          ? {
              disabled: elements.send.disabled,
              label: elements.send.getAttribute('aria-label'),
              visible: visible(elements.send),
            }
          : null,
      },
      hits: { textarea: hit(elements.textarea), send: hit(elements.send) },
      overlaps: {
        composer: overlap(rects.composer, rects.details),
        textarea: overlap(rects.textarea, rects.details),
        send: overlap(rects.send, rects.details),
      },
      history: history
        ? {
            scrollTop: round(history.scrollTop),
            scrollHeight: round(history.scrollHeight),
            clientHeight: round(history.clientHeight),
            pinned: history.scrollHeight - history.scrollTop - history.clientHeight <= 2,
            role: history.getAttribute('role'),
            live: history.getAttribute('aria-live'),
            relevant: history.getAttribute('aria-relevant'),
            scrollable: history.scrollHeight > history.clientHeight,
          }
        : null,
    };
  });
}

const insideViewport = (rect, viewport) =>
  rect !== null &&
  rect.width > 0 &&
  rect.height > 0 &&
  rect.x >= -0.5 &&
  rect.y >= -0.5 &&
  rect.right <= viewport.width + 0.5 &&
  rect.bottom <= viewport.height + 0.5;

const covered = (hit) => hit !== null && (!hit.target || hit.insideDetails);

// Returns every reason the measured layout obscures or disables the composer at this width.
export function checkReachable(measure, width, { detailsOpen, draft = '' }) {
  const problems = [];
  const add = (code, data) => problems.push({ code, ...(data === undefined ? {} : { data }) });
  if (measure.viewport.width !== width) add('viewport-width', measure.viewport);
  for (const name of ['composer', 'textarea', 'send']) {
    const rect = measure.rects[name];
    if (!rect) add('missing-' + name);
    else if (!insideViewport(rect, measure.viewport))
      add('outside-viewport-' + name, { rect, viewport: measure.viewport });
  }
  if (!measure.controls.textarea?.visible) add('hidden-textarea');
  if (measure.controls.textarea?.disabled || measure.controls.textarea?.readOnly)
    add('textarea-not-editable', measure.controls.textarea);
  if (!measure.controls.send?.visible) add('hidden-send');
  if (draft !== '' && measure.controls.send?.disabled) add('disabled-send');
  if (measure.controls.textarea?.value !== draft) add('draft-changed');
  for (const name of ['textarea', 'send']) {
    const hit = measure.hits[name];
    if (covered(hit)) add('covered-' + name, hit);
    else if (hit?.insideComposer !== true) add('outside-composer-' + name, hit);
  }
  if (detailsOpen) {
    if (!measure.rects.details) add('missing-details');
    else {
      if (!measure.details?.visible) add('hidden-details');
      if (measure.details?.position !== 'static') add('overlay-details', measure.details);
      for (const name of ['composer', 'textarea', 'send']) {
        const overlap = measure.overlaps[name];
        if (!overlap || overlap.area !== 0)
          add('overlap-' + name, { overlap, details: measure.rects.details });
      }
      if (measure.rects.main && measure.rects.details.x < measure.rects.main.right - 0.5)
        add('details-not-beside-main', {
          main: measure.rects.main,
          details: measure.rects.details,
        });
    }
  } else if (measure.rects.details) add('unexpected-details');
  return problems;
}

export function fileSHA256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
