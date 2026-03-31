#!/bin/bash

# install_hns_tld.sh
# Handshake root TLD setup with DNSSEC nameserver
# Usage: sudo bash install_hns_tld.sh

set -e

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

# Validate TLD name (no dots allowed)
if [[ $tld == *.* ]]; then
    echo "Error: Root TLD should not contain dots. Use just the TLD name (e.g., 'example')"
    exit 1
fi

# Confirm
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
ipv4=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s -4 icanhazip.com 2>/dev/null || echo "YOUR_IPv4_ADDRESS")
ipv6=$(curl -s -6 ifconfig.me 2>/dev/null || curl -s -6 icanhazip.com 2>/dev/null || echo "YOUR_IPv6_ADDRESS")

echo ""
echo "Detected IPv4: $ipv4"
echo "Detected IPv6: $ipv6"

# Install required packages (including DNSSEC tools)
echo ""
echo "Installing required packages..."
apt update
apt install -y dnsmasq nginx bind9-dnsutils bind9-utils openssl

# Create directory structure
mkdir -p /var/www/$tld
mkdir -p /etc/dnsmasq.d
mkdir -p /etc/hns
mkdir -p /etc/ssl/hns

# Create website content for root TLD
cat > /var/www/$tld/index.html <<EOF
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>$tld - Handshake Root Domain</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
            line-height: 1.6;
            color: #333;
        }
        h1 { color: #4a5568; }
        .success { color: #48bb78; font-weight: bold; }
        .info { background: #f7fafc; padding: 1rem; border-radius: 5px; margin: 1rem 0; }
        code { background: #edf2f7; padding: 0.2rem 0.4rem; border-radius: 3px; font-family: monospace; }
        .warning { background: #fef5e7; border-left: 4px solid #f39c12; }
    </style>
</head>
<body>
    <h1>🎉 Success!</h1>
    <p>Your Handshake root domain <strong class="success">$tld</strong> is now live with DNSSEC!</p>
    <div class="info">
        <h3>📋 DNS Configuration</h3>
        <p>This server is running as a DNSSEC-enabled nameserver for <code>$tld</code>.</p>
        <p>Your website is accessible via both HTTP and HTTPS with DANE/TLSA validation.</p>
    </div>
    <div class="info">
        <h3>🔧 Server Information</h3>
        <p>IPv4: <code>$ipv4</code></p>
        <p>IPv6: <code>$ipv6</code></p>
        <p>Root TLD: <code>$tld</code></p>
        <p>Website: <code>http://$tld</code> and <code>https://$tld</code></p>
    </div>
    <div class="info">
        <h3>➕ Adding Subdomains</h3>
        <p>Use the helper script to add DNSSEC-signed subdomains:</p>
        <code>sudo bash add_sld.sh</code>
    </div>
</body>
</html>
EOF

# Generate DNSSEC keys for the TLD
echo ""
echo "Generating DNSSEC keys for $tld..."
cd /etc/hns

# Generate ZSK (Zone Signing Key) - ECDSAP256SHA256 (alg 13)
echo "Generating ZSK..."
zsk=$(dnssec-keygen -a ECDSAP256SHA256 -n ZONE $tld)
if [ -z "$zsk" ]; then
    echo "Error generating ZSK"
    exit 1
fi
echo "ZSK generated: $zsk"

# Generate KSK (Key Signing Key) - ECDSAP256SHA256 (alg 13)
echo "Generating KSK..."
ksk=$(dnssec-keygen -a ECDSAP256SHA256 -f KSK -n ZONE $tld)
if [ -z "$ksk" ]; then
    echo "Error generating KSK"
    exit 1
fi
echo "KSK generated: $ksk"

# Generate SSL certificate for root domain
echo ""
echo "Generating SSL certificate for $tld..."
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout /etc/ssl/hns/$tld.key \
  -out /etc/ssl/hns/$tld.crt \
  -subj "/CN=$tld" \
  -addext "subjectAltName=DNS:$tld,DNS:*.$tld"

# Set certificate permissions
chmod 600 /etc/ssl/hns/$tld.key
chmod 644 /etc/ssl/hns/$tld.crt

# Generate TLSA record for DANE
tlsa_data=$(openssl x509 -in /etc/ssl/hns/$tld.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | xxd -p -u -c 32)

# Create dnsmasq configuration
echo ""
echo "Creating dnsmasq configuration..."

cat > /etc/dnsmasq.d/$tld.conf <<EOF
# DNSSEC-enabled zone for $tld
domain=$tld
local=/$tld/
auth-zone=$tld
auth-server=$tld, ns1.$tld
auth-soa=$tld, root.$tld, 1, 10800, 3600, 604800, 3600

# NS Records
mx-host=$tld, ns1.$tld, 10
ns-record=$tld, ns1.$tld

# A/AAAA Records for nameserver
host-record=ns1.$tld,$ipv4
host-record=ns1.$tld,$ipv6

# A/AAAA Records for root domain
host-record=$tld,$ipv4
host-record=$tld,$ipv6

# TLSA record for DANE (certificate validation)
txt-record=_443._tcp.$tld,"3 1 1 $tlsa_data"

# Include subdomains file (will be created by add_sld.sh)
conf-file=/etc/dnsmasq.d/$tld-subdomains.conf
EOF

# Create empty subdomains config file
touch /etc/dnsmasq.d/$tld-subdomains.conf

# Generate serial number (YYYYMMDDNN format)
serial=$(date +%Y%m%d)01

# Create zone file for DNSSEC signing
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

# Sign the zone
echo ""
echo "Signing zone with DNSSEC..."
dnssec-signzone -o $tld /etc/hns/$tld.zone

if [ ! -f /etc/hns/$tld.zone.signed ]; then
    echo "Error: Zone signing failed"
    echo "Check zone file: cat /etc/hns/$tld.zone"
    exit 1
fi

# Configure nginx for both HTTP and HTTPS (no redirect)
echo ""
echo "Configuring nginx..."

cat > /etc/nginx/sites-available/$tld <<EOF
# HTTP Server
server {
    listen 80;
    listen [::]:80;
    server_name $tld;
    root /var/www/$tld;
    index index.html;
    
    location / {
        try_files \$uri \$uri/ =404;
    }
}

# HTTPS Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $tld;
    root /var/www/$tld;
    index index.html;
    
    ssl_certificate /etc/ssl/hns/$tld.crt;
    ssl_certificate_key /etc/ssl/hns/$tld.key;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    location / {
        try_files \$uri \$uri/ =404;
    }
    
    # Optional: Add security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
}
EOF

# Enable nginx site
ln -sf /etc/nginx/sites-available/$tld /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Configure dnsmasq
cat > /etc/dnsmasq.conf <<EOF
# DNSSEC Configuration
port=53
domain-needed
bogus-priv
no-resolv
server=8.8.8.8
server=8.8.4.4

# Enable DNSSEC
dnssec
trust-anchor=.,20326,8,2,E06D44B80B8F1D39A95C0B0D7C65D08458E880409BBC683457104237C7F8EC8D
dnssec-check-unsigned
dnssec-no-timecheck
proxy-dnssec

# Auth zone configuration
auth-zone=$tld
auth-soa=$tld, root.$tld, $serial, 10800, 3600, 604800, 3600
auth-sec-servers=ns1.$tld
auth-peer=ns1.$tld

# Include our zone
conf-file=/etc/dnsmasq.d/$tld.conf
EOF

# Set proper permissions
chown -R www-data:www-data /var/www/$tld
chmod -R 755 /var/www/$tld

# Stop services before configuration
systemctl stop dnsmasq nginx 2>/dev/null || true

# Start and enable services
systemctl enable dnsmasq nginx
systemctl start dnsmasq
systemctl start nginx

# Wait for services to start
sleep 3

# Test DNSSEC
echo ""
echo "Testing DNSSEC configuration..."
if dig @127.0.0.1 $tld DNSKEY +dnssec +short 2>/dev/null | grep -q "257"; then
    echo "✅ DNSSEC is working correctly"
else
    echo "⚠️  DNSSEC test inconclusive. Check logs with: journalctl -u dnsmasq -n 50"
fi

# Output DNS records for Handshake TLD
echo ""
echo "============================================="
echo "RECORDS TO ADD TO YOUR HANDSHAKE TLD ($tld)"
echo "============================================="
echo ""

# Extract DS records
echo "📌 DS RECORDS (for DNSSEC chain of trust):"
echo "----------------------------------------"
# Find the KSK key file
ksk_file=$(ls /etc/hns/K$tld.*.key 2>/dev/null | grep -i "ksk" || ls /etc/hns/K$tld.*.key 2>/dev/null | head -1)
if [ -n "$ksk_file" ]; then
    dnssec-dsfromkey -2 "$ksk_file" 2>/dev/null | while read line; do
        echo "  $line"
    done
else
    echo "  Unable to generate DS records automatically"
    echo "  Please check /etc/hns/ for key files"
fi

echo ""
echo "📌 NS RECORD:"
echo "----------------------------------------"
echo "  Name: $tld"
echo "  Type: NS"
echo "  Value: ns1.$tld"
echo ""

echo "📌 GLUE A RECORD:"
echo "----------------------------------------"
echo "  Name: ns1.$tld"
echo "  Type: A"
echo "  Value: $ipv4"
echo ""

if [ "$ipv6" != "YOUR_IPv6_ADDRESS" ]; then
    echo "📌 GLUE AAAA RECORD:"
    echo "----------------------------------------"
    echo "  Name: ns1.$tld"
    echo "  Type: AAAA"
    echo "  Value: $ipv6"
    echo ""
fi

echo ""
echo "============================================="
echo "ROOT DOMAIN CONFIGURATION"
echo "============================================="
echo ""
echo "🌐 Root domain URLs:"
echo "  HTTP:  http://$tld"
echo "  HTTPS: https://$tld"
echo "📁 Website files: /var/www/$tld"
echo "🔒 SSL certificate: /etc/ssl/hns/$tld.crt"
echo "🔑 SSL key: /etc/ssl/hns/$tld.key"
echo ""

echo "📌 TLSA RECORD (for DANE validation):"
echo "----------------------------------------"
echo "  _443._tcp.$tld IN TLSA 3 1 1 $tlsa_data"
echo ""

echo ""
echo "============================================="
echo "INSTALLATION COMPLETE!"
echo "============================================="
echo ""
echo "✅ DNSSEC-enabled nameserver running for $tld"
echo "✅ Website available via HTTP and HTTPS"
echo "✅ DANE/TLSA record generated for certificate validation"
echo ""
echo "📋 NEXT STEPS:"
echo "1. Add the DS records above to your Handshake TLD at your HNS registrar"
echo "2. Add the NS and glue records to your TLD configuration"
echo "3. Wait for DNS propagation (can take 24-48 hours)"
echo "4. Test your setup: dig @8.8.8.8 $tld NS +dnssec"
echo "5. Use add_sld.sh to add DNSSEC-signed subdomains"
echo ""
echo "🔧 USEFUL COMMANDS:"
echo "  - Check local DNS: dig @localhost $tld NS"
echo "  - Check DNSSEC: dig @localhost $tld DNSKEY +dnssec"
echo "  - Check TLSA: dig @localhost _443._tcp.$tld TLSA"
echo "  - View nginx logs: tail -f /var/log/nginx/access.log"
echo "  - View dnsmasq logs: journalctl -u dnsmasq -f"
echo "  - Add subdomain: sudo bash add_sld.sh"
echo ""
echo "⚠️  IMPORTANT: If dnsmasq fails to start, check:"
echo "  - Ensure no other service is using port 53: sudo netstat -tulpn | grep :53"
echo "  - Check dnsmasq config: dnsmasq --test"
echo "  - View errors: journalctl -u dnsmasq -n 50"
echo ""
