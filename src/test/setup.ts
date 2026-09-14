import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll } from 'bun:test'
import { Effect, Exit, Scope } from 'effect'

// Starts and cleans up the test suite’s disposable Postgres database before application layers are imported.

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
  // This repo has source schemas but no checked-in migrations. Push only into this newly owned container.
  const setup = Bun.spawn([process.execPath, 'node_modules/drizzle-kit/bin.cjs', 'push', '--force'], {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = yield* Effect.promise(() =>
    Promise.all([setup.exited, new Response(setup.stdout).text(), new Response(setup.stderr).text()]),
  )
  if (code !== 0) return yield* Effect.die(`Disposable schema setup failed: ${stdout} ${stderr}`)
})

await Effect.runPromise(
  startDatabase().pipe(
    Scope.extend(scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
  ),
)
