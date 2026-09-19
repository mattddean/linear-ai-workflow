import { Effect, Layer } from 'effect'

import type { WorkerGroup } from '../domain'

import { Settings } from '../config'
import { TicketWorkflowLive } from '../ticket.workflow'
import { pollingLayer } from '../worker'
import { workerEngineLayer } from './workflow-engine'

// Aggregates domain workflow layers and registers the selected worker’s execution and polling services.

export const workflowsLayer = (group: WorkerGroup) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* Settings
      return Layer.merge(TicketWorkflowLive, pollingLayer(group)).pipe(
        Layer.provide(workerEngineLayer({ group, host: settings.runnerHost, port: settings.runnerPort })),
      )
    }),
  )

export const registerWorkflows = Effect.fn('Workflows.register')((group: WorkerGroup) =>
  Layer.build(workflowsLayer(group)).pipe(Effect.asVoid),
)
