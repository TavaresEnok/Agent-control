"""Launch a host reader with writable access only to its account and scratch."""
import ctypes
import os
import platform
import sys

CREATE, ADD, RESTRICT = 444, 445, 446
libc = ctypes.CDLL(None, use_errno=True)


def checked(result):
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return result


class Beneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('access', ctypes.c_uint64), ('parent', ctypes.c_int32)]


def main():
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        raise RuntimeError('unsupported Landlock host')
    abi = checked(libc.syscall(CREATE, None, 0, 1))
    # WRITE_FILE, REMOVE_*, MAKE_*, plus REFER and TRUNCATE.
    # ABI 3 is needed to prevent truncation of a shared project file.
    if abi < 3:
        raise RuntimeError('Landlock ABI 3 required')
    writes = (1 << 1) | sum(1 << bit for bit in range(4, 15))
    rules = checked(libc.syscall(CREATE, ctypes.byref(ctypes.c_uint64(writes)), 8, 0))
    try:
        for path, access in [(os.environ['HOME'], writes), (os.environ['TMPDIR'], writes),
                             ('/dev/null', 1 << 1)]:
            fd = os.open(path, os.O_PATH | os.O_NOFOLLOW)
            try:
                rule = Beneath(access, fd)
                checked(libc.syscall(ADD, rules, 1, ctypes.byref(rule), 0))
            finally:
                os.close(fd)
        checked(libc.prctl(38, 1, 0, 0, 0))
        checked(libc.syscall(RESTRICT, rules, 0))
    finally:
        os.close(rules)
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == '__main__':
    main()
