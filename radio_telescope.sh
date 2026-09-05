#!/bin/bash

BASE_DIR="/mnt/usb_data/radio_astronomy/hydrogen"
cd "$BASE_DIR" || exit 1

# Force Git to use the repository-specific deploy key
export GIT_SSH_COMMAND="ssh -i ${BASE_DIR}/github_deploy_key -o StrictHostKeyChecking=accept-new"

echo "🌌 Initializing Hydrogen Line Automated USB Observatory Control Loop..."

while true; do
    # Fetch calendar coordinates dynamically
    YEAR=$(date -u +"%Y")
    MONTH=$(date -u +"%m")
    DAY=$(date -u +"%d")

    TARGET_DIR="${BASE_DIR}/${YEAR}/${MONTH}/${DAY}"
    mkdir -p "$TARGET_DIR"

    DATA_FILE="${TARGET_DIR}/hydrogen.dat"

    # Force close any stale radio capture instances before starting the day
    pkill -x rtl_power_fftw 2>/dev/null || true
    sleep 2

    echo "🛰️ Initiating core background logging loop for ${YEAR}-${MONTH}-${DAY}..."

    # Core internal daily capture loop (runs every 10 mins until midnight UTC)
    while [ "$(date -u +'%d')" == "$DAY" ]; do
        stdbuf -oL rtl_power_fftw -d 0 -f 1420.700M -b 2048 -g 300 -t 600 >> "$DATA_FILE" 2>> "${TARGET_DIR}/scan_errors.log"

        sleep 1
    done

    # Midnight reached: sync all data recorded during the finished day
    echo "🔔 Midnight reached! Committing full day's data for ${YEAR}-${MONTH}-${DAY}..."
    
    git add .
    git commit -m "Daily spectrum upload: ${YEAR}-${MONTH}-${DAY}" || true
    git push origin main || echo "⚠️ Git push failed at midnight. Will retry next cycle."

    echo "Moving to tomorrow's nested calendar directory..."
done
