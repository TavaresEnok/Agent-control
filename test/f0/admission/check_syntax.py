"""Ruby grammar only. Does not stand in for Ruby, SQL or Temporal execution."""
from pathlib import Path
from tree_sitter import Language, Parser
import tree_sitter_ruby

ROOT = Path(__file__).resolve().parents[3]
parser = Parser(Language(tree_sitter_ruby.language()))
paths = sorted((ROOT / "tools/f0/admission").glob("*.rb"))
paths += sorted((ROOT / "test/f0/admission").glob("*.rb"))
paths += [ROOT / "tools/f0/admission/Gemfile"]
for path in paths:
    if parser.parse(path.read_bytes()).root_node.has_error:
        raise SystemExit(f"FAIL: Ruby grammar: {path.relative_to(ROOT)}")
print(f"PASS: Ruby grammar ({len(paths)} files); Ruby/SQL/Temporal NOT exercised")
