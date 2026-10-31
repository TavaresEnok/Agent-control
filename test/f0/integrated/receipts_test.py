"""Negative evidence tests with explicitly synthetic fixtures. No real gate claim."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("receipts", ROOT / "tools/f0/integrated/verify_receipts.py")
receipts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipts)


def synthetic_fixture():
    run, wf = "synthetic-run-for-verifier-tests-only", "synthetic-workflow"
    report = dict(status="PASS", cleanup_status="completed", gate="G0 PENDENTE", die_exit=86, healthy_exit=0, retry_exit=0, run_id=run, workflow_id=wf)
    admission = dict(permit_token="synthetic-permit", released_at=None, launch_state="claimed", launch_attempts=1, claim_token="old", claimed_at="healthy")
    dead = dict(admission=admission, session=dict(temporal_run_id=None, temporal_workflow_id=None), occupied=1, ledger=[])
    files = {"result.json": report, "scenario.json": report}
    for stage in ("granted", "after-death", "healthy", "lease-expired-by-sql", "acknowledged", "canceled-no-runtime-cleanup"):
        files[f"sql-{stage}.json"] = copy.deepcopy(dead)
    files["sql-lease-expired-by-sql.json"]["admission"]["claimed_at"] = "expired by SQL"
    for stage in ("acknowledged", "canceled-no-runtime-cleanup"):
        row = files[f"sql-{stage}.json"]
        row["admission"].update(launch_state="acknowledged", claim_token="new", launch_attempts=2)
        row["session"].update(temporal_run_id=run, temporal_workflow_id=wf)
    for stage in ("after-death", "after-retry", "canceled"):
        files[f"listing-{stage}.json"] = [dict(workflow_id=wf, run_id=run)]
        files[f"history-{stage}.json"] = [dict(eventType="EVENT_TYPE_WORKFLOW_EXECUTION_STARTED", workflowExecutionStartedEventAttributes=dict(originalExecutionRunId=run, workflowType=dict(name="integrated_idle_workflow")))]
    files["history-canceled.json"].append(dict(eventType="EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED"))
    calls = [dict(event="dispatch", mode="die", pid=1), dict(event="sdk_call", workflow_id=wf, reject_duplicate=True),
             dict(event="sdk_response", run_id=run), dict(event="death_after_service_response", run_id=run),
             dict(event="dispatch", mode="healthy", pid=2), dict(event="dispatch_returned", mode="healthy"),
             dict(event="dispatch", mode="retry", pid=3), dict(event="sdk_call", workflow_id=wf, reject_duplicate=True),
             dict(event="sdk_already_started", run_id=run)]
    return files, calls


class ReceiptRejectionTest(unittest.TestCase):
    def verify(self, mutate=None):
        files, calls = synthetic_fixture()
        if mutate:
            mutate(files, calls)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, value in files.items():
                (root / name).write_text(json.dumps(value))
            (root / "calls.jsonl").write_text("\n".join(json.dumps(c) for c in calls))
            return receipts.verify(root)

    def test_consistency_of_explicit_synthetic_control(self):
        self.assertTrue(self.verify())

    def test_invented_sql_run_id_rejected(self):
        with self.assertRaisesRegex(ValueError, "invented SQL runID"):
            self.verify(lambda f, c: f["sql-acknowledged.json"]["session"].update(temporal_run_id="invented"))

    def test_telemetry_without_history_rejected(self):
        with self.assertRaises(FileNotFoundError):
            self.verify(lambda f, c: f.pop("history-after-retry.json"))

    def test_second_server_execution_rejected(self):
        with self.assertRaisesRegex(ValueError, "multiple/different"):
            self.verify(lambda f, c: f["listing-after-retry.json"].append(dict(run_id="second")))

    def test_bypass_relay_rejected(self):
        with self.assertRaisesRegex(ValueError, "relay bypass"):
            self.verify(lambda f, c: c.pop(0))

    def test_start_during_healthy_lease_rejected(self):
        def mutate(files, calls):
            start = calls.pop(7)
            calls.insert(5, start)
        with self.assertRaisesRegex(ValueError, "healthy lease start"):
            self.verify(mutate)

    def test_early_ack_rejected(self):
        with self.assertRaisesRegex(ValueError, "ack committed"):
            self.verify(lambda f, c: f["sql-after-death.json"]["session"].update(temporal_run_id="premature"))

    def test_duplicate_receipt_from_fake_transport_rejected(self):
        with self.assertRaisesRegex(ValueError, "receipt identity mismatch"):
            self.verify(lambda f, c: c[-1].update(event="fake_transport_response"))


if __name__ == "__main__":
    unittest.main()
