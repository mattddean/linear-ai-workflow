import { ManagedRuntime } from 'effect'

import { TestRootLayer } from './layers/root'

// Shares root services across tests; the preload owns runtime initialization and disposal.

export const testRuntime = ManagedRuntime.make(TestRootLayer)
