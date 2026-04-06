#!/bin/bash
set -e
set -x

# Install dependencies
sudo apt update
sudo apt install -y autotools-dev autoconf automake libtool build-essential libunbound-dev pkg-config git libcap2-bin

# Get HNSD
cd ~
git clone https://github.com/handshake-org/hnsd.git || true
cd hnsd

# Build
./autogen.sh
./configure
make

# Install binary
sudo cp hnsd /usr/local/bin/

# Allow port 53 binding
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/hnsd

# Create config
mkdir -p ~/.hnsd
[ -f ~/.hnsd/root.key ] || hnsd -t -x ~/.hnsd

# Fix systemd-resolved conflict
sudo sed -i 's/^#*DNS=.*/DNS=127.0.0.1/' /etc/systemd/resolved.conf
sudo sed -i 's/^#*DNSStubListener=.*/DNSStubListener=no/' /etc/systemd/resolved.conf

sudo systemctl restart systemd-resolved

# Create service
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

# Enable + start
sudo systemctl daemon-reload
sudo systemctl enable hnsd
sudo systemctl restart hnsd
