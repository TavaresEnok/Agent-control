"""Local binding and call analysis over Python's standard AST."""

import ast
from collections import Counter, defaultdict
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
CAPTURE = "vínculos externos a funções sem ordem de chamada estática"
EXPRESSION = "expressões Python fora do rastreamento"
AUGMENTED = "reatribuições fora do rastreamento"
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
    opaque_effects: bool = False
    effects: "FunctionSummary | None" = None
    truth: bool | None = None
    bound_receiver: "Value | None" = None
    alternatives: tuple = ()


UNKNOWN = Value(unknown=True)
CAPTURED = Value(unknown=True, invalidated=True)


def scalar_operand(value):
    return value is None or value.truth is not None or (value.line is not None and not value.unknown)


def literal_truth(node):
    if isinstance(node, ast.Constant):
        return bool(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.operand, ast.Constant):
        if isinstance(node.op, ast.Not):
            return not node.operand.value
        if isinstance(node.op, (ast.UAdd, ast.USub)) and type(node.operand.value) in (int, float, complex):
            return bool(node.operand.value)
    return None


def needs_right(node, truth):
    if truth is None:
        return None
    return truth if isinstance(node.op, ast.And) else not truth


def parameter_defaults(node):
    positional = node.args.posonlyargs + node.args.args
    first_default = len(positional) - len(node.args.defaults)
    for index, expression in enumerate(node.args.defaults, first_default):
        yield positional[index].arg, index, index >= len(node.args.posonlyargs), expression
    for arg, expression in zip(node.args.kwonlyargs, node.args.kw_defaults):
        if expression is not None:
            yield arg.arg, None, True, expression


def alternatives(value, seen=None):
    seen = set() if seen is None else seen
    if value is None or value in seen:
        return
    seen.add(value)
    if value.alternatives:
        for candidate in value.alternatives:
            yield from alternatives(candidate, seen)
    else:
        yield value


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
    if name == "builtins":
        return Value(attrs={builtin: external(builtin) for builtin in ("print", "str")})
    return Value(unknown=True, attrs={})


def item_key(node):
    if isinstance(node, ast.Constant) and type(node.value) in (str, int):
        return node.value
    if (isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub)
            and isinstance(node.operand, ast.Constant) and type(node.operand.value) is int):
        return -node.operand.value
    return None


def reference_names(node):
    if isinstance(node, ast.Name):
        yield node.id
    elif isinstance(node, (ast.Attribute, ast.Subscript, ast.Starred)):
        yield from reference_names(node.value)
    elif isinstance(node, ast.IfExp):
        yield from reference_names(node.body)
        yield from reference_names(node.orelse)
    elif isinstance(node, ast.BoolOp):
        for value in node.values:
            yield from reference_names(value)


class LocalNames(ast.NodeVisitor):
    """Find lexical locals without including bindings from inner scopes."""

    def __init__(self):
        self.names = set()
        self.external = set()
        self.globals = set()
        self.receivers = set()
        self.calls = []
        self.functions = defaultdict(list)
        self.aliases = defaultdict(list)
        self.effect_writes = set()
        self.reachable = True

    def mark(self, name):
        self.names.add(name)
        if self.reachable:
            self.effect_writes.add(name)

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.mark(node.id)

    def visit_FunctionDef(self, node):
        self.mark(node.name)
        if self.reachable:
            self.functions[node.name].append(node)
        for _, _, _, expression in parameter_defaults(node):
            self.visit(expression)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.mark(node.name)

    def visit_Lambda(self, node):
        pass

    visit_ListComp = visit_SetComp = visit_DictComp = visit_GeneratorExp = visit_Lambda

    def visit_Global(self, node):
        self.globals.update(node.names)
        self.visit_Nonlocal(node)

    def visit_Nonlocal(self, node):
        self.external.update(node.names)

    def visit_Attribute(self, node):
        if self.reachable and isinstance(node.ctx, (ast.Store, ast.Del)):
            self.receivers.update(reference_names(node.value))
        self.generic_visit(node)

    visit_Subscript = visit_Attribute

    def visit_Call(self, node):
        if self.reachable:
            self.calls.append(node)
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        reachable = self.reachable
        for value in node.values:
            self.visit(value)
            if needs_right(node, literal_truth(value)) is False:
                self.reachable = False
        self.reachable = reachable

    def assignment(self, node, targets):
        for target in targets:
            if self.reachable and isinstance(target, ast.Name) and node.value is not None:
                self.aliases[target.id].append(node.value)
                if isinstance(node.value, ast.Lambda):
                    self.functions[target.id].append(node.value)
        self.generic_visit(node)

    def visit_Assign(self, node):
        self.assignment(node, node.targets)

    def visit_AnnAssign(self, node):
        self.assignment(node, (node.target,))

    visit_NamedExpr = visit_AnnAssign

    def visit_Import(self, node):
        for alias in node.names:
            self.mark(alias.asname or alias.name.split(".")[0])

    visit_ImportFrom = visit_Import

    def visit_ExceptHandler(self, node):
        if node.name is not None:
            self.mark(node.name)
        self.generic_visit(node)

    def visit_MatchAs(self, node):
        if node.name is not None:
            self.mark(node.name)
        self.generic_visit(node)

    visit_MatchStar = visit_MatchAs

    def visit_MatchMapping(self, node):
        if node.rest is not None:
            self.mark(node.rest)
        self.generic_visit(node)


@dataclass
class FunctionSummary:
    node: ast.AST
    body: list
    local: LocalNames
    bindings: dict
    owners: dict
    default_owners: dict
    defaults: dict


class Analyzer(ast.NodeVisitor):
    def __init__(self, field):
        self.field = field
        self.scopes = [{}]
        self.mutations = [{}]
        self.externals = {}
        self.modules = {}
        self.module_names = set()
        self.bodies = []
        self.captures = None
        self.function = None
        self.owners = {}
        self.summaries = {}
        self.hits = {}
        self.gaps = Counter()

    def visit(self, node):
        if isinstance(node, ast.expr):
            return self.value(node, used=False)
        return super().visit(node)

    def visit_Module(self, node):
        collector = LocalNames()
        collector.visit(node)
        self.module_names = collector.names
        self.generic_visit(node)
        # Function bodies have their own analysis state and no assumed call order.
        for function, summary, captures in self.bodies:
            self.function = function
            self.captures = captures
            self.owners = summary.owners
            self.scopes.append(summary.bindings.copy())
            self.mutations.append({})
            for child in summary.body:
                self.visit(child)
            self.scopes.pop()
            self.mutations.pop()
        self.captures = None
        self.function = None

    def read(self, node):
        scopes = self.scopes if self.captures is None else self.scopes[1:]
        for binding in reversed(scopes):
            if node.id in binding:
                return binding[node.id]
        if self.captures is not None and node.id in self.captures:
            self.gaps[CAPTURE] += 1
            return CAPTURED
        if self.field.fullmatch(node.id):
            return Value(node.lineno)
        if node.id not in self.externals:
            self.externals[node.id] = external(node.id)
        return self.externals[node.id]

    def state(self, value):
        frames = self.mutations if self.captures is None else self.mutations[1:]
        for frame in reversed(frames):
            if value in frame:
                return frame[value]
        if self.captures is not None and value in self.mutations[0]:
            self.gaps[CAPTURE] += 1
            return CAPTURED
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
        return Value(items=items, unknown=unknown, invalidated=unknown, fixed_items=isinstance(node, ast.Tuple))

    def dictionary(self, node):
        keys = {}
        unknown = False
        for key, expression in zip(node.keys, node.values):
            name = item_key(key)
            if key is not None and name is None:
                self.value(key, used=False)
            value = self.value(expression)
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
        return Value(keys=keys, unknown=unknown, invalidated=unknown)

    def value(self, node, used=True):
        truth = literal_truth(node)
        if truth is not None:
            return Value(truth=truth)
        if isinstance(node, ast.Name):
            return self.read(node)
        if isinstance(node, (ast.Attribute, ast.Subscript)):
            target = self.property_reference(node)
            return self.member_value(node, target)
        if isinstance(node, (ast.Tuple, ast.List)):
            return self.sequence(node)
        if isinstance(node, ast.Dict):
            return self.dictionary(node)
        if isinstance(node, ast.JoinedStr):
            source = None
            for item in node.values:
                if isinstance(item, ast.FormattedValue):
                    operand = self.origin(self.value(item.value))
                    spec = self.origin(self.value(item.format_spec)) if item.format_spec is not None else None
                    source = source or operand or spec
            return Value(source) if source is not None else None
        if isinstance(node, ast.IfExp):
            condition = self.value(node.test, used=False)
            if condition and condition.truth is not None:
                return self.value(node.body if condition.truth else node.orelse, used)
            yes, no = self.branches([node.body], [node.orelse],
                                    evaluate=lambda choice: self.branch_value(self.value(choice[0], used)))
            return self.join_values(yes, no)
        if isinstance(node, ast.BoolOp):
            def evaluate(index):
                left = self.value(node.values[index], used)
                if index == len(node.values) - 1:
                    return left
                needed = needs_right(node, left.truth if left else None)
                if needed is False:
                    return left
                if needed is True:
                    return evaluate(index + 1)
                before = self.branch_value(left)
                after, = self.branches(index + 1, evaluate=lambda start: self.branch_value(evaluate(start)))
                return self.join_values(before, after)

            return evaluate(0)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left = self.state(self.value(node.left))
            right = self.state(self.value(node.right))
            if scalar_operand(left) and scalar_operand(right):
                source = (left and left.line) or (right and right.line)
                return Value(source) if source is not None else None
            if used:
                self.gaps[EXPRESSION] += 1
            return CAPTURED
        if isinstance(node, ast.Call):
            return self.call(node, used)
        if isinstance(node, ast.NamedExpr):
            value = self.value(node.value)
            self.bind(node.target, value)
            return value
        if isinstance(node, ast.Lambda):
            return self.visit_FunctionDef(node)
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            self.visit_ListComp(node)
        else:
            # Keep any discovered writes conditional when the expression is outside the model.
            self.branches([node], evaluate=lambda branch: self.generic_visit(branch[0]))
            if used:
                self.gaps[EXPRESSION] += 1
        return CAPTURED

    def branch_value(self, reference):
        return reference, self.state(reference), self.origin(reference)

    def join_values(self, left, right):
        left_ref, left_state, left_origin = left
        right_ref, right_state, right_origin = right
        if left_ref is right_ref:
            return left_ref
        if any(value and value.invalidated for value in (left_state, right_state)):
            return Value(unknown=True, invalidated=True, attrs={}, alternatives=(left_ref, right_ref))
        if left_state and right_state and left_state.truth is not None and left_state.truth is right_state.truth:
            return left_ref
        if any(value and (value.items is not None or value.effects or value.kind or value.bound_receiver or
                          (not value.unknown and (value.keys is not None or value.attrs is not None)) or
                          value.keys or value.attrs)
               for value in (left_state, right_state)):
            self.gaps[EXPRESSION] += 1
            return Value(unknown=True, invalidated=True, attrs={}, alternatives=(left_ref, right_ref))
        source = left_origin or right_origin
        return Value(source) if source is not None else None

    def property_reference(self, target):
        reference = self.value(target.value)
        attribute = isinstance(target, ast.Attribute)
        if attribute:
            return reference, target.attr, attribute
        self.value(target.slice, used=False)
        return reference, item_key(target.slice), attribute

    def read_property(self, node, target):
        reference, key, attribute = target
        receiver = self.state(reference)
        entries = (receiver.attrs if attribute else receiver.keys) if receiver else None
        if entries is not None and key in entries:
            return entries[key]
        if not attribute and receiver and receiver.items is not None:
            if not receiver.unknown and type(key) is int and -len(receiver.items) <= key < len(receiver.items):
                return receiver.items[key]
        if key is None and receiver and (receiver.items is not None or receiver.keys or receiver.attrs):
            self.gaps["leituras de propriedades sem chave estática"] += 1
        if isinstance(key, str) and self.field.fullmatch(key) and receiver and receiver.unknown:
            if not receiver.invalidated:
                return Value(node.end_lineno if attribute else node.slice.lineno)
            self.gaps[EXPRESSION] += 1
        if receiver and receiver.invalidated:
            return CAPTURED
        return UNKNOWN if receiver and receiver.unknown else None

    def member_value(self, node, target):
        result = self.read_property(node, target)
        receiver, key, attribute = target
        if attribute:
            tracked = not isinstance(node.value, ast.Name) or any(node.value.id in scope for scope in self.scopes)
            if self.receiver_may_change(receiver, key, result, tracked):
                return Value(unknown=True, bound_receiver=receiver)
        return result

    def mutate(self, target, value, delete=False):
        reference, key, attribute = target
        if reference and reference.alternatives:
            seen = set()
            for alternative in reference.alternatives:
                self.invalidate_reachable(alternative, seen)
        current = self.state(reference)
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
            entries[key] = CAPTURED if delete else value

    def invalidate(self, reference):
        self.mutations[-1][reference] = Value(unknown=True, invalidated=True, attrs={})

    def mutable(self, reference, current):
        frame = self.mutations[-1]
        if reference not in frame:
            frame[reference] = replace(current, items=None if current.items is None else current.items.copy(),
                                       keys=None if current.keys is None else current.keys.copy(),
                                       attrs=None if current.attrs is None else current.attrs.copy())
        return frame[reference]

    def bind(self, target, value, property_=None):
        if isinstance(target, ast.Name):
            self.scopes[-1][target.id] = value
        elif isinstance(target, (ast.Attribute, ast.Subscript)):
            self.mutate(property_ if property_ is not None else self.property_reference(target), value)
        elif isinstance(target, (ast.Tuple, ast.List)):
            self.gaps["declaradores fora do rastreamento"] += 1
            for item in target.elts:
                self.bind(item, CAPTURED)
        elif isinstance(target, ast.Starred):
            self.bind(target.value, CAPTURED)

    def visit_Assign(self, node):
        value = self.value(node.value)
        for target in node.targets:
            self.bind(target, value)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            self.bind(node.target, self.value(node.value))

    def visit_AugAssign(self, node):
        target = node.target
        # The store uses the receiver and index resolved before evaluating the RHS.
        property_ = self.property_reference(target) if isinstance(target, (ast.Attribute, ast.Subscript)) else None
        previous = self.read_property(target, property_) if property_ is not None else self.value(target)
        left = self.state(previous)
        right = self.state(self.value(node.value))
        if isinstance(node.op, ast.Add) and scalar_operand(left) and scalar_operand(right):
            source = (left and left.line) or (right and right.line)
            value = Value(source) if source is not None else None
        else:
            self.invalidate_reachable(previous)
            self.gaps[AUGMENTED] += 1
            value = CAPTURED
        self.bind(target, value, property_)

    def visit_Delete(self, node):
        for target in node.targets:
            if isinstance(target, (ast.Attribute, ast.Subscript)):
                self.mutate(self.property_reference(target), None, delete=True)
            else:
                self.bind(target, UNKNOWN)

    def visit_Import(self, node):
        for alias in node.names:
            module = alias.name.split(".")[0]
            self.scopes[-1][alias.asname or module] = self.module(alias.name if alias.asname else module)

    def module(self, name):
        if name not in {"logging", "requests", "httpx", "builtins"}:
            return UNKNOWN
        if name not in self.modules:
            self.modules[name] = external(name)
        return self.modules[name]

    def visit_ImportFrom(self, node):
        module = self.state(self.module(node.module)) if node.level == 0 else UNKNOWN
        attrs = module.attrs or {}
        for alias in node.names:
            if alias.name == "*":
                self.gaps["importações Python sem vínculo estático"] += 1
            else:
                self.scopes[-1][alias.asname or alias.name] = attrs.get(alias.name, CAPTURED if module.invalidated else UNKNOWN)

    def visit_FunctionDef(self, node):
        for decorator in getattr(node, "decorator_list", ()):
            self.visit(decorator)
        value = self.function_summary(node, self.owners)
        defaults = {name: self.value(expression) for name, _, _, expression in parameter_defaults(node)}
        value = replace(value, effects=replace(value.effects, defaults=defaults))
        captures = self.module_names | self.owners.keys() | value.effects.local.external
        self.bodies.append((node, value.effects, captures))
        if not isinstance(node, ast.Lambda):
            self.scopes[-1][node.name] = value
        return value

    visit_AsyncFunctionDef = visit_FunctionDef

    def function_summary(self, node, parents):
        if node in self.summaries:
            return self.summaries[node]
        body = [node.body] if isinstance(node, ast.Lambda) else node.body
        collector = LocalNames()
        for child in body:
            collector.visit(child)
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs,
                     node.args.vararg, node.args.kwarg]
        locals_ = dict.fromkeys(collector.names - collector.external, CAPTURED)
        locals_.update({arg.arg: Value(unknown=True, attrs={}) for arg in arguments if arg is not None})
        owners = parents | dict.fromkeys(locals_, node) | dict.fromkeys(collector.globals)
        opaque = any(not (isinstance(child, (ast.Pass, ast.Constant)) or isinstance(child, ast.Expr) and
                          isinstance(child.value, ast.Constant)) for child in body)
        decorated = bool(getattr(node, "decorator_list", ()))
        summary = FunctionSummary(node, body, collector, locals_, owners, parents, {})
        value = Value(opaque_effects=opaque or decorated, unknown=decorated, effects=summary)
        self.summaries[node] = value
        return value

    def apply_effects(self, callees, call_node):
        visited, writes, receivers = set(), set(), set()
        contexts = {}

        def resolve(name):
            scopes = self.scopes if self.function is None else self.scopes[1:]
            for scope in reversed(scopes):
                if name in scope:
                    return scope[name], True
            if self.captures is not None and name in self.captures:
                self.gaps[CAPTURE] += 1
                return CAPTURED, False
            if name not in self.externals:
                self.externals[name] = external(name)
            return self.externals[name], False

        def visible(name, owner):
            # Module writes affect the function's global view, even when it has a local state frame.
            return self.owners.get(name) is owner and (owner is None or owner is self.function)

        # Resolve candidate references and simple member paths without replaying a body.
        def visit_root(node, owners, accept, fallback, seen=None):
            seen = set() if seen is None else seen
            if isinstance(node, ast.IfExp):
                for choice in (node.body, node.orelse):
                    visit_root(choice, owners, accept, fallback, seen)
                return
            if isinstance(node, ast.BoolOp):
                for choice in node.values:
                    needed = needs_right(node, literal_truth(choice))
                    if choice is node.values[-1] or needed is not True:
                        visit_root(choice, owners, accept, fallback, seen)
                    if needed is False:
                        break
                return
            if isinstance(node, (ast.Attribute, ast.Subscript)):
                attribute = isinstance(node, ast.Attribute)
                key = node.attr if attribute else item_key(node.slice)

                def visit_member(receiver, tracked):
                    if key is None:
                        fallback(receiver, tracked)
                    else:
                        for candidate in alternatives(receiver):
                            accept(self.member_value(node, (candidate, key, attribute)), tracked)

                visit_root(node.value, owners, visit_member, fallback, seen)
                return
            if isinstance(node, (ast.Dict, ast.List, ast.Tuple)):
                for item in node.values if isinstance(node, ast.Dict) else node.elts:
                    visit_root(item, owners, fallback, fallback, seen)
                return
            if isinstance(node, ast.Starred):
                visit_root(node.value, owners, accept, fallback, seen)
                return
            if isinstance(node, ast.Lambda):
                accept(self.function_summary(node, owners), True)
                return
            if not isinstance(node, (ast.Name, str)):
                return
            name = node if isinstance(node, str) else node.id
            owner = owners.get(name)
            if visible(name, owner):
                accept(*resolve(name))
            elif owner is not None:
                if (name, owner) in seen:
                    return
                seen.add((name, owner))
                summary = self.summaries[owner].effects
                for definition in summary.local.functions.get(name, ()):
                    accept(self.function_summary(definition, summary.owners), True)
                defaults, missing = contexts.get(owner, ({}, {}))
                if name in missing:
                    if name in defaults:
                        accept(defaults[name], True)
                    else:
                        visit_root(missing[name], summary.default_owners, accept, fallback, seen)
                for alias in summary.local.aliases.get(name, ()):
                    visit_root(alias, summary.owners, accept, fallback, seen)
                seen.remove((name, owner))

        def affect(reference, _tracked=False):
            receivers.add(reference)
            if reference and reference.bound_receiver:
                receivers.add(reference.bound_receiver)

        def collect(value, call=None):
            if not value or not value.effects:
                return
            args = call.args if call else ()
            supplied = {keyword.arg for keyword in call.keywords if keyword.arg is not None} if call else set()
            count = next((index for index, arg in enumerate(args) if isinstance(arg, ast.Starred)), len(args))
            function = value.effects.node
            missing = {name: expression for name, index, keyword, expression in parameter_defaults(function)
                       if (index is None or index >= count) and (not keyword or name not in supplied)}
            signature = value, tuple(missing)
            if signature in visited:
                return
            visited.add(signature)
            parent = contexts.get(function)
            contexts[function] = (value.effects.defaults, missing)
            local, owners = value.effects.local, value.effects.owners
            writes.update(name for name in local.effect_writes & local.external if visible(name, owners.get(name)))
            for name in sorted(local.receivers):
                visit_root(name, owners, affect, affect)
            for inner in local.calls:
                resolved, opaque = False, False

                def visit_callee(callee, _tracked=False):
                    nonlocal resolved, opaque
                    for candidate in alternatives(callee):
                        if candidate.bound_receiver:
                            affect(candidate.bound_receiver)
                        collect(candidate, inner)
                    resolved |= callee is not None
                    opaque |= bool(callee and (callee.unknown or callee.opaque_effects))

                possible_callees = set()

                def visit_opaque(reference, _tracked=False):
                    if reference is None or reference in possible_callees:
                        return
                    possible_callees.add(reference)
                    affect(reference)
                    collect(reference)
                    for alternative in reference.alternatives:
                        visit_opaque(alternative)
                    current = self.state(reference)
                    for values in (current.items, (current.keys or {}).values(), (current.attrs or {}).values()):
                        for item in values or ():
                            visit_opaque(item)

                visit_root(inner.func, owners, visit_callee, visit_opaque)
                if not resolved or opaque:
                    for arg in (*inner.args, *(keyword.value for keyword in inner.keywords)):
                        visit_root(arg, owners, visit_opaque, visit_opaque)
            if parent is None:
                contexts.pop(function)
            else:
                contexts[function] = parent

        for callee in callees:
            collect(callee, call_node)
        seen = set()
        for receiver in receivers:
            self.invalidate_reachable(receiver, seen)
        for name in sorted(writes):
            self.gaps[CAPTURE] += 1
            self.scopes[-1][name] = CAPTURED

    def visit_ClassDef(self, node):
        # Class namespace lookup and comprehensions have separate Python scoping rules.
        self.gaps["escopos Python fora do rastreamento (classes ou compreensões)"] += 1
        self.scopes[-1][node.name] = None

    def visit_ListComp(self, node):
        self.gaps["escopos Python fora do rastreamento (classes ou compreensões)"] += 1

    visit_SetComp = visit_DictComp = visit_GeneratorExp = visit_ListComp

    def branches(self, *branches, loop_target=None, evaluate=None, exhaustive=False):
        names, references = set(), set()
        values, scopes = [], []
        for branch in branches:
            self.scopes.append({})
            self.mutations.append({})
            if loop_target is not None:
                self.bind(loop_target, CAPTURED)
            if evaluate is None:
                for child in branch:
                    self.visit(child)
            else:
                values.append(evaluate(branch))
            scope = self.scopes.pop()
            scopes.append(scope)
            names.update(scope)
            references.update(self.mutations.pop())
        uncertain = bool(references)
        if not exhaustive:
            scopes.append({})
        missing = object()
        for name in sorted(names):
            start = next((scope[name] for scope in reversed(self.scopes) if name in scope), missing)
            first, *rest = (scope.get(name, start) for scope in scopes)
            agreed = first is not missing and all(candidate is first for candidate in rest)
            self.scopes[-1][name] = first if agreed else CAPTURED
            uncertain |= not agreed
        if uncertain:
            self.gaps[BRANCH] += 1
        for reference in references:
            self.invalidate(reference)
        return values

    def visit_If(self, node):
        condition = self.value(node.test, used=False)
        if condition and condition.truth is not None:
            for child in node.body if condition.truth else node.orelse:
                self.visit(child)
        else:
            self.branches(node.body, node.orelse, exhaustive=True)

    def visit_For(self, node):
        self.visit(node.iter)
        self.branches(node.body, node.orelse, loop_target=node.target)

    visit_AsyncFor = visit_For

    def visit_While(self, node):
        self.visit(node.test)
        self.branches(node.body, node.orelse)

    def visit_Try(self, node):
        self.branches(node.body, node.handlers, node.orelse, node.finalbody)

    visit_TryStar = visit_Try

    def visit_Match(self, node):
        self.visit(node.subject)
        self.branches(*([case] for case in node.cases))

    def call_argument(self, node, expand=None):
        value = self.value(node)
        if expand is None:
            return value
        current = self.state(value)
        entries = getattr(current, expand, None)
        if entries is None:
            self.gaps[EXPANSION] += 1
            return UNKNOWN
        return Value(**{expand: entries.copy()})

    def invalidate_reachable(self, reference, seen=None):
        if seen is None:
            seen = set()
        if reference in seen:
            return
        seen.add(reference)
        if reference:
            for alternative in reference.alternatives:
                self.invalidate_reachable(alternative, seen)
        data = self.state(reference)
        if data and (data.keys is not None or (data.attrs is not None and (data.attrs or not data.invalidated)) or
                     (data.items is not None and not data.fixed_items)):
            self.gaps[MUTATION] += 1
            self.invalidate(reference)
        if data:
            for values in (data.items, (data.keys or {}).values(), (data.attrs or {}).values()):
                for item in values or ():
                    self.invalidate_reachable(item, seen)

    def receiver_may_change(self, receiver, name, callee, tracked):
        if callee and not callee.unknown:
            return False
        data = self.state(receiver)
        return data and (receiver.alternatives or
                         (data.attrs is not None and (data.attrs or (tracked and not data.invalidated))) or
                         (data.items is not None and not data.fixed_items and name in LIST_MUTATORS) or
                         (data.keys is not None and name in DICT_MUTATORS))

    def call(self, node, used):
        property_ = self.property_reference(node.func) if isinstance(node.func, (ast.Attribute, ast.Subscript)) else None
        callee = self.member_value(node.func, property_) if property_ is not None else self.value(node.func)
        args = [(self.call_argument(arg.value, "items"), "items") if isinstance(arg, ast.Starred)
                else (self.call_argument(arg), None) for arg in node.args]
        keywords = [(self.call_argument(keyword.value, "keys"), "keys") if keyword.arg is None
                    else (self.call_argument(keyword.value), None) for keyword in node.keywords]
        kind = callee.kind if callee else None
        arguments = args + keywords
        source = self.first(value for value, _ in arguments)
        result = Value(unknown=True, invalidated=True, attrs={})
        if kind == "STR" and args:
            at = self.origin(args[0][0])
            result = Value(at) if at is not None else None
        elif kind == "LOGGER_FACTORY":
            result = namespace("LOG", LOG_METHODS)
        if kind is None:
            if callee and callee.unknown and source is not None:
                self.gaps["chamadas com possível origem e destino sem vínculo estático"] += 1
            uncertain = used and (source is not None or property_ is not None and self.origin(property_[0]) is not None)
            if uncertain:
                self.gaps["resultados de chamadas indiretas com possível origem"] += 1
            elif used:
                self.gaps["resultados de chamadas sem vínculo estático"] += 1
            candidates = tuple(alternatives(callee))
            affected = {candidate.bound_receiver for candidate in candidates if candidate.bound_receiver}
            methods = [candidate for candidate in candidates if candidate.effects]
            if property_ is not None:
                reference, key, attribute = property_
                if key is None or (reference and reference.alternatives):
                    for candidate in alternatives(reference):
                        receiver = self.state(candidate)
                        if key is None:
                            choices = (*(receiver.items or ()), *(receiver.keys or {}).values())
                        else:
                            choices = (self.member_value(node.func, (candidate, key, attribute)),)
                        for choice in choices:
                            if choice and choice.effects:
                                methods.append(choice)
                            if choice and choice.bound_receiver:
                                affected.add(choice.bound_receiver)
                    affected.add(reference)
            if methods:
                self.apply_effects(methods, node)
            if callee and (callee.unknown or callee.opaque_effects):
                for value, expansion in arguments:
                    if expansion == "items":
                        affected.update(value.items or ())
                    elif expansion == "keys":
                        affected.update((value.keys or {}).values())
                    else:
                        affected.add(value)
            seen = set()
            for reference in affected:
                self.invalidate_reachable(reference, seen)
            return result
        if kind in ("STR", "LOGGER_FACTORY"):
            return result
        if kind == "SQL_MANY":
            self.gaps["parâmetros SQL sem vínculo estático com a escrita"] += 1
            return result
        if kind == "SQL":
            query = node.args[0] if node.args else None
            command = query.value if isinstance(query, ast.Constant) and isinstance(query.value, str) else None
            values = self.state(args[1][0]) if len(args) > 1 and args[1][1] is None else None
            parameters = {}
            if values and values.items is not None and not values.unknown:
                parameters["items"] = [self.origin(value) for value in values.items]
            if values and values.keys is not None:
                parameters["keys"] = {key: self.origin(value) for key, value in values.keys.items() if isinstance(key, str)}
            source = sql_origin(command, parameters, self.gaps)
            kind = "STORAGE"
        if source is not None:
            self.hits.setdefault(node.lineno, {}).setdefault(kind, source)
        return result


def destinations(text, field):
    analyzer = Analyzer(field)
    try:
        analyzer.visit(ast.parse(text))
    except (SyntaxError, ValueError):
        return {}, Counter({"arquivos com sintaxe não analisável": 1})
    except RecursionError:
        return {}, Counter({"limite estrutural do parser excedido": 1})
    return analyzer.hits, analyzer.gaps
