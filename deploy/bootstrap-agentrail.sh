#!/usr/bin/env bash
# ============================================================================
# bootstrap-agentrail.sh — run ON THE EC2 BOX as root, after SSH works.
# Installs Node v24.16.0 (pinned tarball, no nvm), clones the repo, creates the
# agentrail user + state dirs, installs the systemd unit and Caddy.
# Prereqs: this file + deploy/agentrail.service + deploy/Caddyfile present in
# /opt/agentrail-deploy/ (scp them there first — see RUNBOOK step 8).
# ============================================================================
set -euo pipefail

NODE_VERSION=24.16.0
REPO=https://github.com/phllp-tanstic/agentrail.git

echo "== 1. Node v${NODE_VERSION} (pinned tarball) =="
if [ ! -x "/opt/node-v${NODE_VERSION}/bin/node" ]; then
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /opt
  mv "/opt/node-v${NODE_VERSION}-linux-x64" "/opt/node-v${NODE_VERSION}" 2>/dev/null || true
fi
"/opt/node-v${NODE_VERSION}/bin/node" --version   # must print v24.16.0

echo "== 2. agentrail user + state dirs =="
id -u agentrail >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin agentrail
install -d -o agentrail -g agentrail -m 750 /var/lib/agentrail
install -d -o agentrail -g agentrail -m 750 /var/lib/agentrail/.trade-log
install -d -o root -g agentrail -m 750 /etc/agentrail

echo "== 3. clone repo (code only; no secrets ever live here) =="
[ -d /opt/agentrail/.git ] || git clone "$REPO" /opt/agentrail
cd /opt/agentrail
git fetch --all
# The rate-limiter commit lands here after the post-E2E push; until then the
# deployed copy is brought up to the pushed main explicitly:
git reset --hard origin/main
ln -sfn "/opt/node-v${NODE_VERSION}/bin/node" /usr/local/bin/node  # npm's shebang needs `env node`
# repo is cloned by root but the SERVICE runs as agentrail — give it the tree:
chown -R agentrail:agentrail /opt/agentrail
# deps are NOT vendored (found live: ERR_MODULE_NOT_FOUND @modelcontextprotocol/sdk)
sudo -u agentrail env PATH="/opt/node-v${NODE_VERSION}/bin:$PATH" \
  "/opt/node-v${NODE_VERSION}/bin/npm" ci --no-audit --no-fund

echo "== 4. env file template (fill in the master key BEFORE starting) =="
if [ ! -f /etc/agentrail/agentrail.env ]; then
  cat > /etc/agentrail/agentrail.env <<EOF
# /etc/agentrail/agentrail.env — chmod 640 root:agentrail. NEVER commit.
AGENTRAIL_WALLET_MASTER_KEY=<PASTE-64-HEX-CHARS>
EOF
  chown root:agentrail /etc/agentrail/agentrail.env
  chmod 640 /etc/agentrail/agentrail.env
fi

echo "== 5. systemd unit =="
install -m 644 /opt/agentrail-deploy/agentrail.service /etc/systemd/system/agentrail.service
# The unit's ExecStart pins the node binary path:
sed -i "s|/opt/node-v[0-9.]*/bin/node|/opt/node-v${NODE_VERSION}/bin/node|" /etc/systemd/system/agentrail.service
systemctl daemon-reload
systemctl enable agentrail.service

echo "== 6. Caddy =="
if ! command -v caddy >/dev/null; then
  install -d -m 755 /usr/share/keyrings
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq && apt-get install -y -qq caddy
fi
install -m 644 /opt/agentrail-deploy/Caddyfile /etc/caddy/Caddyfile
systemctl enable --now caddy 2>/dev/null || systemctl restart caddy

echo
echo "== NEXT (manual, from RUNBOOK) =="
echo "  1. Put the REAL AGENTRAIL_WALLET_MASTER_KEY into /etc/agentrail/agentrail.env"
echo "  2. systemctl start agentrail && journalctl -u agentrail -n 30   (expect '[http] ... live at http://127.0.0.1:8787/mcp')"
echo "  3. curl -s http://127.0.0.1:8787/ -X POST -H 'Content-Type: application/json' ... (tools/call create_account smoke test)"
echo "  4. journalctl -u caddy -n 30   (expect certificate obtained for agentrail.duckdns.org)"
echo "  5. From a SEPARATE machine: run the public round-trip (RUNBOOK step 13)."