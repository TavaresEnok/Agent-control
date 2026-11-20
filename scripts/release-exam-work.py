"""Delete an identified, retired checkout under private directory descriptors."""
import ctypes
import errno
import fcntl
import signal
import os
import platform
import re
import stat
import sys

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
# Syscall numbers from the Linux UAPI on these two host architectures.
CREATE_RULESET, ADD_RULE, RESTRICT_SELF = 444, 445, 446
REMOVE = (1 << 4) | (1 << 5)
libc = ctypes.CDLL(None, use_errno=True)


def checked(value):
    if value < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return value


def confine_removal(directory):
    # Each layer is an intersection. Moving an opened descendant out of the
    # checkout loses the right to remove its contents even via an open fd.
    ruleset = ctypes.c_uint64(REMOVE)
    fd = checked(libc.syscall(CREATE_RULESET, ctypes.byref(ruleset), 8, 0))
    try:
        class Beneath(ctypes.Structure):
            _pack_ = 1
            _fields_ = [('allowed', ctypes.c_uint64), ('parent', ctypes.c_int32)]
        path = Beneath(REMOVE, directory)
        checked(libc.syscall(ADD_RULE, fd, 1, ctypes.byref(path), 0))
        checked(libc.syscall(RESTRICT_SELF, fd, 0))
    finally:
        os.close(fd)


def identity(fd):
    st = os.fstat(fd)
    return f'{st.st_dev}:{st.st_ino}'


def mount_id(fd):
    with open(f'/proc/self/fdinfo/{fd}', encoding='ascii') as source:
        return next(line.strip() for line in source if line.startswith('mnt_id:'))


def empty_directory(fd, mount, still_bound):
    with os.scandir(fd) as entries:
        for entry in entries:
            still_bound()
            if entry.is_dir(follow_symlinks=False):
                child = os.open(entry.name, DIR, dir_fd=fd)
                try:
                    if mount_id(child) != mount:
                        raise ValueError('Unexpected nested mount')
                    empty_directory(child, mount, still_bound)
                    os.rmdir(entry.name, dir_fd=fd)
                finally:
                    os.close(child)
            else:
                os.unlink(entry.name, dir_fd=fd)


def main():
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        raise OSError(errno.ENOTSUP, 'Unsupported host')
    checked(libc.syscall(CREATE_RULESET, None, 0, 1))
    checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
    host, job, work = 3, 4, 5
    expected_parent, job_name, expected_job, expected_work, *leaf = sys.argv[1:]
    child_name = 'work'
    if leaf:
        if len(leaf) != 1 or not re.fullmatch(r'(?:ac-[A-Za-z0-9._-]{1,120}|\.removendo-[a-f0-9-]{36})', leaf[0]):
            raise ValueError('Invalid temporary directory')
        child_name = leaf[0]
    checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0))  # PR_SET_PDEATHSIG
    if os.getppid() != int(expected_parent):
        raise ValueError('Manager exited')
    fcntl.flock(work if leaf else job, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def still_bound():
        for parent, name, expected in ((host, job_name, expected_job), (job, child_name, expected_work)):
            value = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(value.st_mode) or f'{value.st_dev}:{value.st_ino}' != expected:
                raise ValueError('Checkout moved')

    still_bound()
    if identity(job) != expected_job or identity(work) != expected_work:
        raise ValueError('Checkout changed')
    if mount_id(job) != mount_id(work):
        raise ValueError('Unexpected checkout mount')
    for parent in (host, job, work):
        confine_removal(parent)
    empty_directory(work, mount_id(work), still_bound)
    still_bound()
    print('emptied')


if __name__ == '__main__':
    main()
