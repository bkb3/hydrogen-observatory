// --- Constants & Global State ---
let myChart = null;
let refreshIntervalId = null;
let playbackIntervalId = null;
let isPlaying = false;
let currentFrameIndex = 0;
let globalBlocksCache = [];

const HYDROGEN_LINE_MHZ = 1420.4058;
const minFreqMHzFilter = 1420.070;
const maxFreqMHzFilter = 1420.62;

// Radio Doppler velocity conversion (km/s)
function freqToVelocity(freqMHz) {
    const C_KMS = 299792.458;
    return C_KMS * ((HYDROGEN_LINE_MHZ - freqMHz) / HYDROGEN_LINE_MHZ);
}

function updateWaterfallTicks(minFreqMHz = minFreqMHzFilter, maxFreqMHz = maxFreqMHzFilter) {
    const topTicksEl = document.querySelector(".waterfall-ticks-top");
    const bottomTicksEl = document.querySelector(".waterfall-ticks-bottom");
    if (!topTicksEl || !bottomTicksEl) return;

    const steps = [0, 0.25, 0.5, 0.75, 1.0];
    let topHTML = "";
    let bottomHTML = "";

    const hasRestLine = HYDROGEN_LINE_MHZ >= minFreqMHz && HYDROGEN_LINE_MHZ <= maxFreqMHz;
    const zeroPct = hasRestLine ? ((HYDROGEN_LINE_MHZ - minFreqMHz) / (maxFreqMHz - minFreqMHz)) * 100 : null;

    steps.forEach((pct) => {
        const pctPos = pct * 100;
        const isNearZeroLine = zeroPct !== null && Math.abs(pctPos - zeroPct) < 5;
        const freq = minFreqMHz + pct * (maxFreqMHz - minFreqMHz);
        const vel = freqToVelocity(freq);

        let transformStyle = "transform: translateX(-50%);";
        if (pct === 0) transformStyle = "transform: translateX(0%);";
        else if (pct === 1) transformStyle = "transform: translateX(-100%);";

        const formattedVel = Math.round(vel);
        const velNum = (formattedVel > 0 ? "+" : "") + formattedVel;
        const velLabel = (pct === 0 || pct === 1) ? `${velNum} km/s` : velNum;
        const freqLabel = (pct === 0 || pct === 1) ? `${freq.toFixed(3)} MHz` : freq.toFixed(3);

        if (!isNearZeroLine) {
            topHTML += `<span style="left: ${pctPos}%; ${transformStyle}">${velLabel}</span>`;
        }
        bottomHTML += `<span style="left: ${pctPos}%; ${transformStyle}">${freqLabel}</span>`;
    });

    if (hasRestLine) {
        topHTML += `<span style="left: ${zeroPct.toFixed(2)}%; color: #ef4444; font-weight: bold; transform: translateX(-50%);">0</span>`;
    }

    topTicksEl.innerHTML = topHTML;
    bottomTicksEl.innerHTML = bottomHTML;
}

// Data Fetching & Decompression
async function fetchAndDecompress(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`File '${url}' not found.`);

    if (!url.endsWith(".gz")) {
        return await response.text();
    }

    const totalInflater = new pako.Inflate({ to: 'string', chunks: 16384 });
    let decompressedText = "";

    totalInflater.onData = (chunk) => {
        decompressedText += chunk;
    };

    const reader = response.body.getReader();

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            totalInflater.push(value, false);
        }
    } catch (err) {
        displayGlobalError("Error", err.message);
        console.warn("Stream read interrupted or trailing block unfinished:", err);
    }

    totalInflater.push(new Uint8Array(0), true);
    return decompressedText;
}

// Modal & Error Handling
function showModalContent(title, content, isError = false) {
    const modal = document.getElementById("logModal");
    const modalTitle = document.getElementById("logModalTitle");
    const modalBody = document.getElementById("logModalBody");

    if (!modal || !modalTitle || !modalBody) return;

    if (isError) {
        modal.classList.add("error-theme");
        modalTitle.innerText = `⚠️ ${title}`;
    } else {
        modal.classList.remove("error-theme");
        modalTitle.innerText = title;
    }

    if (isError && content instanceof Error) {
        const stackTrace = content.stack ? `<pre style="margin-top:10px; font-size:0.8rem; opacity:0.8; max-height:200px; overflow:auto;">${content.stack}</pre>` : '';
        modalBody.innerHTML = `<div><b>Some errors occurred:</b></div><div style="margin-top:5px;">${content.message}</div>${stackTrace}`;
    } else if (isError && typeof content === 'object') {
        modalBody.innerText = content.message || JSON.stringify(content);
    } else {
        modalBody.innerText = content;
    }

    modal.style.display = "flex";
}

function displayGlobalError(contextTitle, errorObject) {
    showModalContent(contextTitle, errorObject, true);
}

async function fetchAndDisplayLog(filePath, logTitle) {
    showModalContent(logTitle, "Fetching log content...", false);
    try {
        const content = await fetchAndDecompress(filePath);
        showModalContent(logTitle, content || "(Log file is empty)", false);
        return content;
    } catch (err) {
        throw err;
    }
}

function viewDailyScanLog(fileName = "scan.log", logTitleOverride = null) {
    const dateInput = document.getElementById("datePicker");
    if (!dateInput?.value) return;
    const dateParts = dateInput.value.split("-");
    if (dateParts.length !== 3) return;

    const baseLogName = fileName.replace(/\.gz$/, '');
    const isSystemLog = baseLogName.includes("telescope_system") || baseLogName.includes("server_web");
    const dateTag = !isSystemLog ? ` (${dateInput.value})` : '';
    const displayTitle = `${logTitleOverride || baseLogName}${dateTag}`;

    const basePath = isSystemLog
        ? baseLogName
        : `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/${baseLogName}`;

    fetchAndDisplayLog(`${basePath}.gz`, displayTitle)
        .catch(() => fetchAndDisplayLog(basePath, displayTitle))
        .catch((err) => {
            const errorDetails = `File not found or unreadable.\n\nAttempted paths:\n- ${basePath}.gz\n- ${basePath}`;
            showModalContent(`Error Loading Log`, errorDetails, true);
        });
}

function closeLogModal() {
    const modal = document.getElementById("logModal");
    if (modal) {
        modal.style.display = "none";
        modal.classList.remove("error-theme");
    }
}

function getTurboColor(normalizedVal) {
    const x = Math.min(Math.max(normalizedVal, 0.0), 1.0);
    
    // Polynomial approximations for Turbo colormap
    const r = 34.61 + x * (1172.23 + x * (-12290.81 + x * (38752.6 + x * (-44358.8 + x * 18161.25))));
    const g = 23.31 + x * (657.32 + x * (2428.65 + x * (-15263.14 + x * (19821.12 + x * (-8663.47)))));
    const b = 27.2 + x * (3211.1 + x * (-15327.97 + x * (27802.24 + x * (-22569.18 + x * 6838.66))));

    return [
        Math.min(255, Math.max(0, Math.round(r))),
        Math.min(255, Math.max(0, Math.round(g))),
        Math.min(255, Math.max(0, Math.round(b)))
    ];
}

// Standalone Cubehelix color generator (Dave Green scheme)
function getCubehelixColor(lambda, start = 0.5, rotations = -1.5, hue = 1.0, gamma = 1.0) {
    const l = Math.pow(Math.max(0, Math.min(1, lambda)), gamma);
    const phi = 2 * Math.PI * (start / 3 + rotations * l);
    const a = (hue * l * (1 - l)) / 2;

    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    let r = l + a * (-0.14861 * cosPhi + 1.78277 * sinPhi);
    let g = l + a * (-0.29227 * cosPhi - 0.90649 * sinPhi);
    let b = l + a * (1.97294 * cosPhi);

    return [
        Math.floor(255 * Math.max(0, Math.min(1, r))),
        Math.floor(255 * Math.max(0, Math.min(1, g))),
        Math.floor(255 * Math.max(0, Math.min(1, b)))
    ];
}