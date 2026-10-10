import { expect, test } from 'bun:test'

import { agentProgress, isolateProgress } from './agent-progress'
import { makeRun, ready } from './test/fixtures'

// Verifies that progress contains brief public updates and truthful isolate instructions, excluding tool output and final results.

const message = (text: string) =>
  JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } })

test('public commentary is shortened while reasoning, commands, malformed events, and final results stay local', () => {
  expect(agentProgress(message('Checks passed.\n\nExtra detail.'))).toEqual({
    key: 'item_1',
    message: 'Checks passed.\n\nExtra detail.',
  })
  expect(agentProgress(message('x'.repeat(1000)))?.message.length).toBeLessThanOrEqual(500)
  expect(agentProgress(message('  '))).toBeUndefined()
  expect(agentProgress(message(JSON.stringify(ready(makeRun()))))).toBeUndefined()
  expect(agentProgress('{')).toBeUndefined()
  for (const type of ['reasoning', 'command_execution', 'mcp_tool_call']) {
    expect(
      agentProgress(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type, text: 'Private output' } })),
    ).toBeUndefined()
  }
})

test('isolate milestone distinguishes headless preparation and includes the exact directory and open command', () => {
  const run = makeRun()
  const progress = isolateProgress(run)
  expect(progress.message).toContain(`Isolate ready (headless): \`${run.workspace}\``)
  expect(progress.message).toContain(`${run.repo}/.whey.jsonc`)
  expect(progress.message).toContain(`'open' '${run.id}'`)
  expect(progress.message).toContain('whey/whey.mjs')
})
