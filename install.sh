#!/usr/bin/env bash
# Installs system dependencies and the app, and enables it as a systemd service
# so it comes back after a reboot. Safe to re-run.
#
#   ./install.sh                 install and enable the service (default)
#   ./install.sh --no-service    install only; start it yourself with npm start
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

# Install it as a service by default. A bot that does not come back after a
# reboot is a bot that silently stops moderating, and the reboot is usually an
# unattended `apt upgrade` at 3am - nobody is watching to run `npm start`.
# --no-service skips this for anyone running it in the foreground on purpose.
INSTALL_SERVICE=1
for arg in "$@"; do
  [[ "$arg" == "--no-service" ]] && INSTALL_SERVICE=0
done

if [[ $INSTALL_SERVICE -eq 1 && -d /run/systemd/system ]]; then
  say "Installing the service so it starts on boot"
  sudo cp "$APP_DIR/whatsapp-bot.service" /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable whatsapp-bot
  # restart, not start: re-running install.sh after a code change should pick
  # the new code up, and restart starts it if it was stopped.
  sudo systemctl restart whatsapp-bot

  sleep 2
  if systemctl is-active --quiet whatsapp-bot; then
    say "Running, and enabled on boot"
  else
    warn "The service did not come up. Check: sudo journalctl -u whatsapp-bot -n 50"
  fi
  SERVICE_NOTE="It is running now and will start again on every reboot.

    sudo systemctl status whatsapp-bot     # is it up?
    sudo journalctl -u whatsapp-bot -f     # follow the log
    sudo systemctl restart whatsapp-bot    # after changing settings on disk"
elif [[ $INSTALL_SERVICE -eq 1 ]]; then
  warn "No systemd on this machine, so nothing was enabled on boot."
  SERVICE_NOTE="This machine has no systemd, so start it yourself:
    cd $APP_DIR && npm start"
else
  SERVICE_NOTE="Skipped the service (--no-service). Start it yourself with:
    cd $APP_DIR && npm start

Or install it later:
    sudo cp $APP_DIR/whatsapp-bot.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now whatsapp-bot"
fi

cat <<EOF

$(say "Done")

$SERVICE_NOTE

Then open the control panel from any device on your network:
    http://$(hostname -I | awk '{print $1}'):8080

Moving an existing bot onto this machine? Copy its backup file across and:
    node bin/backup.js restore /path/to/backup.wabak

That restores the settings, the admin accounts and the WhatsApp link, so
there is no need to re-pair the phone. Make one on the old machine with:
    node bin/backup.js create

EOF
