// Builds the environment shared by Git and Codex child processes without inheriting coordinator credentials.

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
