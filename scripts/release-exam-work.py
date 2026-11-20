"""Delete an identified, retired checkout under private directory descriptors."""
import ctypes
import errno
import os
import platform
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
    # staged tree loses the right to remove its contents even via an open fd.
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


def open_optional(name, parent):
    try:
        return os.open(name, DIR, dir_fd=parent)
    except FileNotFoundError:
        return None


def mount_id(fd):
    with open(f'/proc/self/fdinfo/{fd}', encoding='ascii') as source:
        return next(line.strip() for line in source if line.startswith('mnt_id:'))


def empty_directory(fd, mount):
    with os.scandir(fd) as entries:
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                child = os.open(entry.name, DIR, dir_fd=fd)
                try:
                    if mount_id(child) != mount:
                        raise ValueError('Unexpected nested mount')
                    empty_directory(child, mount)
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
    host, job = 3, 4
    expected_job, expected_work = sys.argv[1:]
    if identity(job) != expected_job:
        raise ValueError('Job changed')
    stage_name = '.retired-exam-work'
    try:
        os.mkdir(stage_name, 0o700, dir_fd=job)
    except FileExistsError:
        pass
    stage = os.open(stage_name, DIR, dir_fd=job)
    st = os.fstat(stage)
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700 or mount_id(stage) != mount_id(job):
        raise ValueError('Invalid staging directory')
    work = open_optional('work', job)
    parked = open_optional('work', stage)
    if work is not None:
        if parked is not None or identity(work) != expected_work:
            raise ValueError('Checkout changed')
        os.rename('work', 'work', src_dir_fd=job, dst_dir_fd=stage)
        parked = os.open('work', DIR, dir_fd=stage)
    if parked is None:
        print('absent')
        return
    if identity(parked) != expected_work:
        raise ValueError('Staged checkout changed')
    # The anchor directories are inherited from the process that checked the
    # signed result. The child can only unlink below all three of these roots.
    for parent in (host, job, stage):
        confine_removal(parent)
    # Run the recursive part with one additional layer restricting it to this
    # checkout. The parent then removes only its verified empty staging leaf.
    child = os.fork()
    if child == 0:
        try:
            confine_removal(parked)
            empty_directory(parked, mount_id(parked))
        except BaseException:
            os._exit(1)
        os._exit(0)
    if os.waitstatus_to_exitcode(os.waitpid(child, 0)[1]) != 0:
        raise OSError('Incomplete checkout retirement')
    current = os.open('work', DIR, dir_fd=stage)
    if identity(current) != expected_work:
        raise ValueError('Staged checkout changed')
    os.rmdir('work', dir_fd=stage)
    print('released')


if __name__ == '__main__':
    main()
