#!/usr/bin/env bash
# Builds and runs the native mix-graph tests. No JUCE, no audio device: this is
# the part of the native mixer that can be checked on any machine with a C++20
# compiler. The JUCE/VST3 adapter is compiled by the desktop build.
set -euo pipefail

cd "$(dirname "$0")"

CXX="${CXX:-c++}"
OUT="${TMPDIR:-/tmp}/hybrid-mixgraph-tests"

"$CXX" -std=c++20 -O2 -Wall -Wextra -Wpedantic -Werror \
  MixGraph.cpp SongPlayer.cpp tests.cpp \
  -o "$OUT"

"$OUT"
