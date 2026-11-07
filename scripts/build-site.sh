#!/usr/bin/env bash
# 배포할 파일을 _site에 모으고, 브라우저가 옛 파일을 캐시에서 섞어 쓰지 않게
# 모든 CSS·JS 주소에 판 표시(?v=<커밋>)를 붙인다.
set -euo pipefail
version="${1:-$(git rev-parse --short HEAD)}"
rm -rf _site
mkdir _site
cp -r index.html styles.css src _site/
sed -i -E "s#(href=\"styles\.css)\"#\1?v=${version}\"#; s#(src=\"src/app\.js)\"#\1?v=${version}\"#" _site/index.html
sed -i -E "s#(from '\./[A-Za-z0-9_-]+\.js)'#\1?v=${version}'#g" _site/src/*.js
# 바꾸지 못한 주소가 있으면 실패한다.
grep -q "styles.css?v=${version}" _site/index.html
grep -q "src/app.js?v=${version}" _site/index.html
if grep -nE "from '\./[A-Za-z0-9_-]+\.js'" _site/src/*.js; then
  echo "version stamp missing in imports" >&2
  exit 1
fi
echo "built _site (v=${version})"
