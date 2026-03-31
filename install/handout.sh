#!/bin/bash

# Zipkin's Handout Install Script
# Installs and configures Handout DNS/Webserver for Handshake domains

set -e  # Exit on error

# Colors for pretty output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}   Zipkin's Handout Installer v1.0     ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Ask for TLD
echo -e "${YELLOW}Please enter your Handshake TLD (domain name):${NC}"
echo -e "${YELLOW}Example: examplename (without trailing dot)${NC}"
read -p "TLD: " TLD

# Validate TLD
if [ -z "$TLD" ]; then
    echo -e "${RED}Error: TLD cannot be empty${NC}"
    exit 1
fi

# Auto-detect IP address
echo ""
echo -e "${GREEN}Auto-detecting server IP address...${NC}"
# Try to get the primary non-loopback IPv4 address
IP_ADDRESS=$(ip -4 addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -n1)

if [ -z "$IP_ADDRESS" ]; then
    # Fallback: try hostname -I
    IP_ADDRESS=$(hostname -I | awk '{print $1}')
fi

if [ -z "$IP_ADDRESS" ]; then
    # Final fallback: use 0.0.0.0 (listen on all interfaces)
    IP_ADDRESS="0.0.0.0"
    echo -e "${YELLOW}Warning: Could not detect IP address. Using 0.0.0.0 (all interfaces)${NC}"
else
    echo -e "${GREEN}Detected IP address: ${YELLOW}$IP_ADDRESS${NC}"
fi

# Show summary and ask for confirmation
echo ""
echo -e "${GREEN}Installation Summary:${NC}"
echo -e "  TLD: ${YELLOW}$TLD${NC}"
echo -e "  IP Address: ${YELLOW}$IP_ADDRESS${NC}"
echo -e "  Install Path: ${YELLOW}$(pwd)/handout${NC}"
echo ""
echo -e "${RED}WARNING: This will install Node.js, npm, and clone the Handout repository.${NC}"
echo -e "${YELLOW}Do you want to proceed? (y/N)${NC}"
read -p "> " CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${RED}Installation cancelled.${NC}"
    exit 0
fi

echo ""
echo -e "${GREEN}Starting installation...${NC}"

# Update apt
echo -e "${GREEN}[1/9] Updating package lists...${NC}"
sudo apt update

# Install dependencies
echo -e "${GREEN}[2/9] Installing build dependencies...${NC}"
sudo apt install -y build-essential python3 libunbound-dev python-is-python3

# Install Node.js and npm
echo -e "${GREEN}[3/9] Installing Node.js and npm...${NC}"
sudo apt install -y nodejs npm

# Set global npm path
echo -e "${GREEN}[4/9] Configuring npm global path...${NC}"
export NODE_PATH=`npm root -g`
if ! grep -q "NODE_PATH" ~/.profile; then
    echo 'export NODE_PATH=`npm root -g`' >> ~/.profile
    echo -e "${GREEN}Added NODE_PATH to ~/.profile${NC}"
fi

# Install n (Node version manager)
echo -e "${GREEN}[5/9] Installing Node version manager...${NC}"
sudo npm install -g n

# Install Node.js LTS
echo -e "${GREEN}[6/9] Installing Node.js LTS...${NC}"
sudo n lts

# Install node-gyp
echo -e "${GREEN}[7/9] Installing node-gyp...${NC}"
sudo npm install -g node-gyp

# Clone Handout repository
echo -e "${GREEN}[8/9] Cloning Handout repository...${NC}"
if [ -d "handout" ]; then
    echo -e "${YELLOW}Handout directory already exists. Removing...${NC}"
    rm -rf handout
fi
git clone https://github.com/pinheadmz/handout
cd handout

# Install npm dependencies
echo -e "${GREEN}[9/9] Installing npm dependencies...${NC}"
npm install

# Generate configuration with the provided TLD and auto-detected IP
echo ""
echo -e "${GREEN}Generating configuration for $TLD...${NC}"
node scripts/hnssec-gen.js "$TLD" "$IP_ADDRESS"

# Print success message
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}   Installation Complete!              ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}IMPORTANT NEXT STEPS:${NC}"
echo ""
echo -e "1. ${GREEN}BACKUP YOUR CONF DIRECTORY:${NC}"
echo -e "   The conf/ directory contains your DNSSEC private keys!"
echo -e "   Backup it immediately: cp -r conf conf.backup"
echo ""
echo -e "2. ${GREEN}Update your Handshake domain:${NC}"
echo -e "   Use the JSON output above with Bob or hsd:"
echo -e "   hsw-rpc sendupdate $TLD '<json-output>'"
echo ""
echo -e "3. ${GREEN}Run the server:${NC}"
echo -e "   sudo node lib/handout.js"
echo -e "   (Use --test flag to use port 53530 instead of 53)"
echo ""
echo -e "4. ${GREEN}Customize your website:${NC}"
echo -e "   Edit files in: handout/html/"
echo ""
echo -e "${YELLOW}DS Record for root zone (save this):${NC}"
echo -e "${YELLOW}Check the output above for your DS record!${NC}"
echo ""
echo -e "${GREEN}Your installation is ready at: $(pwd)${NC}"
