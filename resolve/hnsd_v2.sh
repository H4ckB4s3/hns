#!/bin/bash
set -e

echo "[+] Installing dependencies..."
sudo apt update -y
sudo apt install -y autotools-dev autoconf automake libtool build-essential libunbound-dev pkg-config git libcap2-bin

echo "[+] Fetching source..."
cd ~
if [ ! -d "hnsd" ]; then
  git clone https://github.com/handshake-org/hnsd.git
fi
cd hnsd

echo "[+] Building (if needed)..."
if [ ! -f "hnsd" ]; then
  ./autogen.sh
  ./configure
  make
fi

echo "[+] Installing binary..."
sudo cp hnsd /usr/local/bin/

echo "[+] Setting permissions..."
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/hnsd

echo "[+] Preparing config..."
mkdir -p ~/.hnsd

# CLEAN FIX: initialize only if needed, silently and safely
if [ ! -f ~/.hnsd/root.key ]; then
  echo "[+] Initializing root key..."
  timeout 5 hnsd -t -x ~/.hnsd >/dev/null 2>&1 || true
fi

echo "[+] Configuring systemd-resolved..."
sudo sed -i 's/^#*DNS=.*/DNS=127.0.0.1/' /etc/systemd/resolved.conf
sudo sed -i 's/^#*DNSStubListener=.*/DNSStubListener=no/' /etc/systemd/resolved.conf
sudo systemctl restart systemd-resolved

echo "[+] Creating systemd service..."
sudo tee /etc/systemd/system/hnsd.service > /dev/null <<EOF
[Unit]
Description=Handshake DNS Daemon
After=network.target

[Service]
ExecStart=/usr/local/bin/hnsd -p 4 -r 127.0.0.1:53
Restart=always
RestartSec=3
User=root
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF

echo "[+] Enabling service..."
sudo systemctl daemon-reload
sudo systemctl enable hnsd
sudo systemctl restart hnsd

echo "[+] Done. Check status with:"
echo "    systemctl status hnsd"
