import importlib.util
import os
import tempfile
import unittest

PATH = os.path.join(os.path.dirname(__file__), '..', 'job_wrapper.py')
spec = importlib.util.spec_from_file_location('remote_job_wrapper', PATH)
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


class CgroupTests(unittest.TestCase):
    def test_wrapper_waits_for_descendants_in_nested_cgroups(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, 'cgroup.procs'), 'w', encoding='ascii') as output:
                output.write(str(os.getpid()) + '\n')
            child = os.path.join(root, 'nested')
            os.mkdir(child)
            with open(os.path.join(child, 'cgroup.procs'), 'w', encoding='ascii') as output:
                output.write('123456\n')
            self.assertTrue(wrapper.other_processes(root))
            with open(os.path.join(child, 'cgroup.procs'), 'w', encoding='ascii'):
                pass
            self.assertFalse(wrapper.other_processes(root))

    def test_missing_wrapper_membership_is_not_a_proof_of_completion(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, 'cgroup.procs'), 'w', encoding='ascii'):
                pass
            with self.assertRaises(RuntimeError):
                wrapper.other_processes(root)


if __name__ == '__main__':
    unittest.main()
