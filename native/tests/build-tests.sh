#!/usr/bin/env bash
# Builds and runs the virtual ASIO ring-protocol tests. No JUCE, no Windows, no
# audio device: the shared-memory protocol between the driver DLL and Tone Art
# Studio is a plain header, so its maths is checkable on any machine with a C++20
# compiler. What this cannot check is audio reaching a real ASIO host - that
# needs Windows and a second application.
set -euo pipefail

cd "$(dirname "$0")"

CXX="${CXX:-c++}"
OUT="${TMPDIR:-/tmp}/hybrid-asio-ring-tests"

"$CXX" -std=c++20 -O2 -Wall -Wextra -Wpedantic -Werror \
  asio-ring-tests.cpp \
  -o "$OUT"

"$OUT"
