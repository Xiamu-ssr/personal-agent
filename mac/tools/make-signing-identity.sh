#!/bin/bash
# Run manually once. Imports a self-signed code-signing identity into the user's login Keychain.
# Does not change the system Keychain, request a password on the command line, or allow every app access.
set -euo pipefail
umask 077
IDENTITY="Doudou Local Signing"
if [[ $EUID -eq 0 ]]; then
  echo "不要用 sudo 运行：证书要导入你自己的登录钥匙串。" >&2
  exit 1
fi
# `security login-keychain` returns nothing on some macOS installs; the default keychain is the login one.
KEYCHAIN=$(security default-keychain -d user 2>/dev/null | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' || true)
[[ -f "$KEYCHAIN" ]] || KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
if [[ -z "$KEYCHAIN" || ! -f "$KEYCHAIN" ]]; then
  echo "找不到登录钥匙串；请先在「钥匙串访问」里设置登录钥匙串。" >&2
  exit 1
fi
if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  if security find-identity -v -p codesigning "$KEYCHAIN" | awk '/"Doudou Local Signing"/ {found=1} END {exit !found}'; then
    echo "$IDENTITY 已存在，跳过创建。"
    exit 0
  fi
  echo "$IDENTITY 的证书已存在，跳过创建；请在「钥匙串访问」检查对应私钥和代码签名信任。" >&2
  exit 1
fi
SIGNING_DIR="$HOME/.personal-agent/signing"
mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"
TEMP=$(mktemp -d "$SIGNING_DIR/.identity.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT
cat > "$TEMP/certificate.conf" <<'CONFIG'
[req]
prompt = no
distinguished_name = subject
x509_extensions = signing
[subject]
CN = Doudou Local Signing
[signing]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CONFIG
/usr/bin/openssl req -new -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$TEMP/certificate.conf" -keyout "$TEMP/key.pem" -out "$TEMP/certificate.pem" 2>/dev/null
# Temporary PKCS#12 uses an empty transport password; its directory is owner-only and deleted on exit.
# macOS rejects PKCS12 files exported with an empty password, so use a throwaway one.
export P12_PASS=$(/usr/bin/openssl rand -hex 16)
/usr/bin/openssl pkcs12 -export -name "$IDENTITY" -inkey "$TEMP/key.pem" \
  -in "$TEMP/certificate.pem" -out "$TEMP/identity.p12" -passout env:P12_PASS
echo "即将导入登录钥匙串；macOS 可能要求解锁钥匙串或确认信任代码签名证书。"
security import "$TEMP/identity.p12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign >/dev/null
# User-domain trust, limited to the codeSign policy.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TEMP/certificate.pem"
cp "$TEMP/certificate.pem" "$SIGNING_DIR/certificate.pem"
if ! security find-identity -v -p codesigning "$KEYCHAIN" | awk '/"Doudou Local Signing"/ {found=1} END {exit !found}'; then
  echo "证书已导入，但代码签名身份尚不可用；请在「钥匙串访问」检查证书信任和对应私钥。" >&2
  exit 1
fi
echo "$IDENTITY 已就绪。首次构建时，钥匙串可能询问是否允许 codesign 使用这个私钥。"
