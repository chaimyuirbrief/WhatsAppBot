#!/usr/bin/env bash
# Installs system dependencies and the app. Safe to re-run.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MAJOR=20

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

if [[ $EUID -eq 0 ]]; then
  warn "Run this as your normal user, not root. It will call sudo when needed."
  exit 1
fi

say "Installing base packages"
sudo apt-get update -qq
sudo apt-get install -y curl ca-certificates

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt $NODE_MAJOR ]]; then
  say "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
else
  say "Node $(node -v) already present"
fi

say "Installing npm packages"
cd "$APP_DIR"
npm install --omit=dev

mkdir -p "$APP_DIR/data"
chmod 700 "$APP_DIR/data"

say "Generating the systemd unit for this install"
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__APP_USER__|$USER|g" \
  "$APP_DIR/whatsapp-bot.service.template" > "$APP_DIR/whatsapp-bot.service"

cat <<EOF

$(say "Done")

Start it now with:
    cd $APP_DIR && npm start

Or install it as a service that survives reboots:
    sudo cp $APP_DIR/whatsapp-bot.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now whatsapp-bot

Then open the control panel from any device on your network:
    http://$(hostname -I | awk '{print $1}'):8080

Moving an existing bot onto this machine? Copy its backup file across and:
    node bin/backup.js restore /path/to/backup.wabak

That restores the settings, the admin accounts and the WhatsApp link, so
there is no need to re-pair the phone. Make one on the old machine with:
    node bin/backup.js create

EOF
