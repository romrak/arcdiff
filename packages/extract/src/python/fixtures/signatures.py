def annotated(a: int, b: str) -> bool:
    ...


def with_default(a, b: int = 5):
    ...


def positional_only(a, b, /, c):
    ...


def variant_int(x: int):
    ...


def variant_str(x: str):
    ...
