"""Identify the bound values stored by a small, explicit subset of literal SQL."""

import re

UNMEASURED_SQL = "chamadas SQL sem comando literal analisável"
UNMEASURED_SHAPE = "comandos SQL fora do recorte de escrita"
UNMEASURED_PARAMETERS = "parâmetros SQL sem vínculo estático com a escrita"

TOKEN = re.compile(
    r"(?P<trivia>\s+|--[^\r\n]*|/\*.*?\*/)"
    r"|(?P<quoted>'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`(?:``|[^`])*`|\[(?:[^\]])*\])"
    r"|(?P<dollar_quote>(?P<tag>\$(?:[a-zA-Z_]\w*)?\$).*?(?P=tag))"
    r"|(?P<parameter>\$[1-9]\d*|\?\d*|:[a-zA-Z_]\w*|@[a-zA-Z_]\w*|%s|%\([a-zA-Z_]\w*\)s)"
    r"|(?P<word>[a-zA-Z_]\w*)|(?P<other>::|[^\s])",
    re.DOTALL,
)
IDENTIFIER = re.compile(r"[A-Z_][A-Z_0-9]*", re.ASCII)
UPDATE_END = {"WHERE", "RETURNING", "ORDER", "LIMIT", "FROM"}
INSERT_END = {"RETURNING", "ON"}
READ_ONLY = {"SELECT", "VALUES", "SHOW"}
EXPLAIN_STATEMENTS = {"SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "EXECUTE",
                      "DECLARE", "CREATE", "WITH"}
EXPLAIN_BOOLS = {"ANALYZE", "VERBOSE", "COSTS", "SETTINGS", "GENERIC_PLAN", "BUFFERS",
                 "WAL", "TIMING", "SUMMARY", "MEMORY", "IO"}


class Unmeasured(ValueError):
    pass


def tokens(command):
    result = []
    styles = set()
    next_parameter = 0
    for token in TOKEN.finditer(command):
        value = token.group()
        if token.lastgroup == "trivia":
            if value.startswith("/*") and "/*" in value[2:]:
                raise Unmeasured
            continue
        if token.lastgroup == "parameter":
            if value in ("?", "%s"):
                styles.add(value)
                index = next_parameter
                next_parameter += 1
            elif value[:1] in ("$", "?"):
                styles.add(value[0])
                if len(value) > 7:
                    raise Unmeasured
                index = int(value[1:]) - 1
                if index < 0:
                    raise Unmeasured
                next_parameter = max(next_parameter, index + 1)
            else:
                styles.add(value[0])
                index = value[2:-2] if value.startswith("%(") else value[1:]
            result.append((index,))
        elif token.lastgroup == "word":
            result.append(value.upper())
        elif token.lastgroup in ("quoted", "dollar_quote"):
            # One opaque token for a string or quoted identifier.
            if value.startswith("'") and "\\" in value:
                raise Unmeasured  # Backslash string semantics vary by driver and SQL mode.
            result.append(value if value[:1] in ('"', '`', '[') else "<literal>")
        elif value in ("'", '"', "`", "[", "$") or command.startswith("/*", token.start()):
            raise Unmeasured
        else:
            result.append(value)
    if len(styles) > 1:
        raise Unmeasured
    if result[-1:] == [";"]:
        result.pop()
    if not result or ";" in result:
        raise Unmeasured
    return result


def segments(parts, stops):
    """Split on top-level delimiters, keeping balanced groups opaque."""
    depth = start = 0
    for position, token in enumerate(parts):
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
            if depth < 0:
                raise Unmeasured
        elif depth == 0 and token in stops:
            yield parts[start:position], position
            start = position + 1
    if depth:
        raise Unmeasured
    yield parts[start:], len(parts)


def group(parts):
    if parts[:1] != ["("]:
        raise Unmeasured
    depth = 0
    for position, token in enumerate(parts):
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
            if depth == 0:
                return parts[1:position], parts[position + 1:]
    raise Unmeasured


def parameters(parts):
    return {part[0] for part in parts if isinstance(part, tuple)}


def stored_parameter(expression):
    if len(expression) == 1 and isinstance(expression[0], tuple):
        return expression[0][0]
    if parameters(expression):
        raise Unmeasured
    return None


def table_token(token):
    return isinstance(token, str) and (IDENTIFIER.fullmatch(token) or token.startswith(('"', '`', '[')))


def after_table(parts):
    position = 0
    while position < len(parts) and table_token(parts[position]):
        position += 1
        if parts[position:position + 1] != ["."]:
            return parts[position:]
        position += 1
    raise Unmeasured


def values_rows(parts):
    for row, _ in segments(parts, {","}):
        columns, rest = group(row)
        if rest:
            raise Unmeasured
        yield [expression for expression, _ in segments(columns, {","})]


def cte(parts):
    # WITH source(col, ...) AS (VALUES (...), ...) followed by the main statement.
    if len(parts) < 4 or not isinstance(parts[1], str) or not IDENTIFIER.fullmatch(parts[1]):
        raise Unmeasured
    columns, rest = group(parts[2:])
    if rest[:1] != ["AS"]:
        raise Unmeasured
    names = [column[0] for column, _ in segments(columns, {","})
             if len(column) == 1 and isinstance(column[0], str) and IDENTIFIER.fullmatch(column[0])]
    if len(names) != columns.count(",") + 1 or len(set(names)) != len(names):
        raise Unmeasured
    query, rest = group(rest[1:])
    if query[:1] != ["VALUES"] or not rest:
        raise Unmeasured
    rows = list(values_rows(query[1:]))
    if any(len(row) != len(names) for row in rows):
        raise Unmeasured
    return rest, parts[1], {name: [row[index] for row in rows] for index, name in enumerate(names)}


def explain(parts):
    execute = False
    if parts[:1] == ["("]:
        options, parts = group(parts)
        seen = set()
        for option, _ in segments(options, {","}):
            if not option:
                raise Unmeasured
            name, *value = option
            if name == "ANALYSE":
                name = "ANALYZE"
            if name in seen:
                raise Unmeasured
            seen.add(name)
            if name in EXPLAIN_BOOLS:
                if value and (len(value) != 1 or value[0] not in {"TRUE", "ON", "1", "FALSE", "OFF", "0"}):
                    raise Unmeasured
                if name == "ANALYZE":
                    execute = not value or value[0] in {"TRUE", "ON", "1"}
            elif name == "FORMAT" and len(value) == 1 and value[0] in {"TEXT", "XML", "JSON", "YAML"}:
                continue
            elif name == "SERIALIZE" and (not value or (len(value) == 1 and value[0] in {"NONE", "TEXT", "BINARY"})):
                continue
            else:
                raise Unmeasured
    else:
        if parts and parts[0] in {"ANALYZE", "ANALYSE"}:
            execute = True
            parts = parts[1:]
        if parts[:1] == ["VERBOSE"]:
            parts = parts[1:]
    if not parts or parts[0] not in EXPLAIN_STATEMENTS:
        raise Unmeasured
    return parts if execute else None


def stored_parameters(command):
    statement = tokens(command)
    if statement[0] == "EXPLAIN":
        statement = explain(statement[1:])
        if statement is None:
            return set()
    name = columns = None
    if statement[:1] == ["WITH"]:
        statement, name, columns = cte(statement)
    start = statement[0]
    if start in READ_ONLY:
        return set()
    if start == "INSERT" and statement[1:2] == ["INTO"]:
        tail = after_table(statement[2:])
        if tail[:1] == ["("]:
            target_columns, tail = group(tail)
            for column, _ in segments(target_columns, {","}):
                if len(column) != 1 or not table_token(column[0]):
                    raise Unmeasured
        if not tail:
            raise Unmeasured
        mode, *tail = tail
        body, end = next(segments(tail, INSERT_END))
        if tail[end:end + 1] == ["ON"]:
            raise Unmeasured  # Includes ON CONFLICT assignments and predicates.
        if mode == "VALUES":
            expressions = (value for row in values_rows(body) for value in row)
        elif mode == "DEFAULT" and body == ["VALUES"]:
            return set()
        elif mode == "SELECT":
            projection, end = next(segments(body, {"FROM", "WHERE", "GROUP", "ORDER", "LIMIT", "UNION"}))
            suffix = body[end:]
            projected = [value for value, _ in segments(projection, {","})]
            if name is not None and suffix == ["FROM", name]:
                if any(len(value) != 1 or value[0] not in columns for value in projected):
                    raise Unmeasured
                expressions = (value for column in projected for value in columns[column[0]])
            elif not suffix and name is None:
                expressions = iter(projected)
            else:
                raise Unmeasured
        else:
            raise Unmeasured
    elif start == "UPDATE":
        tail = after_table(statement[1:])
        if tail[:1] != ["SET"]:
            raise Unmeasured
        tail = tail[1:]
        body, end = next(segments(tail, UPDATE_END))
        if tail[end:end + 1] == ["FROM"]:
            raise Unmeasured
        assignments = [assignment for assignment, _ in segments(body, {","})]
        if any(len(assignment) < 3 or not table_token(assignment[0]) or assignment[1] != "="
               for assignment in assignments):
            raise Unmeasured
        expressions = (assignment[2:] for assignment in assignments)
    else:
        raise Unmeasured
    return {index for value in expressions if (index := stored_parameter(value)) is not None}


def sql_origin(command, arguments, gaps):
    if command is None:
        gaps[UNMEASURED_SQL] += 1
        return None
    try:
        positions = stored_parameters(command)
    except Unmeasured:
        gaps[UNMEASURED_SHAPE] += 1
        return None
    if not positions:
        return None
    if not arguments:
        gaps[UNMEASURED_PARAMETERS] += 1
        return None
    items = arguments.get("items", [])
    keys = arguments.get("keys", {})
    lines = []
    missing = False
    for position in positions:
        if isinstance(position, int) and position < len(items):
            lines.append(items[position])
        elif isinstance(position, str) and position in keys:
            lines.append(keys[position])
        else:
            missing = True
    if missing:
        gaps[UNMEASURED_PARAMETERS] += 1
    return min((line for line in lines if line is not None), default=None)
