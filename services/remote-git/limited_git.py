#!/usr/bin/env python3
"""Run fixed Git invocations under resource limits inherited by descendants."""
import os
import resource
import sys

resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_NPROC, (1024, 1024))
os.execv('/usr/bin/git', ['/usr/bin/git', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', *sys.argv[1:]])
