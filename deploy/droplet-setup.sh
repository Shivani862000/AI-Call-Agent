#!/usr/bin/env bash
# One-time droplet setup. Run as root on a fresh Ubuntu 24.04 droplet:
#   ssh root@<ip> 'bash -s' < deploy/droplet-setup.sh
set -euo pipefail

echo "== packages =="
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw

echo "== docker =="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "== swap =="
# 1 GB of RAM with two Node processes plus Caddy is tight. Swap turns a
# transient spike into slowness rather than the OOM killer choosing a victim.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

echo "== log rotation =="
# Container logs on a 25 GB disk will fill it otherwise.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker

echo "== firewall =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== deploy user =="
id -u deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh /opt/app
chown -R deploy:deploy /home/deploy/.ssh /opt/app
chmod 700 /home/deploy/.ssh

echo
echo "Done. Next:"
echo "  1. Put the deploy public key in /home/deploy/.ssh/authorized_keys"
echo "  2. Copy Caddyfile and docker-compose.prod.yml to /opt/app"
echo "  3. Create /opt/app/.env.prod and /opt/app/.env.uat from the examples"
echo "  4. Point app. and uat. DNS A records at this droplet"
