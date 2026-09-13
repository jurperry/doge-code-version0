import { describe, expect, test } from 'bun:test'
import { hasAgentTeamsKeyword } from './agentTeamsKeywords.js'

describe('hasAgentTeamsKeyword', () => {
  describe('triggers', () => {
    test.each([
      // English forms (case-insensitive, singular/plural)
      'use agent teams to build this',
      'Agent Teams please',
      'spawn an agent team for the refactor',
      'run an agent swarm on this repo',
      'AGENT SWARMS go',
      // Chinese forms from the requirement list
      '用多agent协作来完成这个任务',
      '多agent协同重构这个模块',
      '多智能体协同调研一下',
      '多智能体协作开发这个功能',
      '启动agent集群',
      '使用智能体集群处理',
      '开一个智能体队伍来做',
      // CJK neighbor directly against the ASCII edge
      '使用agent集群跑任务',
      '请用agent swarm帮我',
      // Mid-sentence with sentence punctuation
      '这个任务复杂，多agent协作。开始吧',
      'please, use agent teams.',
      // One valid occurrence after a rejected one
      'see agent-teams config, then use agent teams to start',
      // Question mark elsewhere in the sentence
      'can you use agent teams for this? yes',
    ])('%s', input => {
      expect(hasAgentTeamsKeyword(input)).toBe(true)
    })
  })

  describe('does not trigger', () => {
    test.each([
      '',
      '   ',
      // Slash commands never keyword-match
      '/agent-teams do the thing',
      '/rename agent teams',
      // Questions about the feature (only the punctuated form is excluded —
      // an unpunctuated "agent teams是什么意思" is indistinguishable from a
      // request, same aggressive posture as the ultraplan keyword)
      'agent teams?',
      '什么是agent teams？',
      // Quoted / code content
      'read the "agent teams" doc section first',
      'grep for `agent swarm` in the docs',
      "the term 'agent swarm' means many agents",
      // Path / identifier / flag-like
      'look at src/agent-teams/foo.ts',
      'run --agent-teams-mode flag',
      'check agent_teams.py',
      'the multiagent teams approach',
      'open the file agent swarm.md',
    ])('%s', input => {
      expect(hasAgentTeamsKeyword(input)).toBe(false)
    })
  })
})
