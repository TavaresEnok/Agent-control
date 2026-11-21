/** Docker CLI calls that build their own environment keep the gateway's Docker endpoint (the filter socket, when set). */
export function dockerHostEnv(): {DOCKER_HOST?: string} {
  const host = process.env.DOCKER_HOST;
  return typeof host === 'string' && host.startsWith('unix://') ? {DOCKER_HOST: host} : {};
}

/** Called once at gateway start: AC_DOCKER_SOCKET points the API client and every Docker CLI child at the filter. */
export function useDockerFilterSocket(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const socket = environment.AC_DOCKER_SOCKET;
  if (!socket) return undefined;
  if (!socket.startsWith('/')) throw Error('AC_DOCKER_SOCKET_INVALID');
  environment.DOCKER_HOST = 'unix://' + socket;
  return socket;
}
