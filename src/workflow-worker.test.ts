import { expect, test } from 'bun:test'
import { Config, Effect } from 'effect'

// Verifies worker process startup and shutdown against the disposable database owned by the test preload.

test('worker process starts the cluster and shuts down cleanly against disposable Postgres', async () => {
  const databaseUrl = await Effect.runPromise(Config.string('TEST_DATABASE_URL'))
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'linear-cli-test-'))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      )
      const log = join(dir, 'worker.log')
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([process.execPath, 'src/workflow-worker.ts'], {
            cwd: import.meta.dir + '/..',
            stdout: Bun.file(log),
            stderr: Bun.file(join(dir, 'stderr.log')),
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              LINEAR_API_KEY: 'test-only',
              LINEAR_TEAM_ID: '00000000-0000-4000-8000-000000000001',
              WORKFLOW_SHARD_GROUP: 'local',
              WORKER_ID: 'test-machine',
              WORKFLOW_RUNNER_HOST: '127.0.0.1',
              WORKFLOW_RUNNER_PORT: '35672',
              ARTIFACT_ROOT: dir,
              WORKTREE_ROOT: join(dir, 'worktrees'),
            },
          }),
        ),
        (child) =>
          Effect.promise(async () => {
            child.kill('SIGINT')
            await child.exited
          }),
      )
      for (;;) {
        const output = yield* Effect.promise(() => Bun.file(log).text())
        if (output.includes('Listening on:')) break
        if (child.exitCode !== null) throw new Error(`Worker exited before becoming ready: ${child.exitCode}`)
        yield* Effect.sleep('50 millis')
      }
      child.kill('SIGINT')
      yield* Effect.promise(() => child.exited)
      expect(yield* Effect.promise(() => Bun.file(log).text())).toContain('Serving local')
    }).pipe(Effect.scoped, Effect.timeout('15 seconds')),
  )
}, 20000)
