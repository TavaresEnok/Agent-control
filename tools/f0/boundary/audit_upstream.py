"""Fetch public source at the fixed hash; never inspect installed credentials.

Print hashes and numbered security-relevant lines, not a claim of runtime safety.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import urllib.request

COMMIT = "e6ec5a286120aed3a036d85871e796b2f6c97d70"
FILES = [
    "app/controllers/application_controller.rb",
    "app/controllers/concerns/auth_concern.rb",
    "app/controllers/api/v1/terminal_sessions_controller.rb",
    "app/controllers/api/v1/internal/ws_auth_controller.rb",
    "app/channels/application_cable/connection.rb",
    "app/controllers/mcp_controller.rb",
    "app/models/agent_credential.rb",
    "app/services/agents/codex_adapter.rb",
    "docker/base/logger/start-mitm.sh",
    "docker/base/logger/mitm_logger.py",
    "docker/base/logger/refresh_broker.py",
    "config/routes/mcp.rb",
    "config/routes.rb",
    "app/controllers/api/v1/application_controller.rb",
    "app/controllers/web/application_controller.rb",
    "docker/traefik/dynamic.yml",
    "app/services/container_strategies/agent_base_strategy.rb",
    "docker/base/entrypoint.sh",
]
PATTERN = re.compile(r"authenticate|before_action|reject_unauthorized|session_key|mcp_key|bearer|uniqueness|MITM_DISABLED|PROXY|listen|forward_auth|forwardAuth|reverse_proxy|--yolo|API_KEY|auth\.json|TRACKED_DOMAINS|authorization|requestheaders|responseheaders|ttyd|middlewares|loadbalancer|network|privileged|enforce_workspace", re.I)


def fetch(path):
    url = f"https://raw.githubusercontent.com/AixleHQ/flow/{COMMIT}/{path}"
    try:
        with urllib.request.urlopen(url, timeout=25) as response:
            data = response.read()
        local = Path(__file__).resolve().parents[3] / path
        return {"path": path, "url": url, "sha256": hashlib.sha256(data).hexdigest(),
                "worktree_matches_fixed_source": local.exists() and local.read_bytes() == data,
                "lines": [f"{n}: {line}" for n, line in enumerate(data.decode().splitlines(), 1)
                          if PATTERN.search(line)]}
    except Exception as error:
        return {"path": path, "status": "NOT RUN", "cause": str(error)}


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        print(json.dumps({"commit": COMMIT, "classification": "static public source only",
                          "files": list(pool.map(fetch, FILES))}, indent=2))
