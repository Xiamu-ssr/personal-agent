#!/bin/bash
set -euo pipefail
MAC_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE="$MAC_ROOT/../design/mascot"
DEST="$MAC_ROOT/Resources/Mascot"
mkdir -p "$DEST"
FINAL=1
for state in idle working waiting happy error; do
  for file in still.png light.mp4 dark.mp4; do
    [[ -f "$SOURCE/states/$state/$file" ]] || FINAL=0
  done
done
if [[ "$FINAL" == "1" ]]; then
  for state in idle working waiting happy error; do
    mkdir -p "$DEST/$state"
    cp "$SOURCE/states/$state/"{still.png,light.mp4,dark.mp4} "$DEST/$state/"
  done
  printf 'final-five-states\n' > "$DEST/source.txt"
else
  for state in idle working waiting happy error; do
    mkdir -p "$DEST/$state"
    cp "$SOURCE/candidates/a/portrait.png" "$DEST/$state/still.png"
    rm -f "$DEST/$state/light.mp4" "$DEST/$state/dark.mp4"
  done
  printf 'candidate-a-still-placeholder\n' > "$DEST/source.txt"
  echo '正式五态视频尚未齐备，五种状态暂用候选 A 静帧。'
fi
