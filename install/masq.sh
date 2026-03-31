#!/bin/bash

# install_hns_tld.sh - Simplified version that lets dnssec-signzone find keys

echo "============================================="
echo "Handshake Root TLD Setup with DNSSEC"
echo "============================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Please run as root (use sudo)"
    exit 1
fi

# Ask for TLD name
echo ""
echo "Enter your Handshake root TLD (e.g., example):"
read tld

if [[ $tld == *.* ]]; then
    echo "Error: Root TLD should not contain dots."
    exit 1
fi

echo "You entered: $tld"
echo "Is this correct? (type 'yes' to continue)"
read confirmation

if [ "$confirmation" != "yes" ]; then
    echo "Aborted by user."
    exit 1
fi

echo ""
echo "Setting up nameserver for root TLD: $tld"

# Get server IP addresses
ipv4=$(curl -s -4 ifconfig.me 2>/dev/null || echo "YOUR_IPv4_ADDRESS")
ipv6=$(curl -s -6 ifconfig.me 2>/dev/null || echo "YOUR_IPv6_ADDRESS")

echo "Detected IPv4: $ipv4"
echo "Detected IPv6: $ipv6"

# Install required packages
echo ""
echo "Installing required packages..."
apt update
apt install -y dnsmasq nginx bind9-dnsutils bind9-utils openssl

# Create directories
mkdir -p /var/www/$tld
mkdir -p /etc/dnsmasq.d
mkdir -p /etc/hns
mkdir -p /etc/ssl/hns

# Create website
cat > /var/www/$tld/index.html <<EOF
<!DOCTYPE html>
<html>
<head><title>$tld - Handshake TLD</title></head>
<body>
<h1>Success!</h1>
<p>Your Handshake TLD <strong>$tld</strong> is live with DNSSEC!</p>
<p>IPv4: $ipv4</p>
<p>IPv6: $ipv6</p>
</body>
</html>
EOF

# Generate DNSSEC keys in the working directory
echo ""
echo "Generating DNSSEC keys for $tld..."
cd /etc/hns

# Generate ZSK and KSK - they will be saved in current directory
dnssec-keygen -a ECDSAP256SHA256 -n ZONE $tld
dnssec-keygen -a ECDSAP256SHA256 -f KSK -n ZONE $tld

# List generated keys
echo "Generated keys:"
ls -la K$tld.*

# Generate SSL certificate
echo ""
echo "Generating SSL certificate..."
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout /etc/ssl/hns/$tld.key \
  -out /etc/ssl/hns/$tld.crt \
  -subj "/CN=$tld" \
  -addext "subjectAltName=DNS:$tld,DNS:*.$tld"

chmod 600 /etc/ssl/hns/$tld.key
chmod 644 /etc/ssl/hns/$tld.crt

# Generate TLSA record
tlsa_data=$(openssl x509 -in /etc/ssl/hns/$tld.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | xxd -p -u -c 32)

# Generate serial number (YYYYMMDDNN format)
serial=$(date +%Y%m%d)01

# Create dnsmasq config
cat > /etc/dnsmasq.d/$tld.conf <<EOF
domain=$tld
local=/$tld/
auth-zone=$tld
auth-server=$tld, ns1.$tld
auth-soa=$tld, root.$tld, $serial, 10800, 3600, 604800, 3600

ns-record=$tld, ns1.$tld

host-record=ns1.$tld,$ipv4
host-record=ns1.$tld,$ipv6
host-record=$tld,$ipv4
host-record=$tld,$ipv6

txt-record=_443._tcp.$tld,"3 1 1 $tlsa_data"

conf-file=/etc/dnsmasq.d/$tld-subdomains.conf
EOF

touch /etc/dnsmasq.d/$tld-subdomains.conf

# Create zone file for signing
cat > /etc/hns/$tld.zone <<EOF
\$ORIGIN $tld.
\$TTL 3600
@ IN SOA ns1.$tld. admin.$tld. $serial 10800 3600 604800 3600
@ IN NS ns1.$tld.
ns1 IN A $ipv4
ns1 IN AAAA $ipv6
@ IN A $ipv4
@ IN AAAA $ipv6
_443._tcp IN TLSA 3 1 1 $tlsa_data
EOF

# Sign the zone - let dnssec-signzone find keys automatically!
echo ""
echo "Signing zone with DNSSEC..."
cd /etc/hns

# This is the key line - no explicit keys specified!
# dnssec-signzone will automatically find all K* keys in the current directory
dnssec-signzone -o $tld $tld.zone

if [ ! -f /etc/hns/$tld.zone.signed ]; then
    echo "ERROR: Zone signing failed!"
    exit 1
fi

echo "Zone signed successfully!"

# Configure nginx
cat > /etc/nginx/sites-available/$tld <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $tld;
    root /var/www/$tld;
    index index.html;
    location / { try_files \$uri \$uri/ =404; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $tld;
    root /var/www/$tld;
    index index.html;
    ssl_certificate /etc/ssl/hns/$tld.crt;
    ssl_certificate_key /etc/ssl/hns/$tld.key;
    location / { try_files \$uri \$uri/ =404; }
}
EOF

# Enable site
ln -sf /etc/nginx/sites-available/$tld /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Configure dnsmasq main config
cat > /etc/dnsmasq.conf <<EOF
port=53
domain-needed
bogus-priv
no-resolv
server=8.8.8.8
server=8.8.4.4

dnssec
trust-anchor=.,20326,8,2,E06D44B80B8F1D39A95C0B0D7C65D08458E880409BBC683457104237C7F8EC8D
dnssec-check-unsigned
dnssec-no-timecheck
proxy-dnssec

auth-zone=$tld
auth-soa=$tld, root.$tld, $serial, 10800, 3600, 604800, 3600
auth-sec-servers=ns1.$tld
auth-peer=ns1.$tld

conf-file=/etc/dnsmasq.d/$tld.conf
EOF

# Set permissions
chown -R www-data:www-data /var/www/$tld
chmod -R 755 /var/www/$tld

# Restart services
systemctl stop dnsmasq nginx 2>/dev/null || true
systemctl enable dnsmasq nginx
systemctl start dnsmasq
systemctl start nginx

sleep 2

# Check if services are running
echo ""
echo "Checking services..."
systemctl status dnsmasq --no-pager | head -5
systemctl status nginx --no-pager | head -5

# Output DS records - find KSK automatically
echo ""
echo "============================================="
echo "RECORDS TO ADD TO YOUR HANDSHAKE TLD ($tld)"
echo "============================================="
echo ""

# DS Records - dnssec-dsfromkey also auto-finds keys!
echo "📌 DS RECORDS:"
echo "----------------------------------------"
cd /etc/hns
dnssec-dsfromkey -2 K$tld.*.key | grep -v "IN DS"

echo ""
echo "📌 NS RECORD:"
echo "  $tld IN NS ns1.$tld"
echo ""
echo "📌 GLUE A RECORD:"
echo "  ns1.$tld IN A $ipv4"
echo ""
if [ "$ipv6" != "YOUR_IPv6_ADDRESS" ]; then
    echo "📌 GLUE AAAA RECORD:"
    echo "  ns1.$tld IN AAAA $ipv6"
    echo ""
fi

echo "📌 TLSA RECORD:"
echo "  _443._tcp.$tld IN TLSA 3 1 1 $tlsa_data"
echo ""

echo "============================================="
echo "INSTALLATION COMPLETE!"
echo "============================================="
echo ""
echo "🌐 Website: http://$tld and https://$tld"
echo ""
echo "✅ Test your setup:"
echo "   dig @localhost $tld NS"
echo "   dig @localhost $tld DNSKEY +dnssec"
echo "   dig @localhost _443._tcp.$tld TLSA"
echo ""
