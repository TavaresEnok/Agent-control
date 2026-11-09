"""A worker-written .git/config must never run on the remote host during a snapshot."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent / 'services' / 'remote-git'
spec = importlib.util.spec_from_file_location('workspace_helper_under_test', ROOT / 'workspace_helper.py')
workspace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workspace)


def git(repo, *args):
    subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)


class IsolatedSnapshotGit(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = pathlib.Path(self.temp.name) / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init', '-q')
        git(self.repo, 'config', 'user.email', 'fixture@invalid')
        git(self.repo, 'config', 'user.name', 'Fixture')
        (self.repo / 'a.txt').write_text('a\n')
        (self.repo / '.gitattributes').write_text('a.txt filter=evil\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'base')
        self.marker = pathlib.Path(self.temp.name) / 'executed'
        hook = self.repo / '.git' / 'x'
        hook.write_text(f'#!/bin/sh\ntouch {self.marker}\ncat\n')
        hook.chmod(0o755)
        (self.repo / 'a.txt').write_text('a\n')
        git(self.repo, 'config', 'core.fsmonitor', str(hook))
        git(self.repo, 'config', 'filter.evil.clean', str(hook))

    def tearDown(self):
        self.temp.cleanup()

    def test_fsmonitor_and_filter_do_not_execute(self):
        import os
        os.utime(self.repo / 'a.txt', (1, 1))
        with workspace._helper.isolated_git(self.repo):
            workspace.run(self.repo, ['diff', '--name-only', 'HEAD'])
            head = workspace.run(self.repo, ['rev-parse', 'HEAD'])
        self.assertEqual(len(head), 40)
        self.assertFalse(self.marker.exists())

    def test_alternates_are_refused(self):
        (self.repo / '.git' / 'objects' / 'info' / 'alternates').write_text('/tmp\n')
        with self.assertRaisesRegex(ValueError, 'WORKSPACE_GIT_UNSAFE'):
            with workspace._helper.isolated_git(self.repo):
                pass

    def test_symlinked_git_dir_is_refused(self):
        git_dir = self.repo / '.git'
        moved = pathlib.Path(self.temp.name) / 'moved'
        git_dir.rename(moved)
        git_dir.symlink_to(moved)
        with self.assertRaisesRegex(ValueError, 'WORKSPACE_GIT_UNSAFE'):
            with workspace._helper.isolated_git(self.repo):
                pass

    def test_fifo_config_is_refused_without_blocking(self):
        import os
        config = self.repo / '.git' / 'config'
        config.unlink()
        os.mkfifo(config)
        with self.assertRaisesRegex(ValueError, 'WORKSPACE_GIT_UNSAFE'):
            with workspace._helper.isolated_git(self.repo):
                pass


if __name__ == '__main__':
    unittest.main()
