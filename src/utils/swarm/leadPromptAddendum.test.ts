import { describe, expect, test } from 'bun:test'
import {
  TEAM_LEAD_ORCHESTRATION_ADDENDUM,
  getLeadOrchestrationReminder,
} from './leadPromptAddendum.js'

describe('getLeadOrchestrationReminder', () => {
  test('delivers the reminder once per team name', () => {
    const first = getLeadOrchestrationReminder('once-team', { force: true })
    expect(first).toContain('<system-reminder>')
    expect(first).toContain('Team Lead Orchestration')

    const second = getLeadOrchestrationReminder('once-team')
    expect(second).toBe('')
  })

  test('delivers independently for different team names', () => {
    const a = getLeadOrchestrationReminder('team-a', { force: true })
    const b = getLeadOrchestrationReminder('team-b', { force: true })
    expect(a).not.toBe('')
    expect(b).not.toBe('')
    expect(a).toBe(b) // same static body, distinct delivery markers
  })

  test('returns empty for a blank team name without touching the set', () => {
    expect(getLeadOrchestrationReminder('')).toBe('')
    // A named team must still deliver after a blank call.
    expect(
      getLeadOrchestrationReminder('after-blank', { force: true }),
    ).not.toBe('')
  })

  test('force option re-arms delivery for the same team', () => {
    expect(getLeadOrchestrationReminder('rearm', { force: true })).not.toBe('')
    expect(getLeadOrchestrationReminder('rearm')).toBe('')
    expect(
      getLeadOrchestrationReminder('rearm', { force: true }),
    ).not.toBe('')
  })
})

describe('TEAM_LEAD_ORCHESTRATION_ADDENDUM content', () => {
  test('carries the ported coordinator disciplines', () => {
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain('Research')
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain('Synthesis')
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain('Implementation')
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain('Verification')
    // Concurrency discipline
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain(
      'one teammate per set of files',
    )
    // Synthesize-before-delegating rule
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain(
      'based on your findings',
    )
    // Self-contained directives
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain(
      'cannot see your conversation',
    )
    // No fabrication
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain('Never fabricate')
    // Failure handling via the same teammate
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain(
      'message the same teammate',
    )
  })

  test('uses swarm semantics, not coordinator semantics', () => {
    // Teammates are addressed via SendMessage/mailbox, not agentId
    // continuation, and there is no <task-notification> or worker type here.
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).toContain('SendMessage')
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).not.toContain('task-notification')
    expect(TEAM_LEAD_ORCHESTRATION_ADDENDUM).not.toContain('subagent_type: "worker"')
  })
})
