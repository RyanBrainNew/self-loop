import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ineligibleReason,
  labelNames,
  linkedPrNumbers,
  parseArgs,
  parsePolicy,
  roleOf,
  selectCandidate,
} from './lib.mjs';
import { resolveWindow } from './retro.mjs';

const now = Date.parse('2026-11-13T08:00:00Z');

function issue(overrides = {}) {
  return {
    number: 1,
    title: 'fixture',
    labels: [],
    assignees: [],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    hasOpenPR: false,
    linkedPR: null,
    verdict: '',
    ...overrides,
  };
}

test('Matt labels are the only taxonomy', () => {
  assert.deepEqual(labelNames([{ name: 'bug' }, 'ready-for-agent']), ['bug', 'ready-for-agent']);
  assert.equal(roleOf([{ name: 'bug' }, { name: 'ready-for-agent' }]), 'ready-for-agent');
  assert.equal(roleOf([{ name: 'bug' }]), 'unlabeled');
});

test('policy parsing stays explicit', () => {
  assert.deepEqual(parsePolicy(''), { raw: 'ready-for-agent', kind: 'label', label: 'ready-for-agent' });
  assert.deepEqual(parsePolicy('do'), { raw: 'do', kind: 'verdict' });
  assert.deepEqual(parsePolicy('label:good-first-issue'), {
    raw: 'label:good-first-issue',
    kind: 'label',
    label: 'good-first-issue',
  });
  assert.equal(parsePolicy('off').kind, 'off');
  assert.deepEqual(parsePolicy('needs-triage'), { raw: 'needs-triage', kind: 'label', label: 'needs-triage' });
});

test('flags are boolean properties, not a Set', () => {
  const parsed = parseArgs(['issue', '--dry-run', '--policy', 'do', '--no-claim']);
  assert.deepEqual(parsed.rest, ['issue']);
  assert.deepEqual(parsed.values, { policy: 'do' });
  assert.equal(parsed.flags['dry-run'], true);
  assert.equal(parsed.flags['no-claim'], true);
});

test('default policy only takes ready-for-agent', () => {
  const policy = parsePolicy();
  assert.match(ineligibleReason(issue(), { policy, now }), /missing label ready-for-agent/);
  assert.equal(ineligibleReason(issue({ labels: ['ready-for-agent'] }), { policy, now }), '');
});

test('Matt blocking roles always win', () => {
  const policy = parsePolicy('do');
  for (const label of ['needs-info', 'ready-for-human', 'wontfix']) {
    assert.match(ineligibleReason(issue({ labels: [label], verdict: 'do' }), { policy, now }), /blocked by label/);
  }
  assert.match(ineligibleReason(issue({ labels: ['needs-triage'], verdict: 'do' }), { policy, now }), /needs triage/);
});

test('open PR and other assignees block; own stale claim can retry', () => {
  const policy = parsePolicy('ready-for-agent');
  const labels = ['ready-for-agent'];
  assert.match(
    ineligibleReason(issue({ labels, hasOpenPR: true, linkedPR: 12 }), { policy, now }),
    /open PR #12/,
  );
  assert.match(
    ineligibleReason(issue({ labels, assignees: ['someone-else'] }), { policy, selfLogin: 'bot', now }),
    /assigned to someone-else/,
  );
  assert.match(
    ineligibleReason(issue({ labels, assignees: ['bot'], updatedAt: '2026-11-13T07:00:00Z' }), {
      policy,
      selfLogin: 'bot',
      now,
      claimTtlMinutes: 180,
    }),
    /claimed recently/,
  );
  assert.equal(
    ineligibleReason(issue({ labels, assignees: ['bot'], updatedAt: '2026-11-12T00:00:00Z' }), {
      policy,
      selfLogin: 'bot',
      now,
      claimTtlMinutes: 180,
    }),
    '',
  );
});

test('do policy follows the advisory verdict but keeps labels authoritative', () => {
  const policy = parsePolicy('do');
  assert.equal(ineligibleReason(issue({ verdict: 'do' }), { policy, now }), '');
  assert.match(ineligibleReason(issue({ verdict: 'ignore' }), { policy, now }), /not do/);
  assert.match(
    ineligibleReason(issue({ verdict: 'do', labels: ['needs-info'] }), { policy, now }),
    /blocked by label needs-info/,
  );
});

test('selection is oldest-first and skips ineligible issues', () => {
  const policy = parsePolicy('ready-for-agent');
  const issues = [
    issue({ number: 3, labels: ['ready-for-agent'], createdAt: '2026-11-01T00:00:00Z' }),
    issue({ number: 2, labels: ['ready-for-agent'], createdAt: '2026-10-01T00:00:00Z', hasOpenPR: true, linkedPR: 9 }),
    issue({ number: 1, labels: ['ready-for-agent'], createdAt: '2026-10-20T00:00:00Z' }),
  ];
  assert.equal(selectCandidate(issues, { policy, now }).number, 1);
  assert.equal(selectCandidate([issues[1]], { policy, now }), null);
});

test('PR bodies map closing references to issue numbers', () => {
  const links = linkedPrNumbers([
    { number: 40, title: 'fix', body: 'Closes #12\nAlso fixes #13', head: { ref: 'loop/14-title' } },
    { number: 41, title: 'chore', body: 'no close keyword' },
  ]);
  assert.equal(links.get(12), 40);
  assert.equal(links.get(13), 40);
  assert.equal(links.get(14), 40);
  assert.equal(links.size, 3);
});

test('retro window honours an explicit since value', () => {
  const window = resolveWindow({ since: 'abc123' });
  assert.equal(window.source, 'explicit');
  assert.equal(window.since, 'abc123');
});
