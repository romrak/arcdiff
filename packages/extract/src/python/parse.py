"""Emit structural facts documentSymbol cannot provide. Stdlib only."""
import ast
import json
import sys


def render_param(arg, default):
    # `name`, `name: ann`, `name=default` or `name: ann = default`.
    text = arg.arg
    if arg.annotation is not None:
        text += ": " + ast.unparse(arg.annotation)
        if default is not None:
            text += " = " + ast.unparse(default)
    elif default is not None:
        text += "=" + ast.unparse(default)
    return text


def signature(node):
    a = node.args
    posonly = list(a.posonlyargs)
    regular = list(a.args)
    # `defaults` applies to the trailing N of (posonlyargs + args) combined,
    # regardless of where the `/` boundary falls.
    defaults = list(a.defaults)
    num_no_default = len(posonly) + len(regular) - len(defaults)
    pos_defaults = [None] * num_no_default + defaults

    parts = []
    for i, arg in enumerate(posonly):
        parts.append(render_param(arg, pos_defaults[i]))
    if posonly:
        parts.append("/")
    for i, arg in enumerate(regular):
        parts.append(render_param(arg, pos_defaults[len(posonly) + i]))

    if a.vararg:
        parts.append("*" + a.vararg.arg)
    elif a.kwonlyargs:
        parts.append("*")

    for arg, default in zip(a.kwonlyargs, a.kw_defaults):
        parts.append(render_param(arg, default))

    if a.kwarg:
        parts.append("**" + a.kwarg.arg)
    ret = ast.unparse(node.returns) if node.returns else None
    return "(" + ", ".join(parts) + ")" + (" -> " + ret if ret else "")


def base_position(node):
    # The name token a base expression ultimately denotes, in 0-based LSP
    # coordinates: `Mixin` in `thing.Mixin`, `Generic` in `Generic[T]`,
    # `make` in `mod.make()`. textDocument/definition must be asked about that
    # token -- asking about `thing` answers with the module, not the class.
    while True:
        if isinstance(node, ast.Subscript):
            node = node.value
        elif isinstance(node, ast.Call):
            node = node.func
        else:
            break
    end_col = getattr(node, "end_col_offset", None)
    if isinstance(node, ast.Attribute) and end_col is not None:
        # The attribute's own name is the tail of the node's source span.
        # col_offset is a UTF-8 BYTE offset, so measure the name in bytes too.
        width = len(node.attr.encode("utf-8"))
        return node.end_lineno - 1, end_col - width
    return node.lineno - 1, node.col_offset


def decorator_names(node):
    return [ast.unparse(d) for d in node.decorator_list]


def is_abstract(names):
    # Accept abstractmethod, abc.abstractmethod, and property-style stacking.
    return any(n.split("(")[0].split(".")[-1] == "abstractmethod" for n in names)


def field_entry(prefix, name, annotation, node):
    q = f"{prefix}.{name}" if prefix else name
    return {
        "qualname": q,
        "type": "field",
        "line": node.lineno,
        "endLine": getattr(node, "end_lineno", node.lineno),
        "decoratorStart": None,
        "bases": [],
        "decorators": [],
        # An annotated assignment carries its type; a bare one carries nothing,
        # so a retyped bare constant is bodyChanged and never signature-changed.
        "signature": ast.unparse(annotation) if annotation is not None else None,
        "isAbstract": False,
    }


def walk(node, prefix, out, in_function=False):
    # `in_function` tracks whether the CURRENT body is a function/method body,
    # so a field is only emitted for a module- or class-level assignment. A
    # function-local assignment (`local = 1` inside a method) is real Python
    # but never renders anywhere -- a method is a row inside its class's box,
    # not a box with its own member rows -- so recording one is pure weight
    # and, worse, a local reassigned more than once (`stmt = ...; stmt =
    # stmt.where(...)`) has no decorator to disambiguate it the way a
    # property accessor does, producing a genuine, unfixable id collision.
    # Entering a ClassDef resets the flag: a class declared inside a function
    # is a fresh scope whose own attributes are class fields, not locals.
    # Nested defs (a closure inside a method) are still walked either way --
    # only field EMISSION is suppressed inside a function.
    for child in node.body:
        if isinstance(child, ast.ClassDef):
            q = f"{prefix}.{child.name}" if prefix else child.name
            out.append({
                "qualname": q,
                "type": "class",
                "line": child.lineno,
                "endLine": getattr(child, "end_lineno", child.lineno),
                "decoratorStart": min(
                    (d.lineno for d in child.decorator_list), default=None
                ),
                "bases": [
                    {"text": ast.unparse(b), "line": base_position(b)[0],
                     "character": base_position(b)[1]}
                    for b in child.bases
                ],
                "decorators": decorator_names(child),
                "signature": None,
                "isAbstract": False,
            })
            walk(child, q, out, in_function=False)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            q = f"{prefix}.{child.name}" if prefix else child.name
            decs = decorator_names(child)
            out.append({
                "qualname": q,
                "type": "function",
                "line": child.lineno,
                "endLine": getattr(child, "end_lineno", child.lineno),
                "decoratorStart": min(
                    (d.lineno for d in child.decorator_list), default=None
                ),
                "bases": [],
                "decorators": decs,
                "signature": signature(child),
                "isAbstract": is_abstract(decs),
            })
            walk(child, q, out, in_function=True)
        elif in_function:
            continue
        elif isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
            out.append(field_entry(prefix, child.target.id, child.annotation, child))
        elif isinstance(child, ast.Assign):
            # Only plain-name targets. `a, b = ...` and `x[0] = ...` are not
            # declarations of a named member and would produce junk ids.
            for target in child.targets:
                if isinstance(target, ast.Name):
                    out.append(field_entry(prefix, target.id, None, child))


def imports_of(tree):
    out = []
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            out.append({
                "module": n.module,
                "level": n.level,
                "names": [a.name for a in n.names],
            })
        elif isinstance(n, ast.Import):
            out.append({
                "module": None,
                "level": 0,
                "names": [a.name for a in n.names],
            })
    return out


def main():
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError as exc:
        print(json.dumps({"error": f"syntax error: {exc}"}))
        sys.exit(2)
    defs = []
    walk(tree, "", defs)
    # splitlines() (not counting "\n" occurrences) so a trailing newline
    # doesn't produce a phantom extra line, matching how a diff tool counts.
    print(json.dumps({
        "defs": defs,
        "imports": imports_of(tree),
        "lineCount": len(src.splitlines()),
    }))


if __name__ == "__main__":
    main()
