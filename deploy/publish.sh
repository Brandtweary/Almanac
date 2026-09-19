#!/usr/bin/env bash
# Build the browser bundle for a hosted deployment and push it to a server.
#
# The build happens in a throwaway git worktree rather than in the working tree,
# because Vite loads `.env.local` in production builds as well as development
# ones. That file is gitignored, so a build run in place silently compiles a
# developer's own service URLs — typically loopback addresses — into a bundle
# served to the public. A page that then tries to open connections to
# 127.0.0.1 trips the browser's local-network permission prompt and cannot
# reach its gateway at all. A clean checkout has no such file, which is the
# whole reason this script exists rather than a bare `npm run build`.
#
#   ./deploy/publish.sh <ssh-target>:<path> [base-path] [verify-url]
#
# <base-path> is Vite's `base` and must match the prefix the reverse proxy
# strips; the default is "/". <verify-url> is fetched at the end to confirm the
# deployed page references the bundle that was just built.
set -euo pipefail

DEST="${1:?usage: publish.sh <ssh-target>:<path> [base-path] [verify-url]}"
BASE="${2:-/}"
VERIFY="${3:-}"

REPO="$(git rev-parse --show-toplevel)"
BUILD="$(mktemp -d)"
cleanup() { git -C "$REPO" worktree remove "$BUILD" --force >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$REPO" worktree add --detach "$BUILD" HEAD >/dev/null
cd "$BUILD"

npm ci --silent
VITE_BASE_PATH="$BASE" npm run build

# Refuse a bundle that would reach for the visitor's own machine. Checked on
# the artifact rather than on the environment that produced it: the point is
# what was compiled in, and every route to compiling one in is covered by
# looking at the output.
#
# `src/app-paths.ts` carries one bare loopback ORIGIN as the base for URL
# resolution where `location` is undefined, which is every non-browser caller
# and no served page. It is exempt by exact spelling rather than by pattern: a
# configured service endpoint always carries a path or a different port, so
# nothing this guard exists to catch can hide behind the exemption.
PRIVATE='(https?|wss?)://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)[0-9.]*(:[0-9]+)?/?[^"'"'"'`]*'
found="$(grep -rIhoE "$PRIVATE" dist/assets | grep -vxF 'http://127.0.0.1:8790/' | sort -u || true)"
if [ -n "$found" ]; then
	echo "REFUSING TO PUBLISH: the built bundle carries a private-network endpoint." >&2
	printf '%s\n' "$found" >&2
	echo "A developer .env.local reached this build, or an override is set in the environment." >&2
	exit 1
fi

# The other half of the same failure: assets baked at the wrong prefix return
# 404 behind a path-stripping proxy while index.html still answers 200, so the
# page loads white and every check short of fetching an asset passes.
if [ "$BASE" != "/" ] && ! grep -q "src=\"${BASE}assets/" dist/index.html; then
	echo "REFUSING TO PUBLISH: index.html does not reference assets under ${BASE}." >&2
	exit 1
fi

rsync -a --delete dist/ "$DEST"

if [ -n "$VERIFY" ]; then
	asset="$(curl -fsS -H 'Cache-Control: no-cache' "$VERIFY" \
		| grep -oE "${BASE}assets/index-[A-Za-z0-9_-]+\.js" | head -1)"
	[ -n "$asset" ] || { echo "VERIFY FAILED: no bundle referenced at $VERIFY" >&2; exit 1; }
	origin="${VERIFY%${BASE}*}"
	code="$(curl -fsS -o /dev/null -w '%{http_code}' "${origin}${asset}")"
	[ "$code" = "200" ] || { echo "VERIFY FAILED: $asset returned $code" >&2; exit 1; }
	echo "verified: $VERIFY serves $asset ($code)"
fi

echo "published to $DEST"
