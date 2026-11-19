import {createHash} from 'node:crypto';
import {Refusal} from './contracts.ts';

export const COLLECTOR_WRAPPER_PATH = '/run/ac-collector-entrypoint';
export const COLLECTOR_CAPTURE_DIR = '/run/ac-collector-output';
// ASCII header: protocol, owner UUID, exit code, byte count, SHA-256 and LF.
export const COLLECTOR_HEADER_BYTES = 144;

function shellArg(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function collectorOutputWrapper(imageCommand: Buffer, token: string, maxStdoutBytes: number): string {
  // Inspect only Entrypoint and Cmd. Pass literal arguments and preserve their
  // order even for shell-form commands, whitespace and empty arguments.
  let command: string[];
  try {
    const config: unknown = JSON.parse(imageCommand.toString('utf8'));
    if (!Array.isArray(config) || config.length !== 2 || !config.every(part => part === null
      || (Array.isArray(part) && part.every(arg => typeof arg === 'string' && !arg.includes('\0'))))) {
      throw new Error();
    }
    const [entrypoint, cmd] = config;
    const effectiveEntrypoint = entrypoint?.length === 1 && entrypoint[0] === '' ? [] : entrypoint;
    command = [...(effectiveEntrypoint ?? []), ...(cmd ?? [])];
    if (!command[0]) throw new Error();
  } catch {
    throw new Refusal('VERIFY_TOOLS_FAILED', 503);
  }

  return `#!/bin/sh
set -- ${command.map(shellArg).join(' ')}
capture=$(mktemp -d "\${AC_COLLECTOR_CAPTURE_DIR:-/tmp}/ac-collector-output.XXXXXXXX") || exit 125
trap 'rm -rf "$capture"' EXIT
mkfifo "$capture/pipe" || exit 125
# Keep asynchronous commands' stdin equivalent to a container without -i.
(exec "$@") > "$capture/pipe" 2>/dev/null < /dev/null &
collector=$!
# Stop reading as soon as the collector exceeds the limit. Exiting this
# entrypoint also terminates the remaining processes of the container.
head -c ${maxStdoutBytes + 1} < "$capture/pipe" > "$capture/stdout" || exit 125
size=$(wc -c < "$capture/stdout") || exit 125
if [ "$size" -gt ${maxStdoutBytes} ]; then
  printf 'ac-collector-overflow %s\\n' ${shellArg(token)}
  exit 125
fi
status=0
wait "$collector" || status=$?
checksum=$(sha256sum < "$capture/stdout") || exit 125
printf 'ac-collector-v1 %s %s %s %s\\n' ${shellArg(token)} "$status" "$size" "\${checksum%% *}" || exit 125
cat "$capture/stdout" || exit 125
exit "$status"
`;
}

export function verifyCollectorOutput(bytes: Buffer, token: string, code: number, maxStdoutBytes: number): Buffer {
  const headerEnd = bytes.subarray(0, COLLECTOR_HEADER_BYTES).indexOf(0x0a);
  const invalid = () => new Refusal('VERIFY_STDOUT_INCOMPLETE', 503);
  if (headerEnd < 0) throw invalid();
  const header = bytes.subarray(0, headerEnd).toString('latin1');
  const payload = bytes.subarray(headerEnd + 1);
  if (header === `ac-collector-overflow ${token}` && code === 125 && payload.length === 0) {
    throw new Refusal('VERIFY_STDOUT_LIMIT', 400);
  }
  const fields = /^ac-collector-v1 ([a-f0-9-]{36}) (\d{1,3}) (\d{1,16}) ([a-f0-9]{64})$/.exec(header);
  if (!fields || fields[1] !== token || Number(fields[2]) !== code) throw invalid();
  if (payload.length > maxStdoutBytes) throw new Refusal('VERIFY_STDOUT_LIMIT', 400);
  if (Number(fields[3]) !== payload.length || createHash('sha256').update(payload).digest('hex') !== fields[4]) throw invalid();
  return payload;
}
