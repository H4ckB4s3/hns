# Install dependencies
sudo apt update
sudo apt install -y autotools-dev autoconf automake libtool build-essential libunbound-dev pkg-config git

# Get HNSD
cd ~
git clone https://github.com/handshake-org/hnsd.git
cd hnsd

# Build (NO global install)
./autogen.sh
./configure
make

# Install ONLY the binary (safe)
sudo cp hnsd /usr/local/bin/

# Allow binding to port 53
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/hnsd

# Create config directory
mkdir -p ~/.hnsd

# Initialize root anchors
hnsd -t -x ~/.hnsd

# Configure systemd-resolved to use HNSD
sudo sed -i 's/^#*DNS=.*/DNS=127.0.0.1/' /etc/systemd/resolved.conf
sudo sed -i 's/^#*DNSStubListener=.*/DNSStubListener=yes/' /etc/systemd/resolved.conf

# Restart resolver
sudo systemctl restart systemd-resolved

# Create systemd service for HNSD
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

# Reload systemd
sudo systemctl daemon-reload

# Enable auto-start on boot
sudo systemctl enable hnsd

# Start service now
sudo systemctl start hnsd
