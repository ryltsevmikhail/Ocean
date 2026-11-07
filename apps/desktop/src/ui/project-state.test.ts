import { expect, it } from 'vitest';
import { projectActions, projectAdmission, projectError, projectStatus } from './project-state.js';

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

it('keeps an owner preview’s visible directional escapes intact', async () => {
  const { projectDecisionText } = await import('./project-state.js');
  const escaped = '{"path":"safe\\u202ereversed.txt"}';
  expect(projectDecisionText(escaped)).toBe(escaped);
  expect(projectDecisionText('unsafe\u202Epath')).toBe('unsafe\\u202epath');
});

it.each([
  'project_pre_card_request_conflict',
  'project_pre_card_recovery_required',
  'project_pre_card_catalog_unavailable',
  'project_pre_card_model_transfer_denied',
  'project_pre_card_model_policy_unavailable',
])('restores the prior selection on %s and explains the prerequisite', async (code) => {
  let handle = 'submitted';
  const failure = Error(code);
  await expect(
    projectAdmission(
      async () => {
        throw failure;
      },
      () => {
        handle = 'editable';
      },
    ),
  ).rejects.toBe(failure);
  expect(handle).toBe('editable');
  expect(projectError(failure)).not.toBe(projectError(Error('outcome_unknown')));
});

it.each([
  'request_conflict',
  'recovery_required',
  'reservation_unavailable',
  'unknown_decision',
  'outcome_unknown',
])('retains the exact saved handle on unproven %s', async (code) => {
  let handle = 'submitted';
  await expect(
    projectAdmission(
      async () => {
        throw Error(code);
      },
      () => {
        handle = 'editable';
      },
    ),
  ).rejects.toThrow(code);
  expect(handle).toBe('submitted');
});
