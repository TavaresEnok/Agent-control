// Escapes values for systemd unit files (systemd.service(5), "Command lines"): arguments are split on
// whitespace unless quoted, `\` `"` are escapes inside double quotes, `%` starts a specifier and `$` an
// environment expansion. A path with a space therefore stays one argument.
const forbidden=/[\0\r\n]/;
const check=value=>{const text=String(value);if(forbidden.test(text))throw Error('SYSTEMD_VALUE_HAS_LINE_BREAK');return text;};
const escapeInside=text=>text.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%').replace(/\$/g,'$$$$');
/** One command-line argument, always double-quoted. */
export const systemdArgument=value=>`"${escapeInside(check(value))}"`;
/** `ExecStart=` value: every argument escaped, so the executable and its paths may contain spaces. */
export const systemdExecStart=argv=>{if(!argv.length)throw Error('SYSTEMD_EXEC_EMPTY');return argv.map(systemdArgument).join(' ');};
/** `Environment=` assignment, quoted as a whole: `"NAME=value"`. */
export const systemdEnvironment=(name,value)=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw Error('SYSTEMD_ENV_NAME_INVALID');return `"${escapeInside(`${name}=${check(value)}`)}"`;};
/** `WorkingDirectory=` takes one path to the end of the line: only `%` needs escaping. */
export const systemdPathValue=value=>{const text=check(value);if(!text.startsWith('/'))throw Error('SYSTEMD_PATH_NOT_ABSOLUTE');return text.replace(/%/g,'%%');};
