"""Local binding and call analysis over Python's standard AST."""

import ast
from collections import Counter
from dataclasses import dataclass, replace

from lgpd_sql import sql_origin

LOG_METHODS = {"log", "info", "warn", "warning", "error", "debug", "exception"}
NETWORK_METHODS = {"post", "put", "patch", "request"}
SQL_METHODS = {"query", "execute", "executemany"}
LIST_MUTATORS = {"append", "clear", "extend", "insert", "pop", "remove", "reverse", "sort"}
DICT_MUTATORS = {"clear", "pop", "popitem", "setdefault", "update"}
MUTATION = "mutações de propriedades sem vínculo estático"
EXPANSION = "expansões de argumentos ou valores sem vínculo estático"
BRANCH = "reatribuições em fluxo condicional ou repetido"
EXPANSION_LIMIT = 4096


@dataclass(eq=False)
class Value:
    line: int | None = None
    items: list | None = None
    keys: dict | None = None
    attrs: dict | None = None
    kind: str | None = None
    unknown: bool = False
    invalidated: bool = False
    fixed_items: bool = False


UNKNOWN = Value(unknown=True)


def namespace(kind, methods):
    return Value(attrs={method: Value(kind=kind) for method in methods})


def external(name):
    if name == "print":
        return Value(kind="LOG")
    if name == "str":
        return Value(kind="STR")
    if name in {"logger", "logging", "log"}:
        result = namespace("LOG", LOG_METHODS)
        if name == "logging":
            result.attrs["getLogger"] = Value(kind="LOGGER_FACTORY")
        return result
    if name in {"requests", "httpx", "httpxClient"}:
        return namespace("NETWORK", NETWORK_METHODS)
    if name in {"db", "pool", "client", "connection", "conn", "cursor"}:
        result = namespace("SQL", SQL_METHODS)
        result.attrs["executemany"] = Value(kind="SQL_MANY")
        return result
    return Value(unknown=True, attrs={})


def item_key(node):
    if isinstance(node, ast.Constant) and type(node.value) in (str, int):
        return node.value
    if (isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub)
            and isinstance(node.operand, ast.Constant) and type(node.operand.value) is int):
        return -node.operand.value
    return None


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
        self.mutations = [{}]
        self.externals = {}
        self.module_names = set()
        self.function_depth = 0
        self.hits = {}
        self.gaps = Counter()

    def visit_Module(self, node):
        collector = LocalNames()
        collector.visit(node)
        self.module_names = collector.names
        self.generic_visit(node)

    def read(self, node):
        for binding in reversed(self.scopes):
            if node.id in binding:
                return binding[node.id]
        if self.function_depth and node.id in self.module_names:
            return UNKNOWN  # A module binding can take effect before this body is called.
        if self.field.fullmatch(node.id):
            return Value(node.lineno)
        if node.id not in self.externals:
            self.externals[node.id] = external(node.id)
        return self.externals[node.id]

    def state(self, value):
        for frame in reversed(self.mutations):
            if value in frame:
                return frame[value]
        return value

    def origin(self, value, seen=None):
        if value is None:
            return None
        if seen is None:
            seen = set()
        if value in seen:
            return None
        seen.add(value)
        current = self.state(value)
        if current.line is not None:
            return current.line
        for values in (current.items, current.keys and current.keys.values(), current.attrs and current.attrs.values()):
            if values and (source := self.first(values, seen)) is not None:
                return source
        return None

    def first(self, values, seen=None):
        if seen is None:
            seen = set()
        return next((line for value in values if (line := self.origin(value, seen)) is not None), None)

    def sequence(self, node):
        items = []
        unknown = False
        for element in node.elts:
            if not isinstance(element, ast.Starred):
                items.append(self.value(element))
                continue
            part = self.state(self.value(element.value))
            if not part or part.items is None or len(items) + len(part.items) > EXPANSION_LIMIT:
                self.gaps[EXPANSION] += 1
                unknown = True
            else:
                items.extend(part.items)
                unknown |= part.unknown
        return Value(items=items, unknown=unknown, fixed_items=isinstance(node, ast.Tuple))

    def dictionary(self, node):
        keys = {}
        unknown = False
        for key, expression in zip(node.keys, node.values):
            value = self.value(expression)
            name = item_key(key)
            if name is not None:
                keys[name] = value
                continue
            part = self.state(value)
            if key is None and part and part.keys is not None:
                if part.unknown:
                    keys.clear()
                    unknown = True
                if len(keys) + len(part.keys) <= EXPANSION_LIMIT:
                    keys.update(part.keys)
                    continue
            self.gaps[EXPANSION if key is None else "chaves de objetos sem vínculo estático"] += 1
            keys.clear()  # The missing keys may override any entry seen before this point.
            unknown = True
        return Value(keys=keys, unknown=unknown)

    def value(self, node):
        if isinstance(node, ast.Name):
            return self.read(node)
        if isinstance(node, (ast.Attribute, ast.Subscript)):
            receiver = self.state(self.value(node.value))
            attribute = isinstance(node, ast.Attribute)
            key = node.attr if attribute else item_key(node.slice)
            entries = (receiver.attrs if attribute else receiver.keys) if receiver else None
            if entries is not None and key in entries:
                return entries[key]
            if not attribute and receiver and receiver.items is not None:
                if not receiver.unknown and type(key) is int and -len(receiver.items) <= key < len(receiver.items):
                    return receiver.items[key]
            if key is None and receiver and (receiver.items is not None or receiver.keys or receiver.attrs):
                self.gaps["leituras de propriedades sem chave estática"] += 1
            if isinstance(key, str) and self.field.fullmatch(key) and receiver and receiver.unknown and not receiver.invalidated:
                return Value(node.end_lineno if attribute else node.slice.lineno)
            return UNKNOWN if receiver and receiver.unknown else None
        if isinstance(node, (ast.Tuple, ast.List)):
            return self.sequence(node)
        if isinstance(node, ast.Dict):
            return self.dictionary(node)
        if isinstance(node, ast.JoinedStr):
            return Value(self.first(self.value(item.value) for item in node.values if isinstance(item, ast.FormattedValue)))
        if isinstance(node, ast.IfExp):
            return Value(self.first(self.value(choice) for choice in (node.body, node.orelse)), unknown=True)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return Value(self.first(self.value(item) for item in (node.left, node.right)))
        if isinstance(node, ast.Call):
            callee = self.value(node.func)
            if callee and callee.kind == "STR" and node.args:
                return Value(self.origin(self.value(node.args[0])))
            if callee and callee.kind == "LOGGER_FACTORY":
                return namespace("LOG", LOG_METHODS)
            if not (callee and callee.kind) and self.argument_origin(node) is not None:
                self.gaps["resultados de chamadas indiretas com possível origem"] += 1
            return Value(unknown=True, attrs={})
        return None

    def argument_origin(self, node):
        arguments = []
        for arg in node.args:
            if not isinstance(arg, ast.Starred):
                arguments.append(self.value(arg))
                continue
            value = self.value(arg.value)
            part = self.state(value)
            if not part or part.items is None:
                self.gaps[EXPANSION] += 1
            else:
                arguments.append(value)
        for keyword in node.keywords:
            value = self.value(keyword.value)
            part = self.state(value)
            if keyword.arg is None and (not part or part.keys is None):
                self.gaps[EXPANSION] += 1
            else:
                arguments.append(value)
        return self.first(arguments)

    def mutate(self, target, value, delete=False):
        reference = self.value(target.value)
        current = self.state(reference)
        attribute = isinstance(target, ast.Attribute)
        key = target.attr if attribute else item_key(target.slice)
        if current and not attribute and current.items is not None:
            index = type(key) is int and -len(current.items) <= key < len(current.items)
            if index and not current.fixed_items and not current.unknown:
                updated = self.mutable(reference, current)
                if delete:
                    del updated.items[key]
                else:
                    updated.items[key] = value
                return
        elif current and key is not None:
            if attribute and current.attrs is not None and key not in {"__class__", "__dict__"}:
                updated = self.mutable(reference, current)
                self.write_entry(updated.attrs, key, value, delete, current.unknown)
                return
            if not attribute and (current.keys is not None or current.unknown and current.attrs is not None):
                updated = self.mutable(reference, current)
                if updated.keys is None:
                    updated.keys = {}
                self.write_entry(updated.keys, key, value, delete, current.unknown)
                return
        self.gaps[MUTATION] += 1
        if current and (current.keys is not None or current.items is not None or current.attrs is not None):
            self.invalidate(reference)

    @staticmethod
    def write_entry(entries, key, value, delete, unknown):
        if delete and not unknown:
            entries.pop(key, None)
        else:
            entries[key] = UNKNOWN if delete else value

    def invalidate(self, reference):
        self.mutations[-1][reference] = Value(unknown=True, invalidated=True, attrs={})

    def mutable(self, reference, current):
        frame = self.mutations[-1]
        if reference not in frame:
            frame[reference] = replace(current, items=None if current.items is None else current.items.copy(),
                                       keys=None if current.keys is None else current.keys.copy(),
                                       attrs=None if current.attrs is None else current.attrs.copy())
        return frame[reference]

    def bind(self, target, value):
        if isinstance(target, ast.Name):
            self.scopes[-1][target.id] = value
        elif isinstance(target, (ast.Attribute, ast.Subscript)):
            self.visit(target)
            self.mutate(target, value)
        elif isinstance(target, (ast.Tuple, ast.List)):
            self.gaps["declaradores fora do rastreamento"] += 1
            for item in target.elts:
                self.bind(item, UNKNOWN)
        elif isinstance(target, ast.Starred):
            self.bind(target.value, UNKNOWN)

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
        reference = self.value(node.target)
        current = self.state(reference)
        if current and (current.keys is not None or current.items is not None and not current.fixed_items):
            self.invalidate(reference)
            self.gaps[MUTATION] += 1
            return
        data = self.first((reference, self.value(node.value)))
        self.bind(node.target, Value(data, unknown=True) if isinstance(node.op, ast.Add) else UNKNOWN)
        if isinstance(node.target, (ast.Attribute, ast.Subscript)) or not isinstance(node.op, ast.Add):
            self.gaps["reatribuições fora do rastreamento"] += 1

    def visit_Delete(self, node):
        for target in node.targets:
            self.visit(target)
            if isinstance(target, (ast.Attribute, ast.Subscript)):
                self.mutate(target, None, delete=True)
            else:
                self.bind(target, UNKNOWN)

    def visit_Import(self, node):
        for alias in node.names:
            module = alias.name.split(".")[0]
            value = external(module) if module in {"logging", "requests", "httpx"} else UNKNOWN
            if module == "builtins":
                value = Value(attrs={name: external(name) for name in ("print", "str")})
            self.scopes[-1][alias.asname or module] = value

    def visit_ImportFrom(self, node):
        attrs = {}
        if node.level == 0:
            if node.module in {"logging", "requests", "httpx"}:
                attrs = external(node.module).attrs
            elif node.module == "builtins":
                attrs = {name: external(name) for name in ("print", "str")}
        for alias in node.names:
            if alias.name == "*":
                self.gaps["importações Python sem vínculo estático"] += 1
            else:
                self.scopes[-1][alias.asname or alias.name] = attrs.get(alias.name, UNKNOWN)

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
        locals_ = dict.fromkeys(collector.names - collector.external, UNKNOWN)
        locals_.update({arg.arg: Value(unknown=True, attrs={}) for arg in arguments if arg is not None})
        self.scopes.append(locals_)
        self.mutations.append({})
        self.function_depth += 1
        for child in body:
            self.visit(child)
        self.function_depth -= 1
        self.scopes.pop()
        self.mutations.pop()

    visit_AsyncFunctionDef = visit_Lambda = visit_FunctionDef

    def visit_ClassDef(self, node):
        # Class namespace lookup and comprehensions have separate Python scoping rules.
        self.gaps["escopos Python fora do rastreamento (classes ou compreensões)"] += 1
        self.scopes[-1][node.name] = None

    def visit_ListComp(self, node):
        self.gaps["escopos Python fora do rastreamento (classes ou compreensões)"] += 1

    visit_SetComp = visit_DictComp = visit_GeneratorExp = visit_ListComp

    def branches(self, *branches, loop_target=None):
        names, references = set(), set()
        for branch in branches:
            self.scopes.append({})
            self.mutations.append({})
            if loop_target is not None:
                self.bind(loop_target, UNKNOWN)
            for child in branch:
                self.visit(child)
            names.update(self.scopes.pop())
            references.update(self.mutations.pop())
        if names or references:
            self.gaps[BRANCH] += 1
        self.scopes[-1].update(dict.fromkeys(names, UNKNOWN))
        for reference in references:
            self.invalidate(reference)

    def visit_If(self, node):
        self.visit(node.test)
        self.branches(node.body, node.orelse)

    def visit_IfExp(self, node):
        self.visit(node.test)
        self.branches([node.body], [node.orelse])

    def visit_BoolOp(self, node):
        self.visit(node.values[0])
        self.branches(node.values[1:])

    def visit_For(self, node):
        self.visit(node.iter)
        self.branches(node.body, node.orelse, loop_target=node.target)

    visit_AsyncFor = visit_For

    visit_While = visit_If

    def visit_Try(self, node):
        self.branches(node.body, node.handlers, node.orelse, node.finalbody)

    visit_TryStar = visit_Try

    def visit_Match(self, node):
        self.visit(node.subject)
        self.branches(*([case] for case in node.cases))

    def visit_Call(self, node):
        self.visit(node.func)
        callee = self.value(node.func)
        arguments = (*node.args, *(keyword.value for keyword in node.keywords))
        for argument in arguments:
            self.visit(argument)
        if callee is None:
            if isinstance(node.func, ast.Attribute):
                reference = self.value(node.func.value)
                data = self.state(reference)
                method = node.func.attr
                if data and (data.items is not None and method in LIST_MUTATORS or
                             data.keys is not None and method in DICT_MUTATORS):
                    self.gaps[MUTATION] += 1
                    self.invalidate(reference)
            return
        kind = callee.kind
        if kind is None:
            if callee.unknown:
                if self.argument_origin(node) is not None:
                    self.gaps["chamadas com possível origem e destino sem vínculo estático"] += 1
                for argument in arguments:
                    if isinstance(argument, (ast.Name, ast.Attribute, ast.Subscript)):
                        reference = self.value(argument)
                        data = self.state(reference)
                        if data and (data.items is not None and not data.fixed_items or
                                     data.keys is not None or data.attrs):
                            self.gaps[MUTATION] += 1
                            self.invalidate(reference)
            return
        if kind in ("STR", "LOGGER_FACTORY"):
            return
        if kind == "SQL_MANY":
            self.gaps["parâmetros SQL sem vínculo estático com a escrita"] += 1
            return
        if kind == "SQL":
            query = node.args[0] if node.args else None
            command = query.value if isinstance(query, ast.Constant) and isinstance(query.value, str) else None
            values = self.state(self.value(node.args[1])) if len(node.args) > 1 else None
            parameters = {}
            if values and values.items is not None and not values.unknown:
                parameters["items"] = [self.origin(value) for value in values.items]
            if values and values.keys is not None:
                parameters["keys"] = {key: self.origin(value) for key, value in values.keys.items() if isinstance(key, str)}
            source = sql_origin(command, parameters, self.gaps)
            kind = "STORAGE"
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
