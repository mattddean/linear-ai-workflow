import { FetchHttpClient } from '@effect/platform'
import { BunContext } from '@effect/platform-bun'
import { Effect, Layer, ManagedRuntime } from 'effect'

import { AgentLive } from '../../agent'
import { Settings, SettingsLive } from '../../config'
import { CoordinatorLive } from '../../coordinator'
import { DatabaseLive } from '../../db/live'
import { GraphQLClientLive } from '../../graphql-client'
import { LinearLive } from '../../linear.api'
import { StoreLive } from '../../store'
import { WorkspaceLive } from '../../workspace'

// Composes shared process services into RootLayer and the single managed rootRuntime.

const BaseLayer = Layer.mergeAll(DatabaseLive, SettingsLive, BunContext.layer)
const LinearTransportLayer = Layer.unwrapEffect(
  Effect.map(Settings, (settings) => GraphQLClientLive('https://api.linear.app/graphql', settings.linearKey)),
).pipe(Layer.provide(Layer.merge(SettingsLive, FetchHttpClient.layer)))
const ServicesLayer = Layer.mergeAll(
  StoreLive,
  WorkspaceLive,
  LinearLive.pipe(Layer.provide(LinearTransportLayer)),
  AgentLive,
).pipe(Layer.provideMerge(BaseLayer))
export const RootLayer = CoordinatorLive.pipe(Layer.provideMerge(ServicesLayer))

// Share services within each process; its boundary disposes this runtime on exit.
export const rootRuntime = ManagedRuntime.make(RootLayer)
