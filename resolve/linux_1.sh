#!/bin/bash
# HNS DNS Installer - Super fast setup

echo "🚀 Setting up custom DNS resolvers..."

# Make resolv.conf writable and set the nameservers
sudo bash -c 'cat > /etc/resolv.conf << "EOF"
nameserver 82.68.70.162
nameserver 82.68.70.163
nameserver 8.8.8.8
EOF'

# Optional: make it immutable so NetworkManager/systemd doesn't overwrite it immediately
sudo chattr +i /etc/resolv.conf 2>/dev/null || true

# Super simple animated progress bar (fast & pretty)
echo -n "Applying changes "
for i in {1..20}; do
    echo -n "█"
    sleep 0.03
done
echo " ✅ Done!"

echo ""
echo "🎉 Congratulations! Your DNS is now configured."
echo ""
echo "You can now visit domains using these formats:"
echo ""
echo "   Bare TLD:     http://tld./"
echo "                 https://tld./"
echo ""
echo "   Second-level: http://sld.tld/"
echo "                 https://sld.tld/"
echo ""
echo "Don't forget the trailing slash (/) after the domain!"
echo ""
echo "Example:"
echo "   http://example./"
echo "   http://sub.example./"
echo ""
echo "Enjoy your new DNS setup! 🚀"
