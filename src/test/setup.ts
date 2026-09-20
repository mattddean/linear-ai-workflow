import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll } from 'bun:test'
import * as PgDrizzle from 'drizzle-orm/effect-postgres'
import { migrate } from 'drizzle-orm/effect-postgres/migrator'
import { Effect, Exit, Scope } from 'effect'

// Owns the disposable database, checked-in migrations, and shared test runtime lifecycle.

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)), 60000)

const startDatabase = Effect.fn('Test.startDatabase')(function* () {
  // Match Docker CLI context selection, including Colima, before Testcontainers connects.
  if (!process.env.DOCKER_HOST) {
    const docker = Bun.spawn(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      stdout: 'pipe',
      stderr: 'inherit',
    })
    const host = yield* Effect.promise(() => new Response(docker.stdout).text())
    if ((yield* Effect.promise(() => docker.exited)) !== 0) return yield* Effect.die('Docker must be running for tests')
    process.env.DOCKER_HOST = host.trim()
  }
  if (process.env.DOCKER_HOST.includes('/.colima/'))
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= '/var/run/docker.sock'
  const container = yield* Effect.acquireRelease(
    Effect.tryPromise(() => new PostgreSqlContainer('postgres:17-alpine').withDatabase('linear_workflow_test').start()),
    (container) => Effect.promise(() => container.stop()),
  )
  // Always replace inherited URLs and credentials; never use a configured development database.
  Object.assign(process.env, {
    TEST_DATABASE_URL: container.getConnectionUri(),
    DATABASE_URL: container.getConnectionUri(),
    LINEAR_API_KEY: 'test-only',
    LINEAR_TEAM_ID: '00000000-0000-4000-8000-000000000001',
    REPOSITORY_PATH: '/tmp/linear-workflow-test-repo',
    BASE_BRANCH: 'main',
    WORKFLOW_SHARD_GROUP: 'local',
    WORKER_ID: 'test-machine',
    WORKFLOW_RUNNER_HOST: '127.0.0.1',
    WORKFLOW_RUNNER_PORT: '34542',
    POLL_SECONDS: '1',
    ISOLATE_ROOT: '/tmp/isolates',
    ARTIFACT_ROOT: '/tmp/artifacts',
  })
  const { TestPgClientLive } = yield* Effect.promise(() => import('./pg-client'))
  yield* Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults()
    yield* migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })
  }).pipe(Effect.provide(TestPgClientLive))
})

const startTestApp = Effect.fn('Test.startApp')(function* () {
  yield* startDatabase()
  // Application modules capture env on import; migrations must finish before services start.
  const { testRuntime } = yield* Effect.promise(() => import('./runtime/root'))
  // Registered after the container so the pool closes before Postgres stops, including on startup failure.
  yield* Effect.addFinalizer(() => testRuntime.disposeEffect)
  yield* testRuntime.contextEffect
})

await Effect.runPromise(
  startTestApp().pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
  ),
)
