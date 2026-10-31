"""Consistency check for captured lab receipts; never turns fixtures into real proof."""
import json
from pathlib import Path
import sys


def check(value, message):
    if not value:
        raise ValueError(message)


def verify(root):
    root = Path(root)

    def read(name):
        return json.loads((root / name).read_text())

    result = read("result.json")
    scenario = read("scenario.json")
    check(result["status"] == scenario["status"] == "PASS", "failed/incomplete execution")
    check(result.get("cleanup_status") == "completed", "cleanup not confirmed")
    check(result["gate"] == scenario["gate"] == "G0 PENDENTE", "scope inflated")
    check(scenario["die_exit"] == 86 and scenario["healthy_exit"] == scenario["retry_exit"] == 0, "physical fault absent")
    run_id = scenario["run_id"]
    workflow_id = scenario["workflow_id"]
    check(bool(run_id), "empty runID")
    calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
    starts = [c for c in calls if c["event"] == "sdk_call"]
    check(len(starts) == 2 and all(c["reject_duplicate"] and c["workflow_id"] == workflow_id for c in starts), "blind/extra start")
    for event in ("sdk_response", "sdk_already_started", "death_after_service_response"):
        rows = [c for c in calls if c["event"] == event]
        check(len(rows) == 1 and rows[0]["run_id"] == run_id, "receipt identity mismatch: " + event)
    dispatches = [c for c in calls if c["event"] == "dispatch"]
    check([c["mode"] for c in dispatches] == ["die", "healthy", "retry"], "relay bypass")
    check(len({c["pid"] for c in dispatches}) == 3, "relay processes not independent")
    healthy_start = next(i for i, c in enumerate(calls) if c.get("mode") == "healthy")
    retry_start = next(i for i, c in enumerate(calls) if c.get("mode") == "retry")
    check(not any(c["event"] == "sdk_call" for c in calls[healthy_start:retry_start]), "healthy lease start")
    granted = read("sql-granted.json")
    dead = read("sql-after-death.json")
    healthy = read("sql-healthy.json")
    expired = read("sql-lease-expired-by-sql.json")
    ack = read("sql-acknowledged.json")
    canceled = read("sql-canceled-no-runtime-cleanup.json")
    for row in (granted, dead, healthy, expired, ack, canceled):
        check(row["occupied"] == 1 and row["ledger"] == [], "occupancy/ledger mismatch")
        check(row["admission"]["permit_token"] == granted["admission"]["permit_token"] and bool(row["admission"]["permit_token"]), "permit changed")
        check(row["admission"]["released_at"] is None, "unproved runtime release")
    check(dead["session"]["temporal_run_id"] is None and dead["admission"]["launch_state"] == "claimed", "ack committed before death")
    check(healthy == dead, "healthy claim changed")
    before, after = dict(healthy["admission"]), dict(expired["admission"])
    check(before.pop("claimed_at") != after.pop("claimed_at") and before == after, "lease update touched other columns")
    check(ack["admission"]["launch_state"] == "acknowledged" and ack["admission"]["launch_attempts"] == 2, "retry not acknowledged")
    check(ack["admission"]["claim_token"] != dead["admission"]["claim_token"], "claim token reused")
    check(ack["session"]["temporal_run_id"] == run_id and ack["session"]["temporal_workflow_id"] == workflow_id, "invented SQL runID")
    for stage in ("after-death", "after-retry", "canceled"):
        listing = read(f"listing-{stage}.json")
        check(len(listing) == 1 and listing[0]["run_id"] == run_id and listing[0]["workflow_id"] == workflow_id, "multiple/different server execution")
        history = read(f"history-{stage}.json")
        starts = [e for e in history if e["eventType"] == "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED"]
        check(len(starts) == 1, "missing/extra server history start")
        attrs = starts[0]["workflowExecutionStartedEventAttributes"]
        check(attrs["originalExecutionRunId"] == run_id and attrs["workflowType"]["name"] == "integrated_idle_workflow", "invented runID/chain/type")
        check(not any(e["eventType"] == "EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW" for e in history), "second chain")
        if stage == "canceled":
            check(any(e["eventType"] == "EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED" for e in history), "server cancellation missing")
    return True


if __name__ == "__main__":
    try:
        verify(sys.argv[1])
    except (ValueError, KeyError, OSError, IndexError) as error:
        raise SystemExit(f"FAIL: {error}")
    print("Consistent captured receipts; provenance/review still required; G0 PENDENTE")
