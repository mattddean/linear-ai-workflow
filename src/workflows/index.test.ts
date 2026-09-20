import { BunServices } from '@effect/platform-bun'
import { expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'

import { Coordinator } from '../coordinator'
import { Store } from '../store'
import { TestDatabaseLive } from '../test/db'
import { fixture } from '../test/fixtures'
import { registerWorkflows } from './index'

// Exercises automatic polling through the worker's production workflow registration path.

test('registered worker picks up a ticket enrolled after startup', async () => {
  const f = fixture()
  const dependencies = f.dependencies.pipe(
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(TestDatabaseLive),
    Layer.provideMerge(BunServices.layer),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      yield* registerWorkflows('local')
      yield* Effect.sleep('1500 millis')
      yield* store.create(f.state.run)
      for (;;) {
        if ((yield* store.get(f.state.run.id)).status === 'approved') break
        yield* Effect.sleep('100 millis')
      }
      expect(f.state.calls).toBe(4)
    }).pipe(
      Effect.scoped,
      Effect.provide(Coordinator.layer.pipe(Layer.provideMerge(dependencies))),
      Effect.timeout('15 seconds'),
    ),
  )
}, 20000)
