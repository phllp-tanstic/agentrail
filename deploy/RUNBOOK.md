# AgentRail — public deployment runbook (EC2 → DuckDNS → Caddy → verify → commit)

**Status:** Part 4 (rate limiter) is DONE and fully tested locally. Parts 1–3 need
AWS credentials + a DuckDNS token + (ideally) your own IP for the SSH rule — none
of which exist on this machine yet (no aws CLI, no ~/.aws, no ~/.ssh). Everything
below is copy-paste-ready; items marked ⛵ YOU are the only human inputs.

---

## Part 1 — EC2 + Elastic IP (from any machine with AWS creds; this PC after `winget install Amazon.AWSCLI` + `aws configure`)

```bash
# 1.1 ⛵ YOU: DuckDNS — open https://www.duckdns.org, note your token, keep the
#     agentrail subdomain. The IP update happens in step 1.6.

# 1.2 Key pair (skip if you already have one in us-east-1)
aws ec2 create-key-pair --region us-east-1 --key-name agentrail-deploy \
  --query 'KeyMaterial' --output text > ~/agentrail-deploy.pem

# 1.3 Security group — 22 ONLY from your IP ⛵, 80/443 open, 8787 NEVER
MYIP=$(curl -s https://checkip.amazonaws.com)/32
aws ec2 create-security-group --region us-east-1 --group-name agentrail-sg \
  --description "AgentRail: ssh(me)+http/https world; app port stays localhost"
SGID=$(aws ec2 describe-security-groups --region us-east-1 --group-names agentrail-sg \
  --query 'SecurityGroups[0].GroupId' --output text)
aws ec2 authorize-security-group-ingress --region us-east-1 --group-id $SGID \
  --protocol tcp --port 22 --cidr $MYIP
aws ec2 authorize-security-group-ingress --region us-east-1 --group-id $SGID \
  --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --region us-east-1 --group-id $SGID \
  --protocol tcp --port 443 --cidr 0.0.0.0/0
# NO 8787 rule — the app is reachable ONLY via Caddy on localhost.

# 1.4 Launch t3.micro, Ubuntu 22.04 (AMI resolved live via SSM — never hardcode)
AMI=$(aws ssm get-parameters --region us-east-1 \
  --names /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id \
  --query 'Parameters[0].Value' --output text)
aws ec2 run-instances --region us-east-1 --image-id $AMI --instance-type t3.micro \
  --key-name agentrail-deploy --security-group-ids $SGID \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=agentrail}]'
IID=$(aws ec2 describe-instances --region us-east-1 \
  --filters Name=tag:Name,Values=agentrail Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

# 1.5 Elastic IP — allocate + associate + VERIFY (unattached EIP bills even on free tier)
aws ec2 allocate-address --region us-east-1 --domain vpc   # note AllocationId + IP
EIP=<$the IP> ; ALLOC=<$the AllocationId>
aws ec2 associate-address --region us-east-1 --instance-id $IID --allocation-id $ALLOC
aws ec2 describe-addresses --region us-east-1 --query "Addresses[?PublicIp=='$EIP']"
#   must show InstanceId == $IID — an EIP row with no instance is the billing trap.

# 1.6 ⛵ YOU: DuckDNS dashboard → agentrail → set IP to $EIP. Or scripted:
# curl "https://www.duckdns.org/update?domains=agentrail&token=<DUCKDNS_TOKEN>&ip=$EIP"   → must answer OK

# 1.7 Confirm resolution BEFORE moving on
nslookup agentrail.duckdns.org        # must return $EIP
```

## Part 2 — Deploy AgentRail (on the box)

```bash
# 2.8 From this PC: scp the kit, then bootstrap on the box
#   scp -i ~/agentrail-deploy.pem deploy/agentrail.service deploy/Caddyfile deploy/bootstrap-agentrail.sh ubuntu@$EIP:
#   ssh -i ~/agentrail-deploy.pem ubuntu@$EIP
#   sudo mkdir -p /opt/agentrail-deploy && sudo mv ~/{agentrail.service,Caddyfile,bootstrap-agentrail.sh} /opt/agentrail-deploy/
#   sudo bash /opt/agentrail-deploy/bootstrap-agentrail.sh
#   (installs pinned Node v24.16.0 tarball → /opt/node-v24.16.0, clones the repo,
#    creates the agentrail user + /var/lib/agentrail stores, systemd unit, Caddy)
```

```text
# 2.9 ⛵ YOU: the master key — either reuse the EXISTING AGENTRAIL_WALLET_MASTER_KEY
#     from this PC's .env (so the deployed server decrypts the same wallet store
#     family), or generate a FRESH 64-hex key if starting stores from scratch:
#       sudoedit /etc/agentrail/agentrail.env     # AGENTRAIL_WALLET_MASTER_KEY=<64 hex>
#     (HTTP port/host and all four store-path vars are already in the systemd unit:
#      AGENTRAIL_HTTP_PORT=8787, AGENTRAIL_HTTP_HOST=127.0.0.1, AGENTRAIL_WALLET_STORE,
#      AGENTRAIL_ACCOUNTS_STORE, AGENTRAIL_RISK_STORE, AGENTRAIL_TRADE_LOG_DIR —
#      the handover §7 set. Secrets live ONLY in /etc/agentrail/agentrail.env, mode 640.)
```

```bash
# 2.10 Start + verify clean boot, localhost:8787 ONLY
sudo systemctl start agentrail
sudo journalctl -u agentrail -n 30 --no-pager     # expect "[http] ... live at http://127.0.0.1:8787/mcp"
ss -tlnp | grep 8787                              # must show 127.0.0.1:8787 — NEVER 0.0.0.0
# auto-restart on crash/reboot = Restart=always + enable (bootstrap did both)
# reboot durability check (optional): sudo reboot, then re-run the two lines above

# 2.11 localhost smoke test ON the box (counts against the 5/10min limit!)
curl -s http://127.0.0.1:8787/mcp -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_account","arguments":{"session_id":"deploy_smoke"}}}'
```

## Part 3 — Caddy / HTTPS

```bash
# 3.12 Caddyfile + service were installed by bootstrap; verify the cert:
sudo journalctl -u caddy -n 30 --no-pager    # expect "certificate obtained successfully" for agentrail.duckdns.org
# 3.13 From THIS PC (a separate machine):
curl -s https://agentrail.duckdns.org/mcp -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'          # JSON-RPC answer over TLS = path proven
```

## Part 5 — Verify end to end, THEN commit (order is mandatory)

```text
5.14 ⛵ From a machine that is NOT the EC2 box — this PC qualifies; Claude Desktop
     (MCP config: url https://agentrail.duckdns.org/mcp) ideally — run the REAL
     round trip over the public endpoint:
       create_account → generate_wallet → get_wallet_balance
     Real outputs required, not assumed. I have a ready client script for this
     and will run it myself the moment the endpoint is live.

5.15 ONLY once that round trip is proven:
     git status
     git add build/rate-limit.mjs build/rate-limit-test.mjs build/mcp-server.mjs
       (explicit staging; deploy/ joins the commit only if you want it in-repo)
     git diff --staged        ← review
     git commit && git push
     post-push verification: fresh clone of origin/main + node build/rate-limit-test.mjs
```

## What already passed locally (Part 4, this PC)

- `build/rate-limit.mjs` — new module: fixed-window per-IP limiter, 5 req / 10 min
  (env-tunable via AGENTRAIL_RATE_CREATE_ACCOUNT_MAX / _WINDOW_SECONDS), XFF trusted
  only from loopback peers (rightmost hop — spoof-proof behind Caddy),
  AsyncLocalStorage identity plumbing, fail-closed on limiter error.
- `build/mcp-server.mjs` — 13-line diff, wired to `create_account` ONLY.
- `build/rate-limit-test.mjs` — 32/32 offline: blocks past threshold, truthful
  retryAfterSeconds, window reset, per-IP isolation, spoof rejection, and no
  false-positive on normal single-session use.
- `.scratch/rate-limit-http-check.mjs` — real transport proof: 5 ok, 6th
  `rate_limited`, other tools unaffected, keys real. (The `UV_HANDLE_CLOSING`
  libuv assertion at process exit is the pre-existing Windows shutdown artifact
  documented in mcp-server.mjs's per-request-transport comment — unrelated.)
- Full regression: accounts 21/21, auth-gate 15/15, filelock 13/13, intent 29/29,
  risk 28/28, trade-log 31/31, wallet-crypto 19/19, rate-limit 32/32.
  ⚠ `risk-test` was run with AGENTRAIL_RISK_STORE redirected to a temp file —
  running it unredirected WIPES the real risk ledger (_resetRiskState persists).
- `mcp-test --mcp --list` — all 12 tools still advertised over real stdio MCP.
- Committed and pushed at Part 5, only after the public round-trip proof
  (create_account → generate_wallet → get_wallet_balance over
  https://agentrail.duckdns.org from a separate machine, real outputs).
- Deployed-box notes (found live 2026-09-11): the systemd unit ships WITHOUT
  MemoryDenyWriteExecute (V8 W^X crash, see agentrail.service note); deps must
  be installed (npm ci — not vendored); Caddyfile needs header_up Host
  localhost:8787 (mcp-server.mjs's loopback Host guard otherwise 400s every
  proxied request). deploy/ carries all three fixes.