#!/bin/bash

# install_hns_tld.sh
# Combined working approach from install.sh and handout
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
mkdir -p /etc/ssl

# Create website content
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
        code { background: #edf2f7; padding: 0.2rem 0.4rem; border-radius: 3px; }
    </style>
</head>
<body>
    <h1>🎉 Success!</h1>
    <p>Your Handshake root domain <strong class="success">$tld</strong> is now live with DNSSEC!</p>
    <div class="info">
        <h3>📋 DNS Configuration</h3>
        <p>This server is running as a DNSSEC-enabled nameserver for <code>$tld</code>.</p>
        <p>Your website is accessible via both HTTP and HTTPS.</p>
    </div>
    <div class="info">
        <h3>🔧 Server Information</h3>
        <p>IPv4: <code>$ipv4</code></p>
        <p>IPv6: <code>$ipv6</code></p>
        <p>Root TLD: <code>$tld</code></p>
        <p>Website: <code>http://$tld</code> and <code>https://$tld</code></p>
    </div>
</body>
</html>
EOF

# Generate SSL certificate (using the working method from install.sh)
echo ""
echo "Generating SSL certificate..."
cd /tmp
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout cert.key -out cert.crt -extensions ext -config \
  <(echo "[req]";
    echo distinguished_name=req;
    echo "[ext]";
    echo "keyUsage=critical,digitalSignature,keyEncipherment";
    echo "extendedKeyUsage=serverAuth";
    echo "basicConstraints=critical,CA:FALSE";
    echo "subjectAltName=DNS:$tld,DNS:*.$tld";
    ) -subj "/CN=*.$tld"

# Move certificates
mv cert.key /etc/ssl/$tld.key
mv cert.crt /etc/ssl/$tld.crt
chmod 600 /etc/ssl/$tld.key
chmod 644 /etc/ssl/$tld.crt

# Get TLSA data (working method from install.sh)
tlsa_data=$(openssl x509 -in /etc/ssl/$tld.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | xxd -p -u -c 32)

# Generate DNSSEC keys (handout method)
echo ""
echo "Generating DNSSEC keys for $tld..."
cd /etc/hns

# Generate ZSK and KSK
dnssec-keygen -a ECDSAP256SHA256 -n ZONE $tld
dnssec-keygen -a ECDSAP256SHA256 -f KSK -n ZONE $tld

echo "Keys generated:"
ls -la K$tld.*

# Generate serial number
serial=$(date +%Y%m%d)01

# Create dnsmasq config
cat > /etc/dnsmasq.d/$tld.conf <<EOF
# DNSSEC-enabled zone for $tld
domain=$tld
local=/$tld/
auth-zone=$tld
auth-server=$tld, ns1.$tld
auth-soa=$tld, root.$tld, $serial, 10800, 3600, 604800, 3600

# NS Records
ns-record=$tld, ns1.$tld

# A/AAAA Records for nameserver
host-record=ns1.$tld,$ipv4
host-record=ns1.$tld,$ipv6

# A/AAAA Records for root domain
host-record=$tld,$ipv4
host-record=$tld,$ipv6

# TLSA record for DANE
txt-record=_443._tcp.$tld,"3 1 1 $tlsa_data"

# Include subdomains file
conf-file=/etc/dnsmasq.d/$tld-subdomains.conf
EOF

touch /etc/dnsmasq.d/$tld-subdomains.conf

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

# Sign the zone (handout method - let it find keys automatically)
echo ""
echo "Signing zone with DNSSEC..."
cd /etc/hns
dnssec-signzone -o $tld $tld.zone

if [ ! -f /etc/hns/$tld.zone.signed ]; then
    echo "ERROR: Zone signing failed!"
    echo "Attempting with explicit keys..."
    # Fallback: try with explicit keys
    zsk_file=$(ls K$tld.*.key | grep -v KSK | head -1)
    ksk_file=$(ls K$tld.*.key | grep KSK | head -1)
    dnssec-signzone -o $tld -k $ksk_file $tld.zone $zsk_file
    
    if [ ! -f /etc/hns/$tld.zone.signed ]; then
        echo "ERROR: Zone signing still failed!"
        exit 1
    fi
fi

echo "Zone signed successfully!"

# Configure nginx (both HTTP and HTTPS, no redirect)
cat > /etc/nginx/sites-available/$tld <<EOF
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

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $tld;
    root /var/www/$tld;
    index index.html;
    
    ssl_certificate /etc/ssl/$tld.crt;
    ssl_certificate_key /etc/ssl/$tld.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF

# Enable nginx site
ln -sf /etc/nginx/sites-available/$tld /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Configure dnsmasq
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

sleep 3

# Test nginx
nginx -t

# Output DNS records (handout method for DS records)
echo ""
echo "============================================="
echo "RECORDS TO ADD TO YOUR HANDSHAKE TLD ($tld)"
echo "============================================="
echo ""

# DS Records using handout method
echo "📌 DS RECORDS (add these to your HNS TLD):"
echo "----------------------------------------"
cd /etc/hns
for key in K$tld.*.key; do
    if [[ $key == *"KSK"* ]]; then
        dnssec-dsfromkey -2 "$key" 2>/dev/null | grep -v "^;"
    fi
done

echo ""
echo "📌 NS RECORD:"
echo "----------------------------------------"
echo "  $tld IN NS ns1.$tld"
echo ""
echo "📌 GLUE A RECORD:"
echo "----------------------------------------"
echo "  ns1.$tld IN A $ipv4"
echo ""
if [ "$ipv6" != "YOUR_IPv6_ADDRESS" ]; then
    echo "📌 GLUE AAAA RECORD:"
    echo "----------------------------------------"
    echo "  ns1.$tld IN AAAA $ipv6"
    echo ""
fi

echo "📌 TLSA RECORD (for DANE):"
echo "----------------------------------------"
echo "  _443._tcp.$tld IN TLSA 3 1 1 $tlsa_data"
echo ""

echo ""
echo "============================================="
echo "INSTALLATION COMPLETE!"
echo "============================================="
echo ""
echo "🌐 Website URLs:"
echo "  HTTP:  http://$tld"
echo "  HTTPS: https://$tld"
echo ""
echo "📁 Website directory: /var/www/$tld"
echo "🔒 SSL certificate: /etc/ssl/$tld.crt"
echo "🔑 SSL key: /etc/ssl/$tld.key"
echo ""
echo "✅ Test commands:"
echo "  dig @localhost $tld NS"
echo "  dig @localhost $tld DNSKEY +dnssec"
echo "  dig @localhost _443._tcp.$tld TLSA"
echo "  curl -k https://$tld"
echo ""
echo "📋 To add subdomains later:"
echo "  Edit /etc/dnsmasq.d/$tld-subdomains.conf"
echo "  Add: host-record=subdomain.$tld,$ipv4"
echo "  Then: systemctl restart dnsmasq"
echo ""
