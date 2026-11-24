import { describe, expect, it } from 'vitest';
import { mapGitHubWebhookToEvent } from '../../src/webhooks/githubMapper.js';

describe('mapGitHubWebhookToEvent', () => {
  it('handles ping events without emitting a NormalizedEvent', () => {
    const res = mapGitHubWebhookToEvent({
      githubEvent: 'ping',
      payload: { zen: 'Speak like a human.' },
      rawBody: Buffer.from('{}'),
    });
    expect(res).toEqual({ kind: 'ping', zen: 'Speak like a human.' });
  });

  it('maps push commits to github.commit with zero pusher.email PII leakage', () => {
    const payload = {
      ref: 'refs/heads/main',
      repository: { name: 'lokatalenta-office-3d', full_name: 'zixew/lokatalenta-office-3d' },
      pusher: { name: 'Farel Faza Nugraha', email: 'farel@lokatalenta.local' },
      commits: [
        {
          id: 'abcdef1234567890abcdef1234567890abcdef12',
          message: 'feat(office): add floor 3 gym props',
          author: { name: 'Farel Faza Nugraha', username: 'farel-faza' },
        },
      ],
    };

    const res = mapGitHubWebhookToEvent({
      githubEvent: 'push',
      deliveryId: 'deliv-push-1',
      payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    });

    expect(res.kind).toBe('event');
    if (res.kind !== 'event') return;
    expect(res.event.source).toBe('github');
    expect(res.event.type).toBe('github.commit');
    expect(res.event.agentId).toBe(5);
    expect(res.event.divisionId).toBe('engineering');
    expect(res.event.entityId).toBe('abcdef123456');
    expect(JSON.stringify(res.event)).not.toContain('farel@lokatalenta.local');
  });

  it('maps merged pull_request to boardroom success event', () => {
    const payload = {
      action: 'closed',
      repository: { name: 'lokatalenta-event-gateway', full_name: 'zixew/lokatalenta-event-gateway' },
      pull_request: {
        number: 42,
        title: 'Implement SSE replay',
        merged: true,
        user: { login: 'rizco-renova' },
      },
    };

    const res = mapGitHubWebhookToEvent({
      githubEvent: 'pull_request',
      deliveryId: 'deliv-pr-42',
      payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    });

    expect(res.kind).toBe('event');
    if (res.kind !== 'event') return;
    expect(res.event.type).toBe('github.pr');
    expect(res.event.severity).toBe('success');
    expect(res.event.targetZone).toBe('boardroom');
    expect(res.event.entityId).toBe('PR-42');
  });

  it('maps labeled issues to appropriate division agents and rejects missing repository', () => {
    const issuePayload = {
      action: 'opened',
      repository: { name: 'lokatalenta', full_name: 'zixew/lokatalenta' },
      issue: {
        number: 19,
        title: 'Security header audit',
        labels: [{ name: 'security' }],
        user: { login: 'external-user' },
      },
    };

    const res = mapGitHubWebhookToEvent({
      githubEvent: 'issues',
      deliveryId: 'deliv-issue-19',
      payload: issuePayload,
      rawBody: Buffer.from(JSON.stringify(issuePayload)),
    });
    expect(res.kind).toBe('event');
    if (res.kind === 'event') {
      expect(res.event.type).toBe('github.issue');
      expect(res.event.agentId).toBe(17);
      expect(res.event.divisionId).toBe('devops');
      expect(res.event.entityId).toBe('ISSUE-19');
    }

    const missingRepo = mapGitHubWebhookToEvent({
      githubEvent: 'push',
      payload: { commits: [] },
      rawBody: Buffer.from('{}'),
    });
    expect(missingRepo.kind).toBe('error');
  });
});
