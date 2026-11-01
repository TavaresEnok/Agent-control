# Agent Control seccomp policy

The pinned baseline is Moby v20.10.24 `profiles/seccomp/default.json`:
https://github.com/moby/moby/blob/v20.10.24/profiles/seccomp/default.json
SHA-256 of its original bytes: ce3585b856aa4a193671fd8280d0d0612a998bd3f10bdb2f8530dfa958c6197f.

The committed policy retains the default deny and capability conditions, removes
ptrace/process_vm_* allowances, and changes only the denied clone3 fallback to
SCMP_ACT_TRACE. With no ptracer the kernel refuses that syscall with ENOSYS, so
libc can use the already-filtered clone syscall. The policy itself forbids
ptrace, the worker has no capabilities, and no host PID namespace is shared.
Do not grant SYS_PTRACE/SYS_ADMIN or attach an untrusted host tracer.
https://docs.kernel.org/userspace-api/seccomp_filter.html

On the inspected Docker 20.10.9 host, errnoRet=38 in the upstream policy still
returned EPERM and prevented Ruby threads. The committed profile was exercised
with all capabilities dropped; disabling seccomp is not its fallback. It must
remain attached to every Agent Control worker, including probes.
