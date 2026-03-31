#!/bin/bash

# add_sld.sh
# Add DNSSEC-signed subdomains to existing Handshake TLD
# Usage: sudo bash add_sld.sh

set -e

echo "============================================="
echo "Add DNSSEC-Signed Subdomain to Handshake TLD"
echo "============================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Please run as root (use sudo)"
    exit 1
fi

# Find existing TLD configuration
tld_config=$(ls /etc/dnsmasq.d/*.conf 2>/dev/null | grep -v subdomains | head -1)
if [ -z "$tld_config" ]; then
    echo "Error: No existing TLD configuration found."
    echo "Please run install_hns_tld.sh first."
    exit 1
fi

# Extract TLD name from config file
tld=$(basename "$tld_config" .conf)
echo "Detected TLD: $tld"

# Ask for subdomain name
echo ""
echo "Enter subdomain name (e.g., www, blog, api):"
read subdomain

# Validate subdomain name
if [[ $subdomain == *.* ]]; then
    echo "Error: Subdomain should not contain dots. Use just the subdomain name."
    exit 1
fi

full_domain="$subdomain.$tld"

# Confirm
echo "You entered: $full_domain"
echo "Is this correct? (type 'yes' to continue)"
read confirmation

if [ "$confirmation" != "yes" ]; then
    echo "Aborted by user."
    exit 1
fi

# Get server IP addresses (use same as main TLD)
ipv4=$(grep "host-record=$tld," /etc/dnsmasq.d/$tld.conf | head -1 | cut -d',' -f2 | xargs)
ipv6=$(grep "host-record=$tld," /etc/dnsmasq.d/$tld.conf | tail -1 | cut -d',' -f2 | xargs)

if [ -z "$ipv4" ]; then
    ipv4=$(curl -s -4 ifconfig.me 2>/dev/null || echo "YOUR_IPv4_ADDRESS")
fi
if [ -z "$ipv6" ]; then
    ipv6=$(curl -s -6 ifconfig.me 2>/dev/null || echo "YOUR_IPv6_ADDRESS")
fi

echo ""
echo "Using IP addresses:"
echo "  IPv4: $ipv4"
echo "  IPv6: $ipv6"

# Ask if subdomain should have its own website
echo ""
echo "Should $full_domain have its own website?"
echo "Options:"
echo "  1) Yes - Create separate website directory"
echo "  2) No - Use same website as root domain"
read -p "Enter choice (1 or 2): " website_choice

if [ "$website_choice" = "1" ]; then
    # Create separate website directory
    mkdir -p /var/www/$full_domain
    
    # Create index page
    cat > /var/www/$full_domain/index.html <<EOF
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>$full_domain - Handshake Subdomain</title>
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
    </style>
</head>
<body>
    <h1>🎉 Subdomain Success!</h1>
    <p>Your Handshake subdomain <strong class="success">$full_domain</strong> is now live with DNSSEC!</p>
    <div class="info">
        <h3>📋 DNS Configuration</h3>
        <p>This subdomain is served with DNSSEC validation.</p>
        <p>Website accessible via: <a href="http://$full_domain">http://$full_domain</a> and <a href="https://$full_domain">https://$full_domain</a></p>
    </div>
    <div class="info">
        <h3>🔧 Server Information</h3>
        <p>IPv4: <code>$ipv4</code></p>
        <p>IPv6: <code>$ipv6</code></p>
        <p>TLD: <code>$tld</code></p>
        <p>Subdomain: <code>$full_domain</code></p>
    </div>
</body>
</html>
EOF
    
    # Generate SSL certificate for subdomain
    echo ""
    echo "Generating SSL certificate for $full_domain..."
    openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
      -keyout /etc/ssl/hns/$full_domain.key \
      -out /etc/ssl/hns/$full_domain.crt \
      -subj "/CN=$full_domain" \
      -addext "subjectAltName=DNS:$full_domain"
    
    chmod 600 /etc/ssl/hns/$full_domain.key
    chmod 644 /etc/ssl/hns/$full_domain.crt
    
    # Generate TLSA record
    tlsa_data=$(openssl x509 -in /etc/ssl/hns/$full_domain.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | xxd -p -u -c 32)
    
    # Add nginx configuration for subdomain
    cat > /etc/nginx/sites-available/$full_domain <<EOF
# HTTP Server for $full_domain
server {
    listen 80;
    listen [::]:80;
    server_name $full_domain;
    root /var/www/$full_domain;
    index index.html;
    
    location / {
        try_files \$uri \$uri/ =404;
    }
}

# HTTPS Server for $full_domain
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $full_domain;
    root /var/www/$full_domain;
    index index.html;
    
    ssl_certificate /etc/ssl/hns/$full_domain.crt;
    ssl_certificate_key /etc/ssl/hns/$full_domain.key;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    location / {
        try_files \$uri \$uri/ =404;
    }
    
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
}
EOF
    
    # Enable nginx site
    ln -sf /etc/nginx/sites-available/$full_domain /etc/nginx/sites-enabled/
    
    # Set permissions
    chown -R www-data:www-data /var/www/$full_domain
    chmod -R 755 /var/www/$full_domain
    
    website_configured=true
else
    website_configured=false
    # For TLSA, still need certificate but can reuse root or create without website
    echo ""
    echo "Generating SSL certificate for $full_domain (DANE only)..."
    openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
      -keyout /etc/ssl/hns/$full_domain.key \
      -out /etc/ssl/hns/$full_domain.crt \
      -subj "/CN=$full_domain" \
      -addext "subjectAltName=DNS:$full_domain"
    
    chmod 600 /etc/ssl/hns/$full_domain.key
    chmod 644 /etc/ssl/hns/$full_domain.crt
    
    tlsa_data=$(openssl x509 -in /etc/ssl/hns/$full_domain.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | xxd -p -u -c 32)
fi

# Add DNS records to dnsmasq
echo ""
echo "Adding DNS records to dnsmasq configuration..."

# Backup subdomains config
cp /etc/dnsmasq.d/$tld-subdomains.conf /etc/dnsmasq.d/$tld-subdomains.conf.bak

# Add records
cat >> /etc/dnsmasq.d/$tld-subdomains.conf <<EOF

# Subdomain: $full_domain (added $(date))
host-record=$full_domain,$ipv4
host-record=$full_domain,$ipv6
txt-record=_443._tcp.$full_domain,"3 1 1 $tlsa_data"
EOF

# Add to zone file for DNSSEC signing
cat >> /etc/hns/$tld.zone <<EOF
$subdomain IN A $ipv4
$subdomain IN AAAA $ipv6
_443._tcp.$subdomain IN TLSA 3 1 1 $tlsa_data
EOF

# Resign the zone
echo ""
echo "Resigning zone with DNSSEC..."
cd /etc/hns
dnssec-signzone -o $tld -k $(ls K$tld.*+013+*.key | grep KSK) /etc/hns/$tld.zone $(ls K$tld.*+013+*.key | grep -v KSK)

# Restart dnsmasq
systemctl restart dnsmasq

# Restart nginx if website was configured
if [ "$website_configured" = true ]; then
    systemctl restart nginx
fi

# Output DNS records
echo ""
echo "============================================="
echo "SUBDOMAIN ADDED SUCCESSFULLY!"
echo "============================================="
echo ""
echo "🌐 Subdomain: $full_domain"
echo ""

echo "📌 DNS RECORDS TO ADD (if using external DNS):"
echo "----------------------------------------"
echo "A Record:"
echo "  Name: $subdomain"
echo "  Type: A"
echo "  Value: $ipv4"
echo ""
echo "AAAA Record:"
echo "  Name: $subdomain"
echo "  Type: AAAA"
echo "  Value: $ipv6"
echo ""
echo "TLSA Record (for DANE):"
echo "  Name: _443._tcp.$subdomain"
echo "  Type: TLSA"
echo "  Value: 3 1 1 $tlsa_data"
echo ""

if [ "$website_configured" = true ]; then
    echo "🌐 Website URLs:"
    echo "  HTTP:  http://$full_domain"
    echo "  HTTPS: https://$full_domain"
    echo "📁 Website directory: /var/www/$full_domain"
else
    echo "ℹ️  No website configured for this subdomain (DNS only)"
    echo "   The subdomain will resolve but serve the default nginx page"
fi

echo ""
echo "🔧 Verification commands:"
echo "  - Test DNS: dig @localhost $full_domain A +dnssec"
echo "  - Test TLSA: dig @localhost _443._tcp.$full_domain TLSA +dnssec"
echo "  - Test from outside: dig @8.8.8.8 $full_domain A +dnssec"
echo ""
echo "✅ Subdomain $full_domain is now live with DNSSEC!"
