import { BunContext } from '@effect/platform-bun'
import { Layer, ManagedRuntime } from 'effect'

import { AgentLive } from '../../agent'
import { SettingsLive } from '../../config'
import { CoordinatorLive } from '../../coordinator'
import { DatabaseLive } from '../../db/live'
import { LinearLive } from '../../linear'
import { StoreLive } from '../../store'
import { WorkspaceLive } from '../../workspace'

// Composes shared process services into RootLayer and the single managed rootRuntime.

const BaseLayer = Layer.mergeAll(DatabaseLive, SettingsLive, BunContext.layer)
const ServicesLayer = Layer.mergeAll(StoreLive, WorkspaceLive, LinearLive, AgentLive).pipe(
  Layer.provideMerge(BaseLayer),
)
export const RootLayer = CoordinatorLive.pipe(Layer.provideMerge(ServicesLayer))

// Share services within each process; its boundary disposes this runtime on exit.
export const rootRuntime = ManagedRuntime.make(RootLayer)
