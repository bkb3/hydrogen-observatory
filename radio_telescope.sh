#!/bin/bash

# Clean up subprocesses on SIGINT or SIGTERM
trap 'pkill -x rtl_power_fftw 2>/dev/null; exit 0' SIGINT SIGTERM EXIT

BASE_DIR="/mnt/usb_data/radio_astronomy/hydrogen"
cd "$BASE_DIR" || exit 1

# Target SDR Serial Number
TARGET_SN="00000010"

# Find device index corresponding to serial number 00000010
SDR_INDEX=$(timeout -s KILL 1 rtl_test 2>&1 | grep -E "SN:\s*${TARGET_SN}" | awk -F':' '{print $1}' | tr -d ' ' | head -n 1)


if [ -z "$SDR_INDEX" ]; then
    echo "❌ Error: SDR with SN ${TARGET_SN} not found!" >> "${BASE_DIR}/telescope_system.log"
    exit 1
fi

echo "✅ Found Target SDR at Index: ${SDR_INDEX}"

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
    LOG_FILE="${TARGET_DIR}/scan.log"

    # Force close any stale radio capture instances before starting the day
    pkill -x rtl_power_fftw 2>/dev/null || true
    sleep 2

    echo "🛰️ Initiating core background logging loop for ${YEAR}-${MONTH}-${DAY}..."

    # Core internal daily capture loop (runs every 10 mins until midnight UTC)
    while [ "$(date -u +'%d')" == "$DAY" ]; do
        stdbuf -oL rtl_power_fftw -d "$SDR_INDEX" -f 1420.850M -b 2048 -g 300 -t 600 >> "$DATA_FILE" 2>> "$LOG_FILE"

        sleep 1
    done

    # Midnight reached: compress uncompressed logs and spectrum data
    echo "🔔 Midnight reached! Compressing data for ${YEAR}-${MONTH}-${DAY}..."

    [ -f "$DATA_FILE" ] && gzip -f "$DATA_FILE"
    [ -f "$LOG_FILE" ] && gzip -f "$LOG_FILE"

    echo "Committing full day's data and local directory changes for ${YEAR}-${MONTH}-${DAY}..."

    # Stage all repository changes (data + local modified scripts)
    git add .
    git commit -m "Auto daily spectrum upload and updates: ${YEAR}-${MONTH}-${DAY}" || true
    git push origin main || echo "⚠️ Git push failed at midnight. Will retry next cycle."

    echo "Moving to tomorrow's nested calendar directory..."
done
