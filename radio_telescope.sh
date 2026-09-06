#!/bin/bash

BASE_DIR="/mnt/usb_data/radio_astronomy/hydrogen"
cd "$BASE_DIR" || exit 1

export GIT_SSH_COMMAND="ssh -i ${BASE_DIR}/github_deploy_key -o StrictHostKeyChecking=accept-new"

echo "🌌 Initializing Hydrogen Line Automated USB Observatory Control Loop..."

while true; do
    YEAR=$(date -u +"%Y")
    MONTH=$(date -u +"%m")
    DAY=$(date -u +"%d")

    TARGET_DIR="${BASE_DIR}/${YEAR}/${MONTH}/${DAY}"
    mkdir -p "$TARGET_DIR"

    GZ_DATA="${TARGET_DIR}/hydrogen.dat.gz"
    GZ_LOG="${TARGET_DIR}/scan_errors.log.gz"

    pkill -x rtl_power_fftw 2>/dev/null || true
    sleep 2

    echo "🛰️ Initiating core background logging loop for ${YEAR}-${MONTH}-${DAY}..."

    while [ "$(date -u +'%d')" == "$DAY" ]; do
        # Pipe standard output and error through gzip in append mode (-c outputs to stdout)
        # stdbuf -oL rtl_power_fftw -d 0 -f 1420.700M -b 2048 -g 300 -t 600 2> >(gzip -c >> "$GZ_LOG") | gzip -c >> "$GZ_DATA"
        stdbuf -oL rtl_power_fftw -d 0 -f 1420.700M -b 2048 -g 300 -t 600 \
        2> >(stdbuf -i0 -o0 gzip -c >> "$GZ_LOG") \
        | stdbuf -i0 -o0 gzip -c >> "$GZ_DATA"

        sleep 1
    done

    echo "🔔 Midnight reached! Committing full day's data for ${YEAR}-${MONTH}-${DAY}..."

    git add .
    git commit -m "Daily spectrum upload: ${YEAR}-${MONTH}-${DAY}" || true
    git push origin main || echo "⚠️ Git push failed at midnight. Will retry next cycle."

    echo "Moving to tomorrow's nested calendar directory..."
done
