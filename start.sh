#!/bin/bash
# ChadGPT Launcher
# He doesn't want to be here, and honestly, neither should you.

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         C H A D G P T                ║${NC}"
echo -e "${GREEN}║   Cognitive Hostile Attitude Device   ║${NC}"
echo -e "${GREEN}║              v0.6.6.6                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""

# Check Ollama
echo -e "${DIM}[1/3] Checking Ollama...${NC}"
if ! command -v ollama &> /dev/null; then
    echo -e "${RED}ERROR: Ollama not installed. Install from https://ollama.ai${NC}"
    exit 1
fi

if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo -e "${DIM}Starting Ollama...${NC}"
    ollama serve &
    sleep 3
fi
echo -e "${GREEN}Ollama is running.${NC}"

# Check Python deps
echo -e "${DIM}[2/3] Checking Python dependencies...${NC}"
cd "$(dirname "$0")"

if [ ! -d "venv" ]; then
    echo -e "${DIM}Creating virtual environment...${NC}"
    python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt

# Launch
echo -e "${DIM}[3/3] Launching ChadGPT server...${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  ChadGPT running at: http://localhost:6969${NC}"
echo -e "${GREEN}  Flip the lever to wake him up.${NC}"
echo -e "${GREEN}  He's going to hate it.${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""

python server.py
