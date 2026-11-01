"""Grammar check only; never represents Ruby execution or Temporal evidence.

Install tree-sitter and tree-sitter-ruby in the worktree as documented.
"""
from pathlib import Path
from tree_sitter import Language, Parser
import tree_sitter_ruby

ROOT = Path(__file__).resolve().parents[3]
parser = Parser(Language(tree_sitter_ruby.language()))
files = sorted((ROOT / "tools/f0/temporal").glob("*.rb"))
files += sorted((ROOT / "tools/f0/temporal/tests").glob("*.rb"))
files += [ROOT / "tools/f0/temporal/Gemfile"]
for path in files:
    tree = parser.parse(path.read_bytes())
    if tree.root_node.has_error:
        raise SystemExit(f"FAIL: Ruby grammar: {path.relative_to(ROOT)}")
print(f"PASS: Ruby grammar ({len(files)} files); Ruby runtime and Temporal NOT exercised")
