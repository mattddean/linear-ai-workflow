import { expect, test } from 'bun:test'
import { Schema } from 'effect'
import { deepStrictEqual, strictEqual } from 'node:assert'

import { JournalData } from './boundary-schemas'
import { CommentId, IssueId, RunId, TeamId, UserId } from './domain'

// Protects legacy persisted JSON keys, optional fields, and identifier validation across schema upgrades.

const legacyId = 'aaaaaaaa-bbbb-0000-0000-cccccccccccc'
const legacyJournal = {
  assignment: {
    run: {
      id: legacyId,
      worker_group: 'local',
      worker_id: 'worker',
      issue_id: legacyId,
      issue_key: 'ENG-1',
      repo: '/repo',
      workspace: '/workspace',
      branch: 'codex/test',
      base_sha: 'a'.repeat(40),
      commit_sha: null,
      refinement_comment_id: null,
      predecessor_id: null,
      phase: 'refinement',
      status: 'queued',
      sequence: 0,
      attempts: 0,
      tokens: 0,
      max_attempts: 3,
      max_tokens: 1000,
      max_minutes: 10,
      active_millis: 0,
      note: '',
      question: null,
      wait_sequence: null,
      answer: null,
      issue_fingerprint: '[]',
      updated_at: '2026-09-18T00:00:00.000Z',
    },
    snapshot: {
      issue: {
        id: legacyId,
        identifier: 'ENG-1',
        title: 'Test',
        description: null,
        updated_at: '2026-09-18T00:00:00.000Z',
        team: { id: legacyId },
      },
      comments: [{ id: legacyId, body: 'Test', created_at: '2026-09-18T00:00:00.000Z', user: { id: legacyId } }],
    },
    artifact_dir: '/artifacts',
  },
  state: 'prepared',
  agent_started: true,
  result: {
    outcome: 'ready',
    next_role: 'developer',
    next_phase: 'implementation',
    refinement_comment_id: null,
    commit_sha: null,
    report: 'Ready',
    question: null,
  },
  comment_id: null,
  body: null,
  tokens: 0,
  elapsed_millis: 0,
  step_result: null,
}

test('legacy journal JSON decodes domain names and preserves persisted keys with optional fields absent', () => {
  const decoded = Schema.decodeUnknownSync(JournalData)(legacyJournal)
  expect(decoded.assignment.run.workerGroup).toBe('local')
  strictEqual(decoded.assignment.run.baseSha, 'a'.repeat(40))
  strictEqual(decoded.assignment.artifactDir, '/artifacts')
  expect(decoded.assignment.snapshot.issue.updatedAt).toBe('2026-09-18T00:00:00.000Z')
  expect(decoded.assignment.snapshot.comments[0]?.createdAt).toBe('2026-09-18T00:00:00.000Z')
  expect(decoded.result?.nextRole).toBe('developer')
  expect(decoded.agentStarted).toBe(true)
  deepStrictEqual(Schema.encodeSync(JournalData)(decoded), legacyJournal)
})

test('journal round-trip preserves optional token counts and response comment identifiers', () => {
  const payload = {
    ...legacyJournal,
    cached_tokens: 2,
    assignment: {
      ...legacyJournal.assignment,
      run: { ...legacyJournal.assignment.run, cached_tokens: 3, response_comment_id: legacyId },
    },
  }
  const decoded = Schema.decodeUnknownSync(JournalData)(payload)
  expect(decoded.cachedTokens).toBe(2)
  expect(decoded.assignment.run.cachedTokens).toBe(3)
  strictEqual(decoded.assignment.run.responseCommentId, legacyId)
  deepStrictEqual(Schema.encodeSync(JournalData)(decoded), payload)
})

test('identifier schemas retain dashed hexadecimal validation without adding UUID version restrictions', () => {
  for (const schema of [RunId, IssueId, CommentId, TeamId, UserId]) {
    expect(Schema.is(schema)(legacyId)).toBe(true)
    expect(Schema.is(schema)(legacyId.toUpperCase())).toBe(true)
    for (const malformed of ['not-an-id', legacyId.replaceAll('-', ''), `g${legacyId.slice(1)}`]) {
      expect(Schema.is(schema)(malformed)).toBe(false)
    }
  }
  expect(() =>
    Schema.decodeUnknownSync(JournalData)({
      ...legacyJournal,
      assignment: {
        ...legacyJournal.assignment,
        run: { ...legacyJournal.assignment.run, id: 'invalid' },
      },
    }),
  ).toThrow()
})
