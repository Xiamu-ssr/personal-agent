#!/bin/bash
# Checks the missing-identity gate with a fake security executable. Never creates/imports a certificate.
set -euo pipefail
cd "$(dirname "$0")/.."
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/doudou-caps-signing.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT
bash -n build.sh tools/make-signing-identity.sh tools/caps-test.sh
plutil -lint Info.plist
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Info.plist)" == "0.4.0" ]]
mkdir "$TEMP/bin" "$TEMP/output"
touch "$TEMP/output/preserved"
cat > "$TEMP/bin/security" <<'SECURITY'
#!/bin/bash
if [[ "$1" == "find-identity" ]]; then
  echo "0 valid identities found"
  exit 0
fi
echo "Unexpected keychain operation in signing gate test" >&2
exit 99
SECURITY
chmod +x "$TEMP/bin/security"
if PATH="$TEMP/bin:$PATH" DOUDOU_SKIP_SIGNING=0 OUT="$TEMP/output" bash build.sh > "$TEMP/result" 2>&1; then
  echo "FAIL: build accepted a missing fixed identity" >&2
  exit 1
fi
rg -q "make-signing-identity.sh" "$TEMP/result"
[[ -f "$TEMP/output/preserved" ]]
if rg -q -- '--sign -([[:space:]]|$)' build.sh; then
  echo "FAIL: ad-hoc signing fallback remains" >&2
  exit 1
fi
echo "PASS: version 0.4.0, script/plist syntax, missing identity blocks before overwriting output, no ad-hoc fallback"
