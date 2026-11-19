"""Local binding and call analysis over Python's standard AST."""

import ast
from collections import Counter
from dataclasses import dataclass

from lgpd_sql import sql_origin

LOG_METHODS = {"log", "info", "warn", "warning", "error", "debug", "exception"}
NETWORK_METHODS = {"post", "put", "patch", "request"}


@dataclass
class Value:
    line: int | None = None
    items: list | None = None
    keys: dict | None = None


def origin(value):
    return value.line if value else None


def first(values):
    return next((line for value in values if (line := origin(value)) is not None), None)


class LocalNames(ast.NodeVisitor):
    """Find lexical locals without including bindings from inner scopes."""

    def __init__(self):
        self.names = set()
        self.external = set()

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.names.add(node.id)

    def visit_FunctionDef(self, node):
        self.names.add(node.name)

    visit_AsyncFunctionDef = visit_ClassDef = visit_FunctionDef

    def visit_Lambda(self, node):
        pass

    visit_ListComp = visit_SetComp = visit_DictComp = visit_GeneratorExp = visit_Lambda

    def visit_Global(self, node):
        self.external.update(node.names)

    visit_Nonlocal = visit_Global

    def visit_Import(self, node):
        self.names.update(alias.asname or alias.name.split(".")[0] for alias in node.names)

    visit_ImportFrom = visit_Import

    def visit_ExceptHandler(self, node):
        if node.name is not None:
            self.names.add(node.name)
        self.generic_visit(node)

    def visit_MatchAs(self, node):
        if node.name is not None:
            self.names.add(node.name)
        self.generic_visit(node)

    visit_MatchStar = visit_MatchAs

    def visit_MatchMapping(self, node):
        if node.rest is not None:
            self.names.add(node.rest)
        self.generic_visit(node)


class Analyzer(ast.NodeVisitor):
    def __init__(self, field):
        self.field = field
        self.scopes = [{}]
        self.hits = {}
        self.gaps = Counter()

    def read(self, node):
        for binding in reversed(self.scopes):
            if node.id in binding:
                return binding[node.id]
        return Value(node.lineno) if self.field.fullmatch(node.id) else None

    def value(self, node):
        if isinstance(node, ast.Name):
            return self.read(node)
        if isinstance(node, ast.Attribute):
            key = node.attr
        elif isinstance(node, ast.Subscript):
            key = node.slice.value if isinstance(node.slice, ast.Constant) else None
        else:
            key = None
        if isinstance(key, str):
            receiver = self.value(node.value)
            if receiver and receiver.keys is not None and key in receiver.keys:
                return receiver.keys[key]
            return Value(node.lineno) if self.field.fullmatch(key) else None
        if isinstance(node, ast.Subscript) and type(key) is int:
            receiver = self.value(node.value)
            if receiver and receiver.items is not None and -len(receiver.items) <= key < len(receiver.items):
                return receiver.items[key]
        if isinstance(node, (ast.Tuple, ast.List)) and not any(isinstance(item, ast.Starred) for item in node.elts):
            items = [self.value(item) for item in node.elts]
            return Value(first(items), items=items)
        if isinstance(node, ast.Dict):
            keys = {key.value: self.value(value) for key, value in zip(node.keys, node.values)
                    if isinstance(key, ast.Constant) and isinstance(key.value, str)}
            return Value(first(keys.values()), keys=keys)
        if isinstance(node, ast.JoinedStr):
            return Value(first(self.value(item.value) for item in node.values if isinstance(item, ast.FormattedValue)))
        if isinstance(node, ast.IfExp):
            return Value(first(self.value(choice) for choice in (node.body, node.orelse)))
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return Value(first(self.value(item) for item in (node.left, node.right)))
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == "str" and node.args:
                return Value(origin(self.value(node.args[0])))
            if self.argument_origin(node) is not None:
                self.gaps["resultados de chamadas indiretas com possível origem"] += 1
        return None

    def argument_origin(self, node):
        return first(self.value(arg) for arg in (*node.args, *(kw.value for kw in node.keywords)))

    def bind(self, target, value):
        if isinstance(target, ast.Name):
            self.scopes[-1][target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            self.gaps["declaradores fora do rastreamento"] += 1
            for item in target.elts:
                self.bind(item, None)

    def visit_Assign(self, node):
        self.visit(node.value)
        value = self.value(node.value)
        for target in node.targets:
            self.bind(target, value)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            self.visit(node.value)
            self.bind(node.target, self.value(node.value))

    def visit_NamedExpr(self, node):
        self.visit(node.value)
        self.bind(node.target, self.value(node.value))

    def visit_AugAssign(self, node):
        self.visit(node.value)
        data = first(self.value(item) for item in (node.target, node.value))
        self.bind(node.target, Value(data) if isinstance(node.op, ast.Add) else None)
        if data is not None and not isinstance(node.op, ast.Add):
            self.gaps["reatribuições fora do rastreamento"] += 1

    def visit_FunctionDef(self, node):
        for decorator in getattr(node, "decorator_list", ()):
            self.visit(decorator)
        for default in (*node.args.defaults, *node.args.kw_defaults):
            if default is not None:
                self.visit(default)
        if not isinstance(node, ast.Lambda):
            self.scopes[-1][node.name] = None
        body = [node.body] if isinstance(node, ast.Lambda) else node.body
        collector = LocalNames()
        for child in body:
            collector.visit(child)
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs,
                     node.args.vararg, node.args.kwarg]
        locals_ = (collector.names - collector.external) | {arg.arg for arg in arguments if arg is not None}
        self.scopes.append(dict.fromkeys(locals_))
        for child in body:
            self.visit(child)
        self.scopes.pop()

    visit_AsyncFunctionDef = visit_Lambda = visit_FunctionDef

    def visit_ClassDef(self, node):
        # Class namespace lookup and comprehensions have separate Python scoping rules.
        self.gaps["escopos Python fora do rastreamento (classes ou compreensões)"] += 1
        self.scopes[-1][node.name] = None

    def visit_ListComp(self, node):
        self.gaps["escopos Python fora do rastreamento (classes ou compreensões)"] += 1

    visit_SetComp = visit_DictComp = visit_GeneratorExp = visit_ListComp

    def visit_For(self, node):
        self.visit(node.iter)
        self.bind(node.target, None)
        for child in (*node.body, *node.orelse):
            self.visit(child)

    visit_AsyncFor = visit_For

    def visit_Call(self, node):
        self.generic_visit(node)
        callee = node.func
        kind = None
        if isinstance(callee, ast.Name) and callee.id == "print":
            kind = "LOG"
        elif isinstance(callee, ast.Attribute):
            receiver = callee.value.id if isinstance(callee.value, ast.Name) else None
            if receiver in ("logger", "logging", "log") and callee.attr in LOG_METHODS:
                kind = "LOG"
            elif receiver in ("requests", "httpx", "httpxClient") and callee.attr in NETWORK_METHODS:
                kind = "NETWORK"
            elif callee.attr in ("query", "execute", "executemany"):
                kind = "STORAGE"
        if kind is None:
            return
        if kind == "STORAGE":
            query = node.args[0] if node.args else None
            command = query.value if isinstance(query, ast.Constant) and isinstance(query.value, str) else None
            values = self.value(node.args[1]) if len(node.args) > 1 else None
            if callee.attr == "executemany":
                self.gaps["parâmetros SQL sem vínculo estático com a escrita"] += 1
                return
            parameters = {}
            if values and values.items is not None:
                parameters["items"] = [origin(value) for value in values.items]
            if values and values.keys is not None:
                parameters["keys"] = {key: origin(value) for key, value in values.keys.items()}
            source = sql_origin(command, parameters, self.gaps)
        else:
            source = self.argument_origin(node)
        if source is not None:
            self.hits.setdefault(node.lineno, {}).setdefault(kind, source)


def destinations(text, field):
    analyzer = Analyzer(field)
    try:
        analyzer.visit(ast.parse(text))
    except (SyntaxError, ValueError):
        return {}, Counter({"arquivos com sintaxe não analisável": 1})
    except RecursionError:
        return {}, Counter({"limite estrutural do parser excedido": 1})
    return analyzer.hits, analyzer.gaps
