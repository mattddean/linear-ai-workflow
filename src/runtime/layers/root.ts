import { BunServices } from '@effect/platform-bun'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { Agent } from '../../agent'
import { Settings } from '../../config'
import { Coordinator } from '../../coordinator'
import { DatabaseLive } from '../../db/live'
import { GraphQLClient } from '../../graphql-client'
import { Linear } from '../../linear.client'
import { Store } from '../../store'
import { Workspace } from '../../workspace'

// Composes shared process services into the application's root layer.

const BaseLayer = Layer.mergeAll(DatabaseLive, Settings.layer, BunServices.layer)
const LinearTransportLayer = Layer.unwrap(
  Effect.map(Settings, (settings) => GraphQLClient.layer('https://api.linear.app/graphql', settings.linearKey)),
).pipe(Layer.provide(Layer.merge(Settings.layer, FetchHttpClient.layer)))
const ServicesLayer = Layer.mergeAll(
  Store.layer,
  Workspace.layer,
  Linear.layer.pipe(Layer.provide(LinearTransportLayer)),
  Agent.layer,
).pipe(Layer.provideMerge(BaseLayer))
export const RootLayer = Coordinator.layer.pipe(Layer.provideMerge(ServicesLayer))
