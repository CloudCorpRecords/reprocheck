"""Tiny calculator used as a pytest repro fixture.

The shipped version is deliberately broken: add subtracts. A fix that
makes add actually add turns the fixture tests green.
"""


def add(a, b):
    return a - b
