import { expect, it } from 'vitest';
import { projectActions, projectStatus } from './project-state.js';

it('does not offer apply for stale approval or a different snapshot', () => {
  const input = {
    ready: true,
    active: false,
    uncertain: false,
    hash: 'saved',
    reviewedHash: 'saved',
    approved: true,
    stale: false,
  };
  expect(projectActions(input).apply).toBe(true);
  expect(projectActions({ ...input, stale: true }).apply).toBe(false);
  expect(projectActions({ ...input, reviewedHash: 'other' }).apply).toBe(false);
});

it('keeps acknowledgement and unknown outcomes separate from confirmed results', () => {
  expect(projectStatus('allowed')).not.toEqual(projectStatus('completed'));
  expect(projectStatus('outcome_unknown')).not.toEqual(projectStatus('cancelled'));
  expect(
    projectActions({
      ready: true,
      active: false,
      uncertain: true,
      hash: 'saved',
      reviewedHash: 'saved',
      approved: true,
      stale: false,
    }),
  ).toEqual({ send: false, capture: false, review: false, apply: false });
});

it('restores a prior handle only when a new request is definitively refused', async () => {
  const { projectAdmission } = await import('./project-state.js');
  let handle = 'new';
  const restore = () => {
    handle = 'prior';
  };
  await expect(
    projectAdmission(async () => {
      throw Error('project_changed');
    }, restore),
  ).rejects.toThrow('project_changed');
  expect(handle).toBe('prior');
  handle = 'new';
  await expect(
    projectAdmission(async () => {
      throw Error('outcome_unknown');
    }, restore),
  ).rejects.toThrow('outcome_unknown');
  expect(handle).toBe('new');
});
