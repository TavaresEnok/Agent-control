"""Grammar only; never a replacement for the host Ruby/OpenSSH gate."""
from pathlib import Path
from tree_sitter import Language, Parser
import tree_sitter_ruby

ROOT = Path(__file__).resolve().parents[3]
parser = Parser(Language(tree_sitter_ruby.language()))
paths = list((ROOT / "tools/f0/ssh").glob("*.rb"))
paths += list((ROOT / "test/f0/ssh").glob("*.rb"))
paths += [ROOT / "app/services/coder/ssh_runner.rb",
          ROOT / "app/services/agent_control/open_ssh_transport.rb",
          ROOT / "test/services/coder/ssh_runner_test.rb",
          ROOT / "test/services/agent_control/open_ssh_transport_test.rb"]
for path in paths:
    if parser.parse(path.read_bytes()).root_node.has_error:
        raise SystemExit(f"FAIL Ruby grammar: {path.relative_to(ROOT)}")
print(f"PASS Ruby grammar ({len(paths)} files); Ruby/OpenSSH NOT RUN")
