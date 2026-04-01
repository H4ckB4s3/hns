#!/bin/bash
# HNS DNS Installer - Fast & Reliable

echo "Setting up HNS custom DNS resolvers..."

# === Step 1: Disable services that overwrite resolv.conf ===
sudo systemctl stop systemd-resolved 2>/dev/null || true
sudo systemctl disable systemd-resolved 2>/dev/null || true

# Tell NetworkManager not to manage DNS (if present)
if [ -f /etc/NetworkManager/NetworkManager.conf ]; then
    sudo sed -i '/\[main\]/a dns=none' /etc/NetworkManager/NetworkManager.conf 2>/dev/null || true
    sudo systemctl restart NetworkManager 2>/dev/null || true
fi

# === Step 2: Write the DNS configuration ===
sudo bash -c 'cat > /etc/resolv.conf << "EOF"
nameserver 82.68.70.162
nameserver 82.68.70.163
nameserver 1.1.1.1
nameserver 8.8.8.8
options edns0
EOF'

# Make it immutable so it doesn't get overwritten
sudo chattr +i /etc/resolv.conf 2>/dev/null || true

# === Nice fast progress bar ===
echo -n "Applying DNS settings "
for i in {1..25}; do
    echo -n "█"
    sleep 0.025
done
echo " ✅ Done!"

echo ""
echo "🎉 Congratulations! Your system is now using the custom HNS DNS."
echo ""
echo "You can now visit domains like this:"
echo ""
echo "   Bare TLD:      http://tld./"
echo ""
echo "   Second-level:  http://sld.tld/"
echo ""
echo "⚠️  Important: Always include the trailing slash / after the domain if you don't type the http://!"
echo ""
echo "Examples:"
echo "   → http://hackbases/"
echo "   → http://ecosystem.hackbase/"
echo "   → http://hackbase.profile"
echo ""
echo "Enjoy browsing with the whole web!"
echo ""
