#!/bin/sh
#
# Generates the reference fixtures for test/reference.test.ts with the super
# CLI: for each test/reference/sup/NAME.sup, it writes
#
#   test/reference/out/NAME.col.bsup   BSUP column frames (super's default)
#   test/reference/out/NAME.row.bsup   BSUP row frames (super -rows)
#   test/reference/out/NAME.sup        the expected SUP text
#
# If test/reference/sup/NAME.args exists, its contents are extra arguments
# for super (e.g., `-c fuse` or `-fusion`).
#
# If super can't make a fixture, the script goes on to the next one, and at
# the end it exits nonzero, since the tests skip missing fixtures.
#
# Usage: npm run fixtures   (or SUPER=/path/to/super sh scripts/gen-fixtures.sh)

set -u
SUPER=${SUPER:-super}
cd "$(dirname "$0")/.."
in=test/reference/sup
out=test/reference/out
rm -rf "$out"
mkdir -p "$out"
"$SUPER" -version 2>/dev/null > "$out/VERSION" || true
failed=0
for src in "$in"/*.sup; do
  name=$(basename "$src" .sup)
  args=""
  [ -f "$in/$name.args" ] && args=$(cat "$in/$name.args")
  if ! "$SUPER" $args -f sup -pretty 0 -o "$out/$name.sup" "$src" 2> "$out/$name.err"; then
    echo "skipping $name: $(head -1 "$out/$name.err")"
    rm -f "$out/$name.sup"
    failed=1
    continue
  fi
  rm -f "$out/$name.err"
  "$SUPER" $args -f bsup -o "$out/$name.col.bsup" "$src" || failed=1
  "$SUPER" $args -f bsup -rows -o "$out/$name.row.bsup" "$src" || failed=1
done
echo "wrote fixtures to $out"
if [ $failed -ne 0 ]; then
  echo "super couldn't make some of the fixtures" >&2
  exit 1
fi
