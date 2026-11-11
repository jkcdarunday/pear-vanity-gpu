"""Check generated field arithmetic and every fixed-base table entry independently."""

import ctypes
import os
from pathlib import Path
import random
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
build = Path(os.environ.get("VANITY_BUILD_DIR", root / "out/addon"))
prime = 2**255 - 19
widths = [26 if i % 2 == 0 else 25 for i in range(10)]
shifts = [(i * 51 + 1) // 2 for i in range(10)]


def value(limbs):
    return sum(int(limb) << shift for limb, shift in zip(limbs, shifts)) % prime


# Compile the actual generated convolution/carry code with signed-overflow checks.
# GLSL's extended multiply is replaced only by exact host int64 multiplication;
# actual GPU instructions are covered separately by the native differential test.
field = (build / "field.glsl").read_text()
code = """
#include <cstdint>
struct Field { int v[10]; };
int64_t product(int a, int b) { return int64_t(a) * b; }
""" + field[field.index("Field reduce"):field.index("void pack")]
code += """
extern "C" void evaluate(const int *left, const int *right, int *out, int sq) {
  Field a, b;
  for (int i = 0; i < 10; i++) { a.v[i] = left[i]; b.v[i] = right[i]; }
  Field result = sq ? square(a) : mul(a, b);
  for (int i = 0; i < 10; i++) out[i] = result.v[i];
}
"""
with tempfile.TemporaryDirectory(prefix="pear-vanity-gpu-field-") as directory:
    source = Path(directory) / "field.cc"
    library = Path(directory) / "field.so"
    source.write_text(code)
    subprocess.run([
        os.environ.get("CXX", "c++"), "-shared", "-fPIC", "-O2",
        "-fsanitize=undefined", "-fno-sanitize-recover=all",
        str(source), "-o", str(library)
    ], check=True)
    native = ctypes.CDLL(str(library))
    limbs = ctypes.c_int * 10
    native.evaluate.argtypes = [ctypes.POINTER(ctypes.c_int)] * 3 + [ctypes.c_int]
    rng = random.Random(0x25519)
    bounds = [3 * (2**width - 1) for width in widths]
    cases = [[0] * 10, bounds, [-bound for bound in bounds]]
    cases += [[rng.randint(-bound, bound) for bound in bounds] for _ in range(10000)]
    for i, left in enumerate(cases):
        right = cases[-1 - i]
        for square in (0, 1):
            result = limbs()
            native.evaluate(limbs(*left), limbs(*right), result, square)
            expected = value(left) * value(left if square else right) % prime
            if value(result) != expected:
                raise AssertionError(f"Field mismatch in case {i}, square={square}")

# Affine Edwards addition provides a separate implementation from the generator's
# projective mixed-addition formulas. Check all digits, coordinates and windows.
d = -121665 * pow(121666, -1, prime) % prime


def add(p, q):
    x, y = p
    u, v = q
    product = d * x * u * y * v % prime
    return ((x * v + y * u) * pow(1 + product, -1, prime) % prime,
            (y * v + x * u) * pow(1 - product, -1, prime) % prime)


table = [int(word, 16) for word in re.findall(
    r"0x([0-9a-f]+)u", (build / "basepoint-table.h").read_text())]
if len(table) != 32 * 3 * 10 * 129:
    raise AssertionError("Unexpected table dimensions")
base = (15112221349535400772501151409588531511454012693041857206046113283949847762202,
        4 * pow(5, -1, prime) % prime)
for window in range(32):
    point = (0, 1)
    for digit in range(129):
        x, y = point
        expected = ((y - x) % prime, (y + x) % prime, 2 * d * x * y % prime)
        for coordinate in range(3):
            actual = [table[((window * 3 + coordinate) * 10 + limb) * 129 + digit]
                      for limb in range(10)]
            if any(limb >= 2**width for limb, width in zip(actual, widths)):
                raise AssertionError("Noncanonical table limb")
            if value(actual) != expected[coordinate]:
                raise AssertionError(f"Table mismatch at {window}, {digit}, {coordinate}")
        point = add(point, base)
    for _ in range(8):
        base = add(base, base)

print(f"{len(cases) * 2} field comparisons and 4128 fixed-base points passed")
