import { ManagedRuntime } from 'effect'

import { RootLayer } from './layers/root'

// Shares root services within each process; the process boundary owns runtime disposal.

export const rootRuntime = ManagedRuntime.make(RootLayer)
