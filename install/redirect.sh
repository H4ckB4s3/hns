#!/bin/bash

# redirect.sh
# Automated nginx redirect with SSL 
# Usage: bash <(curl -s https://hns.onl/install/redirect.sh)

echo "=== nginx Domain Setup ==="

# Ask for domain
echo "Enter domain name (the domain being set up on this server):"
read domain

# Ask for redirect domain
echo "Enter redirect domain (the domain to redirect to):"
read redirect_domain

# Confirm before proceeding
echo ""
echo "Configuration summary:"
echo "  - Setup domain: $domain"
echo "  - Redirect to: https://$redirect_domain/"
echo ""
echo "Is this correct? (type 'yes' and press Enter to continue)"
read confirmation

if [ "$confirmation" != "yes" ]; then
    echo "Aborted by user."
    exit 1
fi

echo "Starting installation for domain: $domain (redirecting to $redirect_domain)"

# Create directory and set permissions
sudo mkdir -p /var/www/$domain
cd /var/www/$domain

# Create index.html with the redirect domain
sudo tee index.html > /dev/null <<EOF
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Redirecting to $redirect_domain</title>
    <link rel="canonical" href="https://$redirect_domain/">
    <meta http-equiv="refresh" content="0; url=https://$redirect_domain/">
    <script>
        if (window.location.replace) {
            window.location.replace("https://$redirect_domain/");
        }
    </script>
</head>
<body>
    <p>Redirecting to <a href="https://$redirect_domain/">$redirect_domain</a>...</p>
</body>
</html>
EOF

# Set proper permissions
sudo chown -R $USER:$USER /var/www/$domain
sudo chmod -R 755 /var/www/$domain

# Install nginx
sudo apt update
sudo apt install nginx -y

# Setup NGINX config
sudo tee /etc/nginx/sites-available/$domain > /dev/null <<EOF
server {
  listen 80;
  listen [::]:80;
  root /var/www/$domain;
  index index.html;
  server_name $domain *.$domain;

    location / {
        try_files \$uri \$uri/ @htmlext;
    }

    location ~ \.html$ {
        try_files \$uri =404;
    }

    location @htmlext {
        rewrite ^(.*)$ \$1.html last;
    }
    error_page 404 /404.html;
    location = /404.html {
            internal;
    }
    location = /.well-known/wallets/HNS {
        add_header Cache-Control 'must-revalidate';
        add_header Content-Type text/plain;
    }
    listen 443 ssl;
    ssl_certificate /etc/ssl/$domain.crt;
    ssl_certificate_key /etc/ssl/$domain.key;
}
EOF

# Enable site
sudo ln -sf /etc/nginx/sites-available/$domain /etc/nginx/sites-enabled/

# Remove default site if exists
sudo rm -f /etc/nginx/sites-enabled/default

# Generate SSL certificate
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout cert.key -out cert.crt -extensions ext -config \
  <(echo "[req]";
    echo distinguished_name=req;
    echo "[ext]";
    echo "keyUsage=critical,digitalSignature,keyEncipherment";
    echo "extendedKeyUsage=serverAuth";
    echo "basicConstraints=critical,CA:FALSE";
    echo "subjectAltName=DNS:$domain,DNS:*.$domain";
    ) -subj "/CN=*.$domain"

# Get TLSA data
tlsa_data=$(openssl x509 -in cert.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | xxd -p -u -c 32)

# Determine NAME for A and AAAA records
if [[ $domain == *.* ]]; then
    # Domain has a dot, use part before the first dot
    dns_name=$(echo "$domain" | cut -d'.' -f1)
else
    # No dot detected, use @
    dns_name="@"
fi

# Get server IP addresses
ipv4=$(curl -s -4 ifconfig.me 2>/dev/null || echo "YOUR_IPv4_ADDRESS")
ipv6=$(curl -s -6 ifconfig.me 2>/dev/null || echo "YOUR_IPv6_ADDRESS")

# Print DNS records
echo "Add these Records to your DNS:"
echo "-------------"
echo "TYPE: A"
echo "NAME: $dns_name"
echo "VALUE/DATA: $ipv4"
echo "-------------"
echo "TYPE: AAAA"
echo "NAME: $dns_name"
echo "VALUE/DATA: $ipv6"
echo "-------------"
echo "TYPE: TLSA"
echo "NAME: _443._tcp"
echo "VALUE/DATA:"
echo "3 1 1 $tlsa_data"
echo "-------------"

# Add extra TLSA record if domain contains a dot
if [[ $domain == *.* ]]; then
    # Use part before the dot for the TLSA record name
    tlsa_name_part=$(echo "$domain" | cut -d'.' -f1)
    echo "TYPE: TLSA"
    echo "NAME: _443._tcp.$tlsa_name_part"
    echo "VALUE/DATA:"
    echo "3 1 1 $tlsa_data"
    echo "-------------"
fi

echo "TYPE: TLSA"
echo "NAME: *"
echo "VALUE/DATA:"
echo "3 1 1 $tlsa_data"
echo "-------------"

# Move certificates
sudo mv cert.key /etc/ssl/$domain.key
sudo mv cert.crt /etc/ssl/$domain.crt

# Set certificate permissions
sudo chmod 600 /etc/ssl/$domain.key
sudo chmod 644 /etc/ssl/$domain.crt

# Test nginx configuration
sudo nginx -t

# Restart to apply config file
sudo systemctl restart nginx

echo ""
echo "Installation completed!"
echo "  - Setup domain: $domain"
echo "  - Redirecting to: https://$redirect_domain/"
echo "  - Website directory: /var/www/$domain"
echo "  - Nginx config: /etc/nginx/sites-available/$domain"
