import abc


@dataclass
@final
class Widget:
    x: int

    @property
    def size(self) -> int:
        return self.x


class Plain:
    pass
