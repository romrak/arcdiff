from abc import ABC, abstractmethod
from acme.core import thing
from . import sibling
import os


class Greeter(ABC):
    @abstractmethod
    def hello(self, name: str) -> str:
        ...

    @abstractmethod
    async def wave(self) -> None:
        ...

    def helper(self) -> int:
        return 1


class LoudGreeter(Greeter, thing.Mixin):
    def hello(self, name: str) -> str:
        return name.upper()

    class Inner:
        pass


def top_level(a, b=2, *args, c, **kwargs) -> bool:
    return True
