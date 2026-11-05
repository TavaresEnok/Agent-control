import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location('recovery_catalog', pathlib.Path(__file__).resolve().parents[1] / 'services/recovery/catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class CatalogTest(unittest.TestCase):
    def test_lease_eof_preserves_pending(self):
        with tempfile.TemporaryDirectory(prefix='ac-t30-catalog-lease-') as root:
            installation = str(uuid.uuid4())
            manifest = catalog.initialize(root, installation, [{'kind': 'native', 'id': 'fixture', 'identity': {'anchor': 'a' * 64}}])
            helper = pathlib.Path(catalog.__file__).with_name('catalog_lease.py')
            child = subprocess.Popen([sys.executable, str(helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            successor = None
            request = {'directory': root, 'installationId': installation, 'catalogId': manifest['catalogId'], 'epoch': 1,
                       'kind': 'native', 'authority': 'fixture', 'operation': 'effect', 'requestDigest': 'a' * 64}
            try:
                child.stdin.write(json.dumps(request) + '\n')
                child.stdin.flush()
                self.assertEqual(json.loads(child.stdout.readline()), {'state': 'pending'})
                code = '''import importlib.util,sys
s=importlib.util.spec_from_file_location("cat",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with m.Catalog(sys.argv[2],sys.argv[3],sys.argv[4]) as c: print(c.advance(1),flush=True)
'''
                successor = subprocess.Popen([sys.executable, '-c', code, str(pathlib.Path(catalog.__file__)), root, installation, manifest['catalogId']], stdout=subprocess.PIPE, text=True)
                time.sleep(0.1)
                self.assertIsNone(successor.poll())
                child.stdin.close()
                self.assertEqual(child.wait(timeout=5), 0)
                self.assertEqual(successor.communicate(timeout=5)[0].strip(), '2')
                with catalog.Catalog(root, installation, manifest['catalogId']) as recovered:
                    self.assertIn('effect', recovered.state()[1])
            finally:
                if successor is not None and successor.poll() is None:
                    successor.kill()
                    successor.wait(timeout=5)
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                child.stdout.close()

    def test_killed_controller_leaves_pending_and_releases_lock(self):
        with tempfile.TemporaryDirectory(prefix='ac-t30-catalog-crash-') as root:
            installation = str(uuid.uuid4())
            manifest = catalog.initialize(root, installation, [{'kind': 'ssh', 'id': 'fixture', 'identity': {'hostKey': 'fixture'}}])
            code = '''import importlib.util,sys,time
s=importlib.util.spec_from_file_location("cat",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
c=m.Catalog(sys.argv[2],sys.argv[3],sys.argv[4]);c.begin(1,"ssh","fixture","postcut","a"*64);print("READY",flush=True);time.sleep(60)
'''
            child = subprocess.Popen([sys.executable, '-c', code, str(pathlib.Path(catalog.__file__)), root, installation, manifest['catalogId']], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'READY')
                child.kill()
                child.wait(timeout=5)
                with catalog.Catalog(root, installation, manifest['catalogId']) as recovered:
                    self.assertIn('postcut', recovered.state()[1])
                    self.assertEqual(recovered.advance(1), 2)
                    with self.assertRaisesRegex(ValueError, 'CATALOG_EPOCH_FENCED'):
                        recovered.begin(1, 'ssh', 'fixture', 'late', 'b' * 64)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                child.stdout.close()

    def test_checkpoint_fence_pending_and_corruption(self):
        with tempfile.TemporaryDirectory(prefix='ac-t30-catalog-') as root:
            installation = str(uuid.uuid4())
            manifest = catalog.initialize(root, installation, [{'kind': 'native', 'id': 'fixture-native', 'identity': {'anchor': 'a' * 64}}, {'kind': 'ssh', 'id': 'fixture-ssh', 'identity': {'hostKey': 'fixture'}}])
            with catalog.Catalog(root, installation, manifest['catalogId']) as c:
                checkpoint = c.checkpoint()
                c.begin(1, 'native', 'fixture-native', 'operation-1', 'a' * 64)
                later = c.checkpoint()
                self.assertEqual(c.advance(1), 2)
                with self.assertRaisesRegex(ValueError, 'CATALOG_EPOCH_FENCED'):
                    c.begin(1, 'ssh', 'fixture-ssh', 'operation-2', 'b' * 64)
                self.assertIn('operation-1', c.state()[1])
            with catalog.Catalog(root, installation, manifest['catalogId']) as c:
                c.require_checkpoint(checkpoint)
                c.require_checkpoint(later)
                self.assertEqual(c.state()[0], 2)
                self.assertIn('operation-1', c.state()[1])
            path = pathlib.Path(root) / 'journal'
            data = path.read_bytes()
            path.write_bytes(data[:data.index(b'\n') + 1])
            with catalog.Catalog(root, installation, manifest['catalogId']) as c:
                c.require_checkpoint(later)
                with self.assertRaisesRegex(ValueError, 'CATALOG_ROLLBACK_DETECTED'):
                    c.require_checkpoint({'catalogId': manifest['catalogId'], 'installationId': installation, 'manifestHash': later['manifestHash'], 'seq': 100, 'head': later['head']})
            path.write_bytes(data[:-1])
            with self.assertRaisesRegex(ValueError, 'CATALOG_JOURNAL_TRUNCATED'):
                catalog.Catalog(root, installation, manifest['catalogId'])


if __name__ == '__main__':
    unittest.main()
