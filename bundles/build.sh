#!/usr/bin/env bash
# Build a harness bundle and extract it to .cache/harness/<name>/.
#   ./bundles/build.sh claude-code|codex|opencode|openclaw|hermes|openhuman|openhuman-jev
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
name="${1:?usage: build.sh <harness>}"
args=()
while IFS='=' read -r k v; do
  [[ -z "$k" || "$k" == \#* ]] && continue
  args+=(--build-arg "$k=$v")
done < "$here/harnesses.lock"

image="bench-bundle-$name"
case "$name" in
  openhuman|openhuman-jev)
    docker build -f "$here/bundles/Dockerfile.openhuman" \
      --build-arg "ADAPTER=adapters/$name.sh" \
      --build-arg "GIT_SHA=$(git -C "$repo" rev-parse --short HEAD)" \
      -t "$image" "$repo"
    ;;
  deepseek-harness-minimal)
    # Same install as deepseek-harness; only the adapter (profile) differs.
    image="bench-bundle-deepseek-harness"
    docker build -f "$here/bundles/Dockerfile" --target deepseek-harness "${args[@]}" -t "$image" "$here/bundles"
    ;;
  *)
    docker build -f "$here/bundles/Dockerfile" --target "$name" "${args[@]}" -t "$image" "$here/bundles"
    ;;
esac

out="$here/.cache/harness/$name"
rm -rf "$out"; mkdir -p "$out"
cid="$(docker create "$image" /bin/true)"
trap 'docker rm -f "$cid" >/dev/null' EXIT
docker cp "$cid:/opt/harness/." "$out/"
if [ "$name" = deepseek-harness-minimal ]; then
  cp "$here/bundles/adapters/deepseek-harness-minimal.sh" "$out/adapter.sh"
fi
chmod +x "$out/adapter.sh"
echo "bundle ready: $out ($(du -sh "$out" | cut -f1))"
