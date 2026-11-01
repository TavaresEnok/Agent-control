# Durable SSH supervisor

This adapter is opt-in and does not modify existing services or users. It needs a
trusted Linux host with OpenSSH, Python 3.8+, systemd user manager 245+, a mounted
systemd cgroup hierarchy, and `sudo`. The helper runs as a dedicated supervisor
UID; the command runs as a different, unprivileged job UID. Never grant the job
UID access to the supervisor's bus, key, state directory, cgroup controller or
sudo rights. Block job access to privileged systemd/polkit operations and other
user buses. The host administrator must establish those properties and restrict
SSH access, network and resources before enabling this adapter. A compromised
supervisor account or host can forge receipts; HMAC does not defend against a
compromised supervisor.

Provision two new dedicated accounts and an isolated workspace, then generate a
new 64-hex-character random key in a private file shared only with the app's
runtime identity and the supervisor UID. As root, run `install.sh` with the two
new account names, the private key file and an absolute existing allowlisted
workspace. The installer refuses existing account names and existing per-account
state/configuration. It creates only those accounts and a private state directory;
it enables lingering for the new supervisor so its user manager survives SSH
logout. Provision a restricted SSH public key for that account separately and
verify the host fingerprint out-of-band. Keep the workspace's parent directories
root- or supervisor-owned and not writable by other users; the final directory
must be owned by root, supervisor or job and not group/other writable. Set file
ownership/permissions so the job can work there without changing its ancestors.

Configure `Rails.application.config.ac_remote_supervisor` as an
`AgentControl::SshRemoteSupervisor.new(environments: { environment_id => {
helper_path: '/opt/agent-control-lab/ssh/supervisor.py', remote_config_path:
'/etc/agent-control-lab/ssh/<supervisor>.json', secret_file: '/private/local/path' } })`.
The local secret must be a regular 0600 file owned by the application UID. The
remote secret has the same material, mode 0600 and owner supervisor UID. The
helper and wrapper must be root-owned and non-writable by either account; the
remote config must be root-owned and non-writable by group/others. Place the
config, secret and state below trusted non-writable ancestors. Rotate keys only
after reconciling all live operations; retain and protect the state directory
and terminal cache files across recovery; keep the matching signing key available
for their verification. Key rotation must preserve or explicitly migrate those
receipts before the old key is retired.

Every request and receipt is HMAC-authenticated over canonical JSON. The gateway
persists the intent before SSH; the remote helper fsyncs its own intent before
starting a deterministic unit. A repeated operation never starts a second unit.
The user-manager unit uses `Type=exec`, `KillMode=control-group` and a trusted
wrapper which waits for all processes in its cgroup to leave before it exits.
Status requires the deterministic unit, matching description and invocation ID,
the expected systemd properties, and cgroup evidence while running. Once systemd
proves a terminal result, the helper records a separate `<operation-digest>.terminal.json`
receipt in its private state directory under the existing per-operation lock. It
writes a 0600 temporary file, fsyncs it, atomically renames it and fsyncs the parent
directory before returning completion. The cache is HMAC-authenticated and binds
the operation/company/environment/task/execution/epoch, deterministic unit,
intent hash, original nonzero systemd InvocationID, terminal state and exit code.
Retries of status, cancel or dispatch return that immutable cached result without
contacting the unit, even after restarting the dedicated user manager. No retry
starts a second unit. Running and uncertain results are never cached.

Without a valid terminal cache, loss of systemd state, a missing cgroup, wrapper
error, transport failure or conflicting receipt remains uncertain; no PID alone
proves completion. An invalid, mismatched or non-private cache is rejected rather
than interpreted as completion or as permission to redispatch. A cache without
its durable intent is also rejected. Failure to persist/fsync a terminal cache
fails the request; it cannot produce an optimistic completion receipt. The helper returns
status and exit code, not captured output. Cancellation stops the control group
and requires a subsequent signed status; ambiguous cancellation stays uncertain.
Neither the helper nor its installer supplies or accesses AI-provider credentials.

The wrapper relies on the operating system maintaining exclusive, non-delegated
control of the unit cgroup. It cannot prevent a job with independent privileged
access to another service manager, host root, or cgroup control from escaping.
Do not install until those access paths are excluded and verified. Test only in a
separate empty lab directory with an `ac-probe` account and unit, and verify host
key pinning, user-manager survival after SSH disconnect, long-running descendants,
failed jobs, cancellation and reboot/receipt recovery before production use.
The pure Python tests cover authenticated/private cache persistence, immutable
terminal identities, unavailable-manager replay, failed-job replay, nonterminal
exclusion and persistence failures; they do not restart any services. Run them
with `python3 -m unittest discover -s tools/remote-supervisor/test`.
