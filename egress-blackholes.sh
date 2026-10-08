#!/usr/bin/env bash
# Blackhole CDN addresses this network cannot reach, so clients fail over at once instead of hanging.
#
# Why: an ISP can drop one of a CDN's anycast addresses while the others work. DNS still hands it
# out, so one connection in N hangs until the TCP connect timeout (75 s for curl, 30 s for uv's
# client). uv gives up after three tries, so a verifier that installs Python at grade time can
# fail a task the agent solved: db-wal-recovery, 2026-10-07, three runs out of three, while the
# same verifier passed on 2026-10-05. Measured from this host on 2026-10-08: 185.199.109.133
# (raw/objects/release-assets.githubusercontent.com) dies at the ISP's fourth hop; its three
# siblings answer in 60 ms; 115 other addresses across the package hosts below were all fine.
# 84 of the 89 terminal-bench@2.0 verifiers download uv (and most a CPython) from these hosts.
#
# With a blackhole route the kernel refuses the connection immediately (ENETUNREACH) and every
# client we care about (curl, uv/reqwest, pip, apt, git) moves to the next address.
# This only removes a dead route; it changes nothing a task or verifier does.
#
# Run on the Docker host (here, the Lima VM), as root, before a run and at every boot:
#   limactl shell ohbench -- sudo bash "$PWD/egress-blackholes.sh"
set -u
hosts="github.com api.github.com codeload.github.com raw.githubusercontent.com
objects.githubusercontent.com release-assets.githubusercontent.com pkg-containers.githubusercontent.com
ghcr.io astral.sh pypi.org files.pythonhosted.org registry.npmjs.org deb.debian.org huggingface.co"
limit="${EGRESS_PROBE_TIMEOUT_S:-5}"

# Start from a clean slate so an address that came back is not kept dead for ever.
for r in $(ip -4 route show type blackhole | awk '{print $2}'); do
  ip route del blackhole "$r" && echo "[egress] cleared blackhole $r"
done

bad=0; total=0
for h in $hosts; do
  ips=$(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' | sort -u)
  [ -z "$ips" ] && { echo "[egress] no A record for $h" >&2; continue; }
  for ip in $ips; do
    total=$((total + 1))
    if timeout "$limit" bash -c "exec 3<>/dev/tcp/$ip/443" 2>/dev/null; then
      continue
    fi
    bad=$((bad + 1))
    ip route replace blackhole "$ip/32" && echo "[egress] $h $ip: no TCP connect in ${limit}s; blackholed"
  done
done
echo "[egress] probed $total addresses, blackholed $bad"
