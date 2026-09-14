import { Context, Effect, Layer, Schema } from 'effect'
import { realpath, mkdir } from 'node:fs/promises'

import type { AppError, Branch, Run } from './domain'

import { CommitSha, Path, error } from './domain'

export function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'CODEX_HOME',
    'SSH_AUTH_SOCK',
  ]
  return Object.fromEntries(allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])))
}
export const git = Effect.fn('Git.command')(function* (input: { cwd: Path; args: readonly string[] }) {
  return yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(['git', ...input.args], {
        cwd: input.cwd,
        env: childEnvironment(),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(stderr)
      return stdout.trim()
    },
    catch: () =>
      error('workspace', `Git ${input.args[0]} failed in ${input.cwd}; inspect the repository configuration`),
  })
})
export class Workspace extends Context.Tag('Workspace')<
  Workspace,
  {
    readonly inspectBase: (input: {
      repo: Path
      base: typeof Branch.Type
    }) => Effect.Effect<{ repo: Path; baseSha: CommitSha }, AppError>
    readonly prepare: (run: Run) => Effect.Effect<void, AppError>
    readonly inspect: (run: Run) => Effect.Effect<CommitSha, AppError>
  }
>() {}
export const WorkspaceLive = Layer.succeed(
  Workspace,
  Workspace.of({
    inspectBase: Effect.fn('Workspace.inspectBase')(function* (input) {
      const repo = yield* Effect.tryPromise({
        try: () => realpath(input.repo),
        catch: () => error('workspace', 'Repository path does not exist'),
      })
      const root = yield* git({ cwd: Path.make(repo), args: ['rev-parse', '--show-toplevel'] })
      const base = yield* git({
        cwd: Path.make(root),
        args: ['rev-parse', '--verify', '--end-of-options', `${input.base}^{commit}`],
      })
      return {
        repo: Path.make(root),
        baseSha: yield* Schema.decodeUnknown(CommitSha)(base).pipe(
          Effect.mapError(() => error('workspace', 'Expected a SHA-1 Git repository')),
        ),
      }
    }),
    prepare: Effect.fn('Workspace.prepare')(function* (run) {
      const exists = yield* Effect.tryPromise({
        try: () => Bun.file(`${run.worktree}/.git`).exists(),
        catch: () => error('workspace', 'Unable to inspect worktree'),
      })
      if (!exists) {
        yield* Effect.tryPromise({
          try: () => mkdir(run.worktree.substring(0, run.worktree.lastIndexOf('/')), { recursive: true }),
          catch: () => error('workspace', 'Unable to create worktree directory'),
        })
        yield* git({ cwd: run.repo, args: ['worktree', 'add', '-b', run.branch, run.worktree, run.baseSha] })
      }
      const branch = yield* git({ cwd: run.worktree, args: ['branch', '--show-current'] })
      if (branch !== run.branch) return yield* error('workspace', 'Worktree branch does not match the enrolled run')
    }),
    inspect: Effect.fn('Workspace.inspect')(function* (run) {
      const branch = yield* git({ cwd: run.worktree, args: ['branch', '--show-current'] })
      if (branch !== run.branch) return yield* error('workspace', 'Worktree branch changed')
      const dirty = yield* git({ cwd: run.worktree, args: ['status', '--porcelain', '--untracked-files=all'] })
      if (dirty)
        return yield* error(
          'blocked',
          `Worktree has uncommitted files. Reconcile ${run.worktree} without discarding work, then resume.`,
        )
      const head = yield* git({ cwd: run.worktree, args: ['rev-parse', 'HEAD'] })
      yield* git({ cwd: run.worktree, args: ['merge-base', '--is-ancestor', run.baseSha, 'HEAD'] })
      return yield* Schema.decodeUnknown(CommitSha)(head).pipe(
        Effect.mapError(() => error('workspace', 'Invalid worktree HEAD')),
      )
    }),
  }),
)
