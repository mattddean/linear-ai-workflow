import {
  ClusterSchema,
  ClusterWorkflowEngine,
  RunnerAddress,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage,
  type MessageStorage,
} from '@effect/cluster'
import { BunClusterSocket } from '@effect/platform-bun'
import { WorkflowEngine } from '@effect/workflow'
import { Effect, Layer, Option } from 'effect'

import type { WorkerGroup } from './domain'

import { error } from './domain'

// Append groups only: Effect 0.54 derives Postgres advisory lock IDs from their order.
export const workerGroups = ['default', 'local'] as const

export function workflowEngineLayer(
  shardGroup: WorkerGroup,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, Sharding.Sharding | MessageStorage.MessageStorage> {
  // Scope routing to the workflow engine, including its durable timers. Cron keeps the original Sharding service.
  const routingLayer = Layer.effect(
    Sharding.Sharding,
    Effect.gen(function* () {
      const sharding = yield* Sharding.Sharding
      return Sharding.Sharding.of({
        ...sharding,
        getShardId: (entityId) => sharding.getShardId(entityId, shardGroup),
        makeClient: Effect.fn('WorkflowRouting.makeClient')((entity) =>
          sharding.makeClient(entity.annotate(ClusterSchema.ShardGroup, () => shardGroup)),
        ),
        registerEntity: Effect.fn('WorkflowRouting.registerEntity')((entity, handlers, options) =>
          sharding.registerEntity(
            entity.annotate(ClusterSchema.ShardGroup, () => shardGroup),
            handlers,
            options,
          ),
        ),
      })
    }),
  )
  const engineLayer = ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(routingLayer))

  return Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine
      const sharding = yield* Sharding.Sharding
      // Cached clients merge the caller's context; keep an outer, unconfigured Sharding from replacing our routing.
      const withRouting = Effect.provideService(Sharding.Sharding, sharding)
      return WorkflowEngine.WorkflowEngine.of({
        register: Effect.fn('WorkflowRouting.register')((workflow, execute) =>
          engine.register(workflow, execute).pipe(withRouting),
        ),
        execute: Effect.fn('WorkflowRouting.execute')((workflow, options) =>
          engine.execute(workflow, options).pipe(withRouting),
        ),
        poll: Effect.fn('WorkflowRouting.poll')((workflow, executionId) =>
          engine.poll(workflow, executionId).pipe(withRouting),
        ),
        interrupt: Effect.fn('WorkflowRouting.interrupt')((workflow, executionId) =>
          engine.interrupt(workflow, executionId).pipe(withRouting),
        ),
        resume: Effect.fn('WorkflowRouting.resume')((workflow, executionId) =>
          engine.resume(workflow, executionId).pipe(withRouting),
        ),
        activityExecute: Effect.fn('WorkflowRouting.activityExecute')((activity, attempt) =>
          engine.activityExecute(activity, attempt).pipe(withRouting),
        ),
        deferredResult: Effect.fn('WorkflowRouting.deferredResult')((deferred) =>
          engine.deferredResult(deferred).pipe(withRouting),
        ),
        deferredDone: Effect.fn('WorkflowRouting.deferredDone')((deferred, options) =>
          engine.deferredDone(deferred, options).pipe(withRouting),
        ),
        scheduleClock: Effect.fn('WorkflowRouting.scheduleClock')((workflow, options) =>
          engine.scheduleClock(workflow, options).pipe(withRouting),
        ),
      })
    }),
  ).pipe(Layer.provide(engineLayer))
}

const storage = Layer.merge(SqlMessageStorage.layer, SqlRunnerStorage.layer).pipe(
  Layer.provide(ShardingConfig.layerFromEnv({ shardGroups: workerGroups })),
)
export function workerEngineLayer(options: { group: WorkerGroup; host: string; port: number }) {
  return workflowEngineLayer(options.group).pipe(
    Layer.provideMerge(
      BunClusterSocket.layer({
        storage: 'byo',
        shardingConfig: {
          runnerAddress: Option.some(RunnerAddress.make(options.host, options.port)),
          runnerListenAddress: Option.some(RunnerAddress.make(options.host, options.port)),
          shardGroups: [options.group],
          entityMessagePollInterval: '500 millis',
        },
      }).pipe(Layer.provideMerge(storage)),
    ),
  )
}
export function clientEngineLayer(group: WorkerGroup) {
  return workflowEngineLayer(group).pipe(
    Layer.provideMerge(BunClusterSocket.layer({ clientOnly: true, storage: 'byo' }).pipe(Layer.provideMerge(storage))),
  )
}
export const ensureWorker = Effect.fn('Cluster.ensureWorker')(function* (group: WorkerGroup) {
  const runners = yield* RunnerStorage.RunnerStorage
  const rpc = yield* Runners.Runners
  const registered = yield* runners.getRunners
  const results = yield* Effect.forEach(
    registered.filter(([runner, healthy]) => healthy && runner.groups.includes(group)),
    ([runner]) =>
      rpc.ping(runner.address).pipe(
        Effect.timeout('2 seconds'),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
  )
  if (!results.some(Boolean))
    return yield* error('blocked', `No reachable ${group} worker. Start serve --worker ${group} on the owning machine.`)
})
