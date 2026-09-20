TIMEOUT: int = 30
NAMES = ["a"]


class Widget:
    name: str
    count: int = 0
    registry = {}
    a, b = 1, 2

    def render(self) -> str:
        local = 1
        local_annotated: int = 1

        def helper() -> int:
            return local

        return str(local) + str(helper())


def factory():
    class Inner:
        attr: str = "x"
        plain = 2

    return Inner
