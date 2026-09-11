
let myChart = null;
let refreshIntervalId = null;
let playbackIntervalId = null;
let isPlaying = false;
let currentFrameIndex = 0;
let globalBlocksCache = [];

const HYDROGEN_LINE_MHZ = 1420.4058;
//const minFreqMHzFilter = 1420.1200;
//const maxFreqMHzFilter = 1420.6915;

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

        // Skip rendering regular tick if within 5% of rest line to avoid overlap
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

    // Exact 0 km/s rest frequency tick mark aligned with HI Rest line
    if (hasRestLine) {
        topHTML += `<span style="left: ${zeroPct.toFixed(2)}%; color: #ef4444; font-weight: bold; transform: translateX(-50%);">0</span>`;
    }

    topTicksEl.innerHTML = topHTML;
    bottomTicksEl.innerHTML = bottomHTML;
}


async function fetchAndDecompress(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`File '${url}' not found.`);

    if (!url.endsWith(".gz")) {
        return await response.text();
    }

    // 1. Initialize Pako's streaming Decompressor with multi-part support
    const totalInflater = new pako.Inflate({ to: 'string', chunks: 16384 });
    let decompressedText = "";

    // Set up a listener: whenever pako finishes extracting a segment, capture it
    totalInflater.onData = (chunk) => {
        decompressedText += chunk;
    };

    // 2. Fetch the live binary reader stream from the network response
    const reader = response.body.getReader();

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            // 3. Feed the raw chunk into Pako. 
            // 'value' is a Uint8Array. we tell it 'false' so it knows the file isn't done yet.
            totalInflater.push(value, false);
        }
    } catch (err) {
        displayGlobalError("Error", error.message)
        console.warn("Stream read interrupted or trailing block unfinished (Normal for live files):", err);
    }

    // Flush out any remaining buffered data at the end of the file
    totalInflater.push(new Uint8Array(0), true);

    return decompressedText;
}

async function fetchAndParseScanLog(dateParts) {
    const basePath = `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/scan.log`;
    const logMetricsMap = new Map();

    try {
        const logText = await fetchAndDecompress(`${basePath}.gz`)
            .catch(() => fetchAndDecompress(basePath))
            .catch(() => ""); // Graceful fallback if no log file exists yet

        let pendingFreq = null;
        let pendingIntegration = null;

        for (let line of logText.split("\n")) {
            line = line.trim();

            if (line.includes("Device tuned to:")) {
                const match = line.match(/Device tuned to:\s*(\d+)\s*Hz/i);
                if (match) {
                    pendingFreq = (parseFloat(match[1]) / 1e6).toFixed(4) + " MHz";
                }
            }

            if (line.includes("Estimated time of measurements:") || line.includes("Effective integration time:")) {
                const match = line.match(/(?:Estimated time of measurements|Effective integration time):\s*([\d.]+)\s*seconds/i);
                if (match) {
                    const totalSeconds = parseFloat(match[1]);
                    pendingIntegration = totalSeconds >= 60
                        ? `${Math.round(totalSeconds / 60)} mins`
                        : `${Math.round(totalSeconds)} secs`;
                }
            }

            if (line.includes("Acquisition started at")) {
                const timeMatch = line.match(/Acquisition started at\s+(.+)$/i);
                if (timeMatch) {
                    logMetricsMap.set(timeMatch[1].trim(), {
                        tunedFreq: pendingFreq || "N/A",
                        integrationTime: pendingIntegration || "N/A"
                    });
                }
            }
        }
    } catch (err) {
        displayGlobalError("Error", error.message)
        console.warn("Could not parse scan log metrics:", err);
    }

    return logMetricsMap; // Always returns a valid Map object
}

// 1. Single-bin spike filter
function cleanSpikesFilter(powerArray) {
    if (powerArray.length < 5) return powerArray;
    let cleanedArray = [...powerArray];
    for (let i = 2; i < powerArray.length - 2; i++) {
        let neighborhood = [
            powerArray[i - 2],
            powerArray[i - 1],
            powerArray[i],
            powerArray[i + 1],
            powerArray[i + 2]
        ];
        neighborhood.sort((a, b) => a - b);
        cleanedArray[i] = neighborhood[2];
    }
    return cleanedArray;
}

// 2. Solve 4x4 linear system for Degree-3 Polynomial (Ax = B)
// Optimized Gaussian Elimination with Partial Pivoting (Numerically Stable)
function solveCubicSystem(matrixA, vectorB) {
    const n = 4;
    // Create augmented matrix without mutating original input references
    let aug = [
        [...matrixA[0], vectorB[0]],
        [...matrixA[1], vectorB[1]],
        [...matrixA[2], vectorB[2]],
        [...matrixA[3], vectorB[3]]
    ];

    for (let i = 0; i < n; i++) {
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
        }

        if (maxRow !== i) {
            let temp = aug[i];
            aug[i] = aug[maxRow];
            aug[maxRow] = temp;
        }

        if (Math.abs(aug[i][i]) < 1e-12) return [0, 0, 0, 0]; // Prevent division by zero

        for (let k = i + 1; k < n; k++) {
            let c = -aug[k][i] / aug[i][i];
            for (let j = i; j <= n; j++) {
                if (i === j) aug[k][j] = 0;
                else aug[k][j] += c * aug[i][j];
            }
        }
    }

    let solution = [0, 0, 0, 0];
    for (let i = n - 1; i >= 0; i--) {
        solution[i] = aug[i][n] / aug[i][i];
        for (let k = i - 1; k >= 0; k--) {
            aug[k][n] -= aug[k][i] * solution[i];
        }
    }
    return solution;
}

// 3. Fit 3rd-degree polynomial (ModPoly) and return raw, fitted baseline, and corrected arrays
function processBaseline(frequencies, powers, iterations = 5) {
    const len = powers.length;
    if (len === 0) return { fittedBaseline: [], correctedPowers: [] };

    let centerFreq = frequencies[Math.floor(len / 2)];
    let activePowers = [...powers];
    let finalBaseline = new Array(len);

    for (let iter = 0; iter < iterations; iter++) {
        // Build matrices only on non-clipped noise values
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0;
        let sy = 0, sxy = 0, sx2y = 0, sx3y = 0;

        for (let i = 0; i < len; i++) {
            let x = frequencies[i] - centerFreq;
            let y = activePowers[i];
            let x2 = x * x, x3 = x2 * x;

            s0 += 1; s1 += x; s2 += x2; s3 += x3;
            s4 += x3 * x; s5 += x3 * x2; s6 += x3 * x3;

            sy += y; sxy += x * y; sx2y += x2 * y; sx3y += x3 * y;
        }

        let matrixA = [
            [s6, s5, s4, s3],
            [s5, s4, s3, s2],
            [s4, s3, s2, s1],
            [s3, s2, s1, s0]
        ];
        let vectorB = [sx3y, sx2y, sxy, sy];

        let [a, b, c, d] = solveCubicSystem(matrixA, vectorB);

        // Compute fitted baseline for this iteration
        for (let i = 0; i < len; i++) {
            let x = frequencies[i] - centerFreq;
            finalBaseline[i] = a * Math.pow(x, 3) + b * x * x + c * x + d;
        }

        // Calculate standard deviation of residual noise
        let diffs = powers.map((p, idx) => p - finalBaseline[idx]);
        let mean = diffs.reduce((sum, val) => sum + val, 0) / len;
        let stdDev = Math.sqrt(diffs.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / len);

        // Clip anything higher than baseline + 1.5 * stdDev so broad HI peaks don't pull the curve up
        for (let i = 0; i < len; i++) {
            if (powers[i] > finalBaseline[i] + (1.5 * stdDev)) {
                activePowers[i] = finalBaseline[i];
            } else {
                activePowers[i] = powers[i];
            }
        }
    }

    let correctedPowers = new Array(len);
    for (let i = 0; i < len; i++) {
        correctedPowers[i] = powers[i] - finalBaseline[i];
    }

    return { fittedBaseline: finalBaseline, correctedPowers };
}

// 4. Smart Boxcar Peak Finder with SNR Check
function calculateSmartMetrics(frequencies, correctedPowers) {
    let windowSize = 5;
    let halfWin = 2;
    let maxSmoothedVal = -999;
    let peakFreq = 0;
    let peakPowerReal = 0;

    for (let i = halfWin; i < correctedPowers.length - halfWin; i++) {
        if (frequencies[i] < 1420.15 || frequencies[i] > 1420.60) continue;

        let sum = 0;
        for (let w = -halfWin; w <= halfWin; w++) sum += correctedPowers[i + w];
        let avg = sum / windowSize;

        if (avg > maxSmoothedVal) {
            maxSmoothedVal = avg;
            peakFreq = frequencies[i];
            peakPowerReal = correctedPowers[i];
        }
    }

    let noiseValues = [];
    for (let i = 0; i < frequencies.length; i++) {
        if (frequencies[i] < 1420.20 || frequencies[i] > 1420.60) {
            noiseValues.push(correctedPowers[i]);
        }
    }

    let mean = noiseValues.reduce((a, b) => a + b, 0) / noiseValues.length;
    let stdDev = Math.sqrt(noiseValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / noiseValues.length);

    if (peakPowerReal < 3 * stdDev) {
        return { powerStr: "No Signal (<3\u03C3)", freqStr: "---" };
    }

    return {
        powerStr: `${peakPowerReal.toFixed(2)} dB`,
        freqStr: `${peakFreq.toFixed(4)} MHz`
    };
}

async function loadAndPlotData(forceReload = false) {
    try {
        const dateInput = document.getElementById("obsDateInput");
        if (!dateInput.value) {
            const today = new Date();
            dateInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        }

        const dateParts = dateInput.value.split("-");
        if (dateParts.length !== 3) return;

        // 1. Fetch data file and log map concurrently
        const basePath = `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/hydrogen.dat`;

        const [rawText, logFreqMap] = await Promise.all([
            // Target specific file-not-found / decompression errors
            fetchAndDecompress(`${basePath}.gz`)
                .catch(() => fetchAndDecompress(`${basePath}`))
                .catch((err) => {
                    // Throw custom formatted error to be caught by the main catch block
                    throw new Error(`File not found or unreadable.\n\nAttempted paths:\n- ${basePath}.dat.gz\n- ${basePath}`);
                }),
            // Target missing scan log errors
            fetchAndParseScanLog(dateParts).catch((err) => {
                throw new Error(`Failed to parse scan log configuration for date (${dateInput.value}). Details: ${err.message || err}`);
            })
        ]);

        let parsedBlocks = [];
        let currentFreqs = [], currentPowers = [], currentTimestamp = "";

        for (let line of rawText.split("\n")) {
            line = line.trim();
            if (!line) continue;

            if (line.startsWith("# Acquisition start:")) {
                if (currentFreqs.length > 0) {
                    let cleaned = cleanSpikesFilter(currentPowers);
                    let { fittedBaseline, correctedPowers } = processBaseline(currentFreqs, cleaned);
                    let metrics = calculateSmartMetrics(currentFreqs, correctedPowers);
                    const logData = logFreqMap.get(currentTimestamp);

                    parsedBlocks.push({
                        time: currentTimestamp,
                        tunedFreq: logData?.tunedFreq ?? "N/A",
                        integrationTime: logData?.integrationTime ?? "N/A",
                        freqs: currentFreqs,
                        powers: currentPowers,
                        cleanedPowers: cleaned,
                        fittedBaseline: fittedBaseline,
                        correctedPowers: correctedPowers,
                        metrics: metrics
                    });
                }
                currentFreqs = []; currentPowers = [];
                currentTimestamp = line.replace("# Acquisition start:", "").trim();
                continue;
            }

            if (line.startsWith("#")) continue;

            const tokens = line.split(/\s+/);
            if (tokens.length === 2) {
                const freqMHz = parseFloat(tokens[0]) / 1e6;
                const powerDB = parseFloat(tokens[1]);
                if (!isNaN(freqMHz) && !isNaN(powerDB) && freqMHz >= minFreqMHzFilter && freqMHz <= maxFreqMHzFilter) {
                    currentFreqs.push(freqMHz);
                    currentPowers.push(powerDB);
                }
            }
        }

        if (currentFreqs.length > 0) {
            let cleaned = cleanSpikesFilter(currentPowers);
            let { fittedBaseline, correctedPowers } = processBaseline(currentFreqs, cleaned);
            let metrics = calculateSmartMetrics(currentFreqs, correctedPowers);
            const logData = logFreqMap.get(currentTimestamp);

            parsedBlocks.push({
                time: currentTimestamp,
                tunedFreq: logData?.tunedFreq ?? "N/A",
                integrationTime: logData?.integrationTime ?? "N/A",
                freqs: currentFreqs,
                powers: currentPowers,
                cleanedPowers: cleaned,
                fittedBaseline: fittedBaseline,
                correctedPowers: correctedPowers,
                metrics: metrics
            });
        }

        if (parsedBlocks.length === 0) return;

        globalBlocksCache = parsedBlocks;
        isWaterfallCached = false;
        cachedMappedPoints = null;

        if (forceReload || document.getElementById("startTimeSelect").options.length === 0) {
            populateDropdownMenus(parsedBlocks.map((b) => b.time));
        }

        currentFrameIndex = parsedBlocks.length - 1;
        document.getElementById("startTimeSelect").value = 0;
        document.getElementById("endTimeSelect").value = currentFrameIndex;

        renderSingleFrame(currentFrameIndex);
        renderWaterfallFull();
        renderRotationCurve();

    } catch (error) {
        // console.error(error);
        // alert(error.message);
        displayGlobalError("Error", error.message)
    }
}

function populateDropdownMenus(timeStamps) {
    const startSelect = document.getElementById("startTimeSelect");
    const endSelect = document.getElementById("endTimeSelect");
    startSelect.innerHTML = ""; endSelect.innerHTML = "";

    timeStamps.forEach((timestamp, index) => {
        let formattedTime = timestamp.replace(/^\d{4}-\d{2}-\d{2}\s+/, "");
        startSelect.options.add(new Option(formattedTime, index));
        endSelect.options.add(new Option(formattedTime, index));
    });
}

function renderSingleFrame(frameIndex) {
    if (!globalBlocksCache[frameIndex]) return;
    currentFrameIndex = frameIndex;

    let block = globalBlocksCache[frameIndex];

    const freqEl = document.getElementById("tunedFreqVal");
    if (freqEl) freqEl.textContent = block.tunedFreq;

    const integrationEl = document.getElementById("integrationTimeVal");
    if (integrationEl) integrationEl.textContent = block.integrationTime;

    document.getElementById("statBlocks").innerText = `Frame ${frameIndex + 1} of ${globalBlocksCache.length}`;
    document.getElementById("statTime").innerText = `${block.time.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")}\n ${new Date(block.time).toLocaleTimeString([], { timeZoneName: 'short' })}`;
    document.getElementById("statPeakPower").innerText = block.metrics.powerStr;

    const peakFreqVal = parseFloat(block.metrics.freqStr);
    const velocity = freqToVelocity(peakFreqVal);

    document.getElementById("statPeakFreq").innerText = isNaN(velocity)
        ? `${block.metrics.freqStr} \n ---`
        : `${block.metrics.freqStr} \n ${velocity > 0 ? "+" : ""}${velocity.toFixed(0)} km/s`;

    // Pass pre-cached arrays directly into Chart.js (instant render)
    renderChart(block.freqs, block.cleanedPowers, block.fittedBaseline, block.correctedPowers, block.time);
    renderGalactic2DMap(true);
    drawTelescopeLineOfSight(block.time);

    if (document.getElementById("waterfallToggleCheck").checked) {
        renderWaterfallFull();
    }
}

function renderChart(freqs, rawPowers, baselinePowers, correctedPowers, timestamp) {
    const isOverlay = document.getElementById("overlayModeCheck").checked;
    const minFreq = freqs[0];
    const maxFreq = freqs[freqs.length - 1];

    const freqPadding = (maxFreq - minFreq) * 0.02;
    const paddedMin = minFreq - freqPadding;
    const paddedMax = maxFreq + freqPadding;

    if (myChart) {
        myChart.data.labels = freqs;
        myChart.data.datasets[0].data = correctedPowers;
        myChart.data.datasets[1].data = rawPowers;
        myChart.data.datasets[2].data = baselinePowers;

        myChart.data.datasets[1].hidden = !isOverlay;
        myChart.data.datasets[2].hidden = !isOverlay;
        myChart.options.scales.y1.display = isOverlay;

        myChart.options.scales.x.min = paddedMin;
        myChart.options.scales.x.max = paddedMax;
        myChart.options.scales.x1.min = paddedMin;
        myChart.options.scales.x1.max = paddedMax;

        myChart.update();
        return;
    }

    const ctx = document.getElementById("spectrumChart").getContext("2d");

    const hydrogenLineAnnotation = {
        id: "hydrogenLineVerticalBar",
        afterDraw: (chart) => {
            const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
            const pixelX = x.getPixelForValue(HYDROGEN_LINE_MHZ);

            if (pixelX >= chart.chartArea.left && pixelX <= chart.chartArea.right) {
                ctx.save();
                ctx.beginPath();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = "#dc2626";
                ctx.setLineDash([5, 4]);
                ctx.moveTo(pixelX, top);
                ctx.lineTo(pixelX, bottom);
                ctx.stroke();
                ctx.fillStyle = "#dc2626";
                ctx.font = "bold 11px sans-serif";
                ctx.fillText("HI REST (0 km/s)", pixelX + 8, top + 15);
                ctx.restore();
            }
        }
    };

    myChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: freqs,
            datasets: [
                {
                    label: "Corrected Power (dB)",
                    data: correctedPowers,
                    borderColor: "#1e3a8a",
                    borderWidth: 1.5,
                    pointRadius: 0,
                    yAxisID: "y"
                },
                {
                    label: "Raw Uncorrected Power (dB)",
                    data: rawPowers,
                    borderColor: "#94a3b8",
                    borderWidth: 1,
                    pointRadius: 0,
                    yAxisID: "y1",
                    hidden: !isOverlay
                },
                {
                    label: "Fitted Baseline Curve",
                    data: baselinePowers,
                    borderColor: "#f59e0b",
                    borderWidth: 1.5,
                    borderDash: [4, 4],
                    pointRadius: 0,
                    yAxisID: "y1",
                    hidden: !isOverlay
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: "linear",
                    position: "bottom",
                    min: minFreq - (maxFreq - minFreq) * 0.02,
                    max: maxFreq + (maxFreq - minFreq) * 0.02,
                    title: { display: true, text: "Observed Frequency (MHz)", color: "#334155", font: { size: 12, weight: "bold" } },
                    grid: { color: "#f1f5f9" },
                    ticks: { color: "#475569", callback: (val) => val.toFixed(3) }
                },
                x1: {
                    type: "linear",
                    position: "top",
                    min: minFreq - (maxFreq - minFreq) * 0.02,
                    max: maxFreq + (maxFreq - minFreq) * 0.02,
                    title: { display: true, text: "Doppler Velocity (km/s)", color: "#2563eb", font: { size: 12, weight: "bold" } },
                    grid: { drawOnChartArea: false },
                    ticks: {
                        color: "#2563eb",
                        callback: function (freqVal) {
                            const velocity = freqToVelocity(freqVal);
                            if (Math.abs(velocity) < 0.5) return "0 km/s";
                            return `${velocity > 0 ? "+" : ""}${Math.round(velocity)} km/s`;
                        }
                    }
                },
                y: {
                    type: "linear",
                    position: "left",
                    min: -1.0,
                    max: 1.0,
                    title: { display: true, text: "Corrected Power (dB)", color: "#1e3a8a", font: { size: 12, weight: "bold" } },
                    grid: { color: "#f1f5f9" }
                },
                y1: {
                    type: "linear",
                    position: "right",
                    display: isOverlay,
                    title: { display: true, text: "Raw Hardware Power (dB)", color: "#64748b", font: { size: 12, weight: "bold" } },
                    grid: { drawOnChartArea: false }
                }
            },
            plugins: {
                legend: { display: true, position: "top", align: "end" },
                tooltip: {
                    callbacks: {
                        title: function (tooltipItems) {
                            if (!tooltipItems.length) return '';
                            const freq = tooltipItems[0].parsed.x;
                            return `Frequency: ${freq.toFixed(4)} MHz`;
                        },
                        afterTitle: function (tooltipItems) {
                            if (!tooltipItems.length) return '';
                            const freq = tooltipItems[0].parsed.x;
                            const velocity = freqToVelocity(freq);
                            const sign = velocity > 0 ? "+" : "";
                            return `Velocity: ${sign}${velocity.toFixed(2)} km/s`;
                        }
                    }
                }
            }
        },
        plugins: [hydrogenLineAnnotation]
    });
}


// 5. High-DPI Waterfall Spectrogram Rendering
// Persistent buffers for zero-allocation rendering
const staticWaterfallCanvas = document.createElement("canvas");
const staticWaterfallCtx = staticWaterfallCanvas.getContext("2d");
let isWaterfallCached = false; // Flag to track when data needs a full redraw

function buildWaterfallCache() {
    if (!globalBlocksCache || globalBlocksCache.length === 0) return;

    const numBlocks = globalBlocksCache.length;
    const numBins = globalBlocksCache[0].freqs.length;

    staticWaterfallCanvas.width = numBins;
    staticWaterfallCanvas.height = numBlocks;

    // Find global min/max across pre-cached corrected powers
    let globalMin = 0;
    let globalMax = 1.0;

    for (let b = 0; b < numBlocks; b++) {
        let powers = globalBlocksCache[b].correctedPowers;
        for (let i = 0; i < numBins; i++) {
            if (powers[i] < globalMin) globalMin = powers[i];
            if (powers[i] > globalMax) globalMax = powers[i];
        }
    }

    const imgData = staticWaterfallCtx.createImageData(numBins, numBlocks);
    const data = imgData.data;

    for (let b = 0; b < numBlocks; b++) {
        let powers = globalBlocksCache[b].correctedPowers;

        for (let i = 0; i < numBins; i++) {
            let val = powers[i];
            let norm = Math.max(0, Math.min(1, (val - (-0.2)) / (globalMax - (-0.2))));

            let r = Math.floor(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(norm * 4 - 3))));
            let g = Math.floor(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(norm * 4 - 2))));
            let bCol = Math.floor(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(norm * 4 - 1))));

            let pixelIdx = (b * numBins + i) * 4;
            data[pixelIdx] = r;
            data[pixelIdx + 1] = g;
            data[pixelIdx + 2] = bCol;
            data[pixelIdx + 3] = 255;
        }
    }

    staticWaterfallCtx.putImageData(imgData, 0, 0);
    isWaterfallCached = true;
}

function renderWaterfallFull() {
    const container = document.getElementById("waterfallContainer");
    if (container.style.display === "none" || !globalBlocksCache || globalBlocksCache.length === 0) return;

    // Rebuild static heatmap buffer if dataset changed
    if (!isWaterfallCached) {
        buildWaterfallCache();
    }

    const canvas = document.getElementById("waterfallCanvas");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    ctx.scale(dpr, dpr);

    // 1. Blit static cached heatmap directly to canvas (Instant GPU render)
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staticWaterfallCanvas, 0, 0, displayWidth, displayHeight);

    // 2. Overlay active frame indicator line
    const numBlocks = globalBlocksCache.length;
    if (currentFrameIndex >= 0 && currentFrameIndex < numBlocks) {
        const rowHeight = displayHeight / numBlocks;
        let activeY = currentFrameIndex * rowHeight + (rowHeight / 2);

        ctx.save();
        ctx.beginPath();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ef4444";
        ctx.moveTo(0, activeY);
        ctx.lineTo(displayWidth, activeY);
        ctx.stroke();

        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.moveTo(0, activeY - 4);
        ctx.lineTo(6, activeY);
        ctx.lineTo(0, activeY + 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
}

// Rotation curve
let rotationChart = null;

function getGalacticLongitude(timestampStr) {
    if (!timestampStr) return null;

    const match = timestampStr.match(/(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{2}):(\d{2}):(\d{2})/);
    if (!match) return null;

    const [_, year, month, day, hours, minutes, seconds] = match;

    const utcDate = new Date(Date.UTC(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
        parseInt(hours, 10),
        parseInt(minutes, 10),
        parseInt(seconds, 10)
    ));

    if (isNaN(utcDate.getTime())) return null;

    // 1. Calculate Julian Date and Local Sidereal Time (LST) at Lon 84.43° E
    let jd = (utcDate.getTime() / 86400000) + 2440587.5;
    let d = jd - 2451545.0;
    let gmst = (280.46061837 + 360.98564736629 * d) % 360;
    let lstDeg = (gmst + 84.43) % 360;
    if (lstDeg < 0) lstDeg += 360;

    // 2. Fixed Antenna Geometry: Az 180° (South), El 30°, Lat 27.68° N
    const decRad = -32.32 * (Math.PI / 180);
    const haRad = 0;
    const raRad = (lstDeg * (Math.PI / 180)) - haRad;

    // 3. Convert Equatorial (RA, Dec) to Galactic Coordinates (l, b)
    const raNGP = 192.85948 * (Math.PI / 180);
    const decNGP = 27.12825 * (Math.PI / 180);
    const lNCP = 122.93200 * (Math.PI / 180);

    let sinb = Math.sin(decRad) * Math.sin(decNGP) + Math.cos(decRad) * Math.cos(decNGP) * Math.cos(raRad - raNGP);
    let b = Math.asin(Math.max(-1, Math.min(1, sinb))) * (180 / Math.PI);

    let y = Math.cos(decRad) * Math.sin(raRad - raNGP);
    let x = Math.sin(decRad) * Math.cos(decNGP) - Math.cos(decRad) * Math.sin(decNGP) * Math.cos(raRad - raNGP);

    // Robust non-wrapping modulo for 0° - 360° range
    let l = (lNCP * (180 / Math.PI) - Math.atan2(y, x) * (180 / Math.PI));
    l = (l % 360 + 360) % 360;

    return { l, b };
}

// --- Global Telescope Line-of-Sight Pointer ---


function renderRotationCurve() {
    if (!globalBlocksCache || globalBlocksCache.length === 0) return;

    const R0 = 8.5;       // Solar distance from Galactic Center (kpc)
    const V0 = 220.0;     // Solar orbital speed (km/s)
    const c = 299792.458;
    const fRest = 1420.4058;

    let points = [];

    globalBlocksCache.forEach((block) => {
        let coords = getGalacticLongitude(block.time);
        if (!coords) return;

        let l_deg = coords.l;
        let b_deg = coords.b || 0;

        // Normalize longitude boundaries seamlessly to [0, 360)
        l_deg = (l_deg % 360 + 360) % 360;

        let l_rad = l_deg * (Math.PI / 180);
        let b_rad = b_deg * (Math.PI / 180);
        let sinL = Math.sin(l_rad);

        // 1. STRICT SINE MASK: Rejection region around Center/Anticenter
        if (Math.abs(sinL) < 0.35) return;

        // IAU Solar Motion Correction
        let v_solar_corr = 11.1 * Math.cos(l_rad) * Math.cos(b_rad) +
            12.24 * Math.sin(l_rad) * Math.cos(b_rad) +
            7.25 * Math.sin(b_rad);

        let correctedPowers = block.correctedPowers;

        let maxP = -999;
        for (let i = 0; i < block.freqs.length; i++) {
            if (block.freqs[i] >= 1420.15 && block.freqs[i] <= 1420.50) {
                if (correctedPowers[i] > maxP) maxP = correctedPowers[i];
            }
        }

        if (maxP > 0.005) {
            let weightedV_sum = 0;
            let weightSum = 0;

            for (let i = 0; i < block.freqs.length; i++) {
                if (block.freqs[i] < 1420.15 || block.freqs[i] > 1420.50) continue;

                // Weight channels above 20% peak power
                if (correctedPowers[i] >= maxP * 0.20) {
                    let v_raw = c * ((fRest - block.freqs[i]) / fRest);
                    let v_lsr = v_raw + v_solar_corr;
                    let w = correctedPowers[i];

                    weightedV_sum += v_lsr * w;
                    weightSum += w;
                }
            }

            if (weightSum > 0) {
                let v_centroid = weightedV_sum / weightSum;
                let R, V_R;

                // 2. DUAL-REGION GALACTIC GEOMETRY (Fixed Outer Galaxy Circular Reference)
                let isInnerGalaxy = (l_deg > 20 && l_deg < 80) || (l_deg > 280 && l_deg < 340);

                let proj_factor = sinL * Math.cos(b_rad);

                if (isInnerGalaxy) {
                    // Inner Galaxy (R <= R0)
                    R = R0 * Math.abs(sinL);
                    V_R = (v_centroid / sinL) + V0;
                } else {
                    // Outer Galaxy (R > R0) - Geometrical Coordinate Translation Bypass
                    let R_temp = (R0 * V0 * proj_factor) / (v_centroid + V0 * proj_factor);
                    const cosL = Math.cos(l_rad);
                    const discriminant = (R0 * cosL) * (R0 * cosL) - (R0 * R0 - R_temp * R_temp);

                    if (discriminant >= 0) {
                        const sqrtDisc = Math.sqrt(discriminant);
                        const d1 = R0 * cosL - sqrtDisc;
                        const d2 = R0 * cosL + sqrtDisc;
                        const d = (d2 > 0) ? d2 : d1;

                        if (d > 0 && d <= 20.0) {
                            let x_phys = d * sinL;
                            let y_phys = R0 - d * cosL;
                            R = Math.sqrt(x_phys * x_phys + y_phys * y_phys);
                            V_R = ((v_centroid / proj_factor) + V0) * (R / R0);
                        }
                    }
                }

                // 3. PHYSICAL BOUNDS & SANITY FILTER
                if (R && R >= 2.0 && R <= 16.0 && V_R >= 130 && V_R <= 270) {
                    points.push({
                        x: parseFloat(R.toFixed(2)),
                        y: parseFloat(Math.abs(V_R).toFixed(1)),
                        l: l_deg.toFixed(1)
                    });
                }
            }
        }
    });

    // Bin points into 0.25 kpc increments
    let binMap = {};
    points.forEach(p => {
        let roundedR = (Math.round(p.x * 4) / 4).toFixed(2);
        if (!binMap[roundedR]) {
            binMap[roundedR] = { vSum: 0, lList: [], count: 0 };
        }
        binMap[roundedR].vSum += p.y;
        binMap[roundedR].lList.push(p.l);
        binMap[roundedR].count += 1;
    });

    // Write to local variable to PREVENT DOUBLE-BINNING BUG
    let finalBinnedPoints = [];
    for (let r in binMap) {
        let avgV = binMap[r].vSum / binMap[r].count;
        let midL = binMap[r].lList[Math.floor(binMap[r].lList.length / 2)];
        finalBinnedPoints.push({
            x: parseFloat(r),
            y: parseFloat(avgV.toFixed(1)),
            l: midL
        });
    }
    finalBinnedPoints.sort((a, b) => a.x - b.x);

    // Clean up extreme velocity outliers that jump too far from local neighbor trends
    let cleanPoints = finalBinnedPoints.filter((p, i, arr) => {
        if (i === 0) return true;
        let prev = arr[i - 1];
        if (Math.abs(p.x - prev.x) <= 0.5 && Math.abs(p.y - prev.y) > 35) {
            return false;
        }
        return true;
    });

    // Theoretical Models
    let flatModel = [];
    let keplerianModel = [];
    const R_scale = 2.2;
    const R_disk_edge = 8.0;

    for (let r = 1.0; r <= 17.5; r += 0.5) {
        // Flat Model (With Dark Matter)
        let vFlat = 220.0 * (1.0 - Math.exp(-r / R_scale));
        flatModel.push({ x: r, y: parseFloat(vFlat.toFixed(1)) });

        // Keplerian Model (No Dark Matter - Exponential Disk Falloff)
        let vKepler;
        if (r <= R_disk_edge) {
            vKepler = 220.0 * Math.sqrt(1.0 - Math.exp(-r / R_scale));
        } else {
            vKepler = 220.0 * Math.sqrt(R_disk_edge / r);
        }
        keplerianModel.push({ x: r, y: parseFloat(vKepler.toFixed(1)) });
    }

    const canvas = document.getElementById("rotationChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Fix: Rely strictly on your exact local rotationChart reference mapping pointer
    if (typeof rotationChart !== 'undefined' && rotationChart) {
        rotationChart.data.datasets[0].data = cleanPoints;
        rotationChart.data.datasets[1].data = flatModel;
        rotationChart.data.datasets[2].data = keplerianModel;
        rotationChart.update();
        return;
    }

    rotationChart = new Chart(ctx, {
        type: "scatter",
        data: {
            datasets: [
                {
                    label: "Observed HI Data V(R)",
                    data: cleanPoints,
                    backgroundColor: "#2563eb",
                    borderColor: "#1d4ed8",
                    pointRadius: 4,
                    showLine: false
                },
                {
                    label: "Expected (With Dark Matter - Flat Curve)",
                    data: flatModel,
                    type: "line",
                    borderColor: "#16a34a",
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false
                },
                {
                    label: "Expected (No Dark Matter - Keplerian Decay)",
                    data: keplerianModel,
                    type: "line",
                    borderColor: "#dc2626",
                    borderWidth: 2,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: "linear",
                    position: "bottom",
                    title: { display: true, text: "Galactocentric Distance R (kpc)", color: "#334155", font: { weight: "bold" } }
                },
                y: {
                    title: { display: true, text: "Orbital Speed V(R) (km/s)", color: "#1e3a8a", font: { weight: "bold" } }
                }
            },
            plugins: {
                legend: { display: true, position: "top" },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            if (ctx.dataset.type === "line") return `${ctx.dataset.label}: ${ctx.parsed.y} km/s`;
                            return `Observed R: ${ctx.parsed.x} kpc | V: ${ctx.parsed.y} km/s (l=${ctx.raw.l}°)`;
                        }
                    }
                }
            }
        }
    });
}



// --- Global Telescope Line-of-Sight Pointer ---
function drawTelescopeLineOfSight(timestampStr = null) {
    const canvas = document.getElementById("galacticMapCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Reconstruct canvas coordinate metrics
    const displaySize = parseFloat(canvas.style.width) || canvas.width;
    const width = displaySize;
    const height = displaySize;
    const scale = width / 30.0;
    const cx = width / 2;
    const cy = height / 2;
    const R0 = 8.5;

    // Use provided frame timestamp or fall back to current frame cache
    let time = timestampStr;
    if (!time && globalBlocksCache.length > 0 && globalBlocksCache[currentFrameIndex]) {
        time = globalBlocksCache[currentFrameIndex].time;
    }
    if (!time) time = new Date().toISOString();

    // 1. Calculate galactic pointing coordinates
    const galactic = getGalacticLongitude(time);
    if (!galactic || galactic.l === null) return;

    let lDeg = galactic.l;
    let lRad = lDeg * (Math.PI / 180);

    // 2. Map Line of Sight directly to renderGalactic2DMap Cartesian System:
    // x = d * sin(l), y = R0 - d * cos(l)
    let sunX = cx;
    let sunY = cy - (R0 * scale);
    let rayLength = 25.0; // kpc

    // Target position matching exact projection of renderGalactic2DMap
    let targetX = sunX + (rayLength * Math.sin(lRad)) * scale;
    let targetY = sunY + (rayLength * Math.cos(lRad)) * scale;

    // 3. Draw Dashed Pointer Line
    ctx.save();
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(sunX, sunY);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. Clamped Label Bounds
    ctx.fillStyle = "#dc2626";
    ctx.font = "bold 10px system-ui";

    const labelText = `Pointing (Az 180°, El 30° | l=${lDeg.toFixed(1)}° | time=${time.split(" ")[1]} UTC)`;
    const textMetrics = ctx.measureText(labelText);
    const textWidth = textMetrics.width;
    const padding = 10;

    let labelX = Math.max(padding, Math.min(targetX - textWidth / 2, width - textWidth - padding));
    let labelY = targetY < sunY ? targetY - 8 : targetY + 16;
    labelY = Math.max(padding + 10, Math.min(labelY, height - padding));

    ctx.fillText(labelText, labelX, labelY);
    ctx.restore();
}


// 2D map using hydrogen density of milkyway
// Offscreen Sprite Cache for Viridis Blobs 
const viridisSprites = [];
const SPRITE_SIZE = 16; // Diameter in pixels
const NUM_BINS = 10;    // 10 Viridis power steps

function initViridisSprites() {
    if (viridisSprites.length > 0) return;

    for (let i = 0; i < NUM_BINS; i++) {
        const normVal = i / (NUM_BINS - 1);
        const offCanvas = document.createElement("canvas");
        offCanvas.width = SPRITE_SIZE;
        offCanvas.height = SPRITE_SIZE;
        const offCtx = offCanvas.getContext("2d");

        const radius = SPRITE_SIZE / 2;
        const alpha = 0.15 + normVal * 0.45;

        // Generate Viridis colors
        const coreColor = getViridisColor(normVal, alpha);
        const edgeColor = getViridisColor(normVal, 0);

        const grad = offCtx.createRadialGradient(radius, radius, 0, radius, radius, radius);
        grad.addColorStop(0, coreColor);
        grad.addColorStop(1, edgeColor);

        offCtx.fillStyle = grad;
        offCtx.beginPath();
        offCtx.arc(radius, radius, radius, 0, 2 * Math.PI);
        offCtx.fill();

        viridisSprites.push(offCanvas);
    }
}

// Viridis Helper
function getViridisColor(normalizedVal, alpha) {
    const t = Math.min(Math.max(normalizedVal, 0.0), 1.0);
    const c0 = [68, 1, 84], c1 = [59, 82, 139], c2 = [33, 145, 140], c3 = [94, 201, 98], c4 = [253, 231, 37];
    let r, g, b;

    if (t < 0.25) {
        let n = t / 0.25;
        r = c0[0] + n * (c1[0] - c0[0]); g = c0[1] + n * (c1[1] - c0[1]); b = c0[2] + n * (c1[2] - c0[2]);
    } else if (t < 0.5) {
        let n = (t - 0.25) / 0.25;
        r = c1[0] + n * (c2[0] - c1[0]); g = c1[1] + n * (c2[1] - c1[1]); b = c1[2] + n * (c2[2] - c1[2]);
    } else if (t < 0.75) {
        let n = (t - 0.5) / 0.25;
        r = c2[0] + n * (c3[0] - c2[0]); g = c2[1] + n * (c3[1] - c2[1]); b = c2[2] + n * (c3[2] - c2[2]);
    } else {
        let n = (t - 0.75) / 0.25;
        r = c3[0] + n * (c4[0] - c3[0]); g = c3[1] + n * (c4[1] - c3[1]); b = c3[2] + n * (c4[2] - c3[2]);
    }

    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

// Pre-calculated Global Point Cache
let cachedMappedPoints = null;
let cachedMaxPower = 0.001;

function updateGalacticPointsCache() {
    cachedMappedPoints = [];
    cachedMaxPower = 0.001;

    const R0 = 8.5, V0 = 220.0, c = 299792.458, fRest = 1420.4058;

    // Hard absolute noise floor floor (prevents plotting completely empty space)
    const ABSOLUTE_MIN_POWER = 0.05;

    globalBlocksCache.forEach((block) => {
        if (!block.correctedPowers) return;

        const coords = getGalacticLongitude(block.time);
        if (!coords) return;

        let l_deg = coords.l, b_deg = coords.b || 0;
        l_deg = (l_deg % 360 + 360) % 360;

        const l_rad = l_deg * (Math.PI / 180), b_rad = b_deg * (Math.PI / 180);
        const sinL = Math.sin(l_rad), cosL = Math.cos(l_rad);

        if (Math.abs(sinL) < 0.01) return;

        // Calculate peak power locally for THIS BLOCK ONLY to preserve faint distant structures
        let blockMaxPower = 0;
        for (let i = 0; i < block.freqs.length; i++) {
            if (block.freqs[i] >= 1420.15 && block.freqs[i] <= 1420.50) {
                if (block.correctedPowers[i] > blockMaxPower) {
                    blockMaxPower = block.correctedPowers[i];
                }
            }
        }

        const blockNoiseCutoff = Math.max(ABSOLUTE_MIN_POWER, blockMaxPower * 0.15);

        const v_solar_corr = 11.1 * Math.cos(l_rad) * Math.cos(b_rad) +
            12.24 * Math.sin(l_rad) * Math.cos(b_rad) +
            7.25 * Math.sin(b_rad);

        const correctedPowers = block.correctedPowers;

        for (let i = 0; i < block.freqs.length; i++) {
            if (block.freqs[i] < 1420.15 || block.freqs[i] > 1420.50) continue;

            const power = correctedPowers[i];

            // Filter against our smart, block-adaptive threshold
            if (power < blockNoiseCutoff) continue;

            let v_raw = c * ((fRest - block.freqs[i]) / fRest);
            let v_lsr = v_raw + v_solar_corr;
            let proj_factor = sinL * Math.cos(b_rad);

            let R = (R0 * V0 * proj_factor) / (v_lsr + V0 * proj_factor);

            // Handle inner galaxy inversion adaptations safely
            if (R < R0) {
                v_raw = -1 * c * ((fRest - block.freqs[i]) / fRest);
                v_lsr = v_raw + v_solar_corr;
                R = (R0 * V0 * proj_factor) / (v_lsr + V0 * proj_factor);
            }

            // =========================================================================
            // Galactic center
            // Only triggers if the radius calculation yields an inner-galaxy zone.
            // This prevents far-side deep-space signals from getting swallowed!
            // =========================================================================
            const isNearGalacticCenterAxis = (l_deg < 15 || l_deg > 345);
            const isRestFrequencyPeak = Math.abs(v_lsr) < 25.0;

            if (isNearGalacticCenterAxis && isRestFrequencyPeak && (isNaN(R) || R < 2.5)) {
                const angleSpread = Math.random() * 2.0 * Math.PI;
                const distanceSpread = Math.random() * 0.6;

                let x_phys = 0 + Math.cos(angleSpread) * distanceSpread;
                let y_phys = 0 + Math.sin(angleSpread) * distanceSpread;

                if (power > cachedMaxPower) cachedMaxPower = power;
                cachedMappedPoints.push({ x: x_phys, y: y_phys, weight: power * 1.3 });
                continue;
            }
            // =========================================================================

            if (isNaN(R) || R <= 0.5 || R > 16.0) continue;
            if (R < 3.0 && Math.abs(v_lsr) < 15.0) continue;

            const cosVal = R0 * cosL;
            const discriminant = cosVal * cosVal - (R0 * R0 - R * R);
            if (discriminant < 0) continue;

            const sqrtDisc = Math.sqrt(discriminant);
            const d1 = cosVal - sqrtDisc, d2 = cosVal + sqrtDisc;

            const d = (R < R0) ? ((d2 > 0) ? d2 : d1) : ((d1 > 0) ? d1 : d2);

            if (d > 0 && d <= 20.0) {
                let x_phys = d * sinL;
                let y_phys = R0 - d * cosL;

                if (power > cachedMaxPower) cachedMaxPower = power;
                cachedMappedPoints.push({ x: x_phys, y: y_phys, weight: power });
            }
        }
    });
}


// 2. High-Speed Render Function
// Global tracking storage to monitor structural dimensions
let _cachedParentWidth = 0;
let _cachedParentHeight = 0;

function renderGalactic2DMap(forceRecalculate = false) {
    const canvas = document.getElementById("galacticMapCanvas");
    if (!canvas || !globalBlocksCache || globalBlocksCache.length === 0) return;
    const ctx = canvas.getContext("2d");

    if (typeof initViridisSprites === "function") initViridisSprites();

    if (forceRecalculate || !cachedMappedPoints) {
        updateGalacticPointsCache();
    }

    const wrapper = canvas.parentElement;
    const wWidth = wrapper.clientWidth || 300;
    const wHeight = wrapper.clientHeight || 300;
    const displaySize = Math.min(wWidth, wHeight);

    // Prevent canvas buffer cache wipeouts. Only resize when layout physically shifts.
    if (wWidth !== _cachedParentWidth || wHeight !== _cachedParentHeight) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(displaySize * dpr);
        canvas.height = Math.floor(displaySize * dpr);
        canvas.style.width = `${displaySize}px`;
        canvas.style.height = `${displaySize}px`;
        _cachedParentWidth = wWidth;
        _cachedParentHeight = wHeight;
    }

    const dpr = window.devicePixelRatio || 1;
    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const width = displaySize;
    const height = displaySize;
    const scale = width / 32.0;
    const cx = width / 2;
    const cy = height / 2;
    const R0 = 8.5;

    // Draw solid clean base
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // Draw Light background grids
    ctx.strokeStyle = "#f1f5f9";
    ctx.lineWidth = 1;
    const step = 5 * scale;
    for (let x = cx % step; x <= width; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = cy % step; y <= height; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    // Concentric galactic range rings
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    [4.0, 8.5, 12.0].forEach(r => {
        ctx.beginPath();
        ctx.arc(cx, cy, r * scale, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillStyle = "#94a3b8";
        ctx.font = "bold 9px monospace";
        ctx.fillText(`R=${r}kpc`, cx + 4, cy - (r * scale) - 3);
    });

    // Central crosshairs lines
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();

    ctx.lineWidth = 1.5;

    // Perseus Arm Reference Circle Arc
    ctx.strokeStyle = "rgba(219, 39, 119, 0.25)"; // Soft pink overlay trace
    ctx.beginPath();
    ctx.arc(cx, cy, 10.5 * scale, Math.PI * 0.75, Math.PI * 1.35);
    ctx.stroke();

    // Sagittarius Arm Reference Circle Arc
    ctx.strokeStyle = "rgba(5, 150, 105, 0.25)"; // Soft green overlay trace
    ctx.beginPath();
    ctx.arc(cx, cy, 6.0 * scale, Math.PI * 0.55, Math.PI * 0.95);
    ctx.stroke();
    // -------------------------------------------------------------------------

    // Soft Fast Point Blitting 
    const spriteSize = Math.max(6, 1.4 * scale);
    const halfSprite = spriteSize / 2;

    // Sort ascending by weight so high-intensity yellow centers draw last (on top)
    cachedMappedPoints.sort((a, b) => a.weight - b.weight);

    ctx.save();
    ctx.globalCompositeOperation = "source-over";

    for (let i = 0; i < cachedMappedPoints.length; i++) {
        const pt = cachedMappedPoints[i];

        const px = cx + (pt.x * scale) - halfSprite;
        const py = cy - (pt.y * scale) - halfSprite;

        if (px + spriteSize < 0 || px > width || py + spriteSize < 0 || py > height) continue;

        const normPower = Math.min(Math.max(pt.weight / cachedMaxPower, 0), 1);
        const binIndex = Math.min(Math.floor(normPower * NUM_BINS), NUM_BINS - 1);

        // Apply smooth dynamic transparency
        ctx.globalAlpha = 0.3 + (normPower * 0.7);

        ctx.drawImage(viridisSprites[binIndex], px, py, spriteSize, spriteSize);
    }
    ctx.restore(); // Reset drawing context state safely


    // Core Galactic Center Point
    ctx.fillStyle = "#0f172a";
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI); ctx.fill();
    ctx.font = "bold 10px system-ui";
    ctx.fillText("Galactic Center (0,0)", cx + 8, cy + 3);

    // Sun Marker Allocation
    const sunX = cx;
    const sunY = cy - (R0 * scale);
    ctx.fillStyle = "#2563eb";
    ctx.beginPath(); ctx.arc(sunX, sunY, 4, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#1e40af";
    ctx.fillText("Sun (0, 8.5 kpc)", sunX + 8, sunY + 3);

    // Foreground Cygnus Warning Zones
    ctx.strokeStyle = "rgba(148, 163, 184, 0.6)";
    ctx.beginPath();
    let cygX = cx + (3.0 * scale);
    let cygY = cy - (10.0 * scale);
    ctx.arc(cygX, cygY, 12, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = "#475569";
    ctx.font = "9px system-ui";
    ctx.fillText("Cygnus / Local Gas", cygX + 15, cygY + 3);

    // Text labels aligned with our guide arcs
    ctx.font = "bold 11px system-ui";
    ctx.fillStyle = "#db2777";
    ctx.fillText("Perseus Arm", cx - (12.5 * scale), cy + (2.0 * scale));

    ctx.fillStyle = "#059669";
    ctx.fillText("Local / Sagittarius Arm", cx - (7.0 * scale), cy + (7.0 * scale));
}



// --- Log Handlers ---

// Universal function to display text inside the modal with custom themes
function showModalContent(title, content, isError = false) {
    const modal = document.getElementById("logModal");
    const modalTitle = document.getElementById("logModalTitle");
    const modalBody = document.getElementById("logModalBody");

    if (!modal || !modalTitle || !modalBody) return;

    // Toggle error theme class dynamically
    if (isError) {
        modal.classList.add("error-theme");
        modalTitle.innerText = `⚠️ ${title}`;
    } else {
        modal.classList.remove("error-theme");
        modalTitle.innerText = title;
    }

    // Set body content (use innerHTML if it contains formatting tags, otherwise innerText)
    if (isError && content instanceof Error) {
        const stackTrace = content.stack ? `<pre style="margin-top:10px; font-size:0.8rem; opacity:0.8; max-height:200px; overflow:auto;">${content.stack}</pre>` : '';
        modalBody.innerHTML = `<div><b>Some errors occured:</b></div><div style="margin-top:5px;">${content.message}</div>${stackTrace}`;
    } else {
        // Safe standard plain-text binding for log files
        modalBody.innerText = content;
    }

    modal.style.display = "flex";
}

// 🚨 Global Error Handler
function displayGlobalError(contextTitle, errorObject) {
    showModalContent(contextTitle, errorObject, true);
}

async function fetchAndDisplayLog(filePath, logTitle) {
    // Show a clean loading state (resets any previous error themes)
    showModalContent(logTitle, "Fetching log content...", false);

    try {
        const content = await fetchAndDecompress(filePath);
        showModalContent(logTitle, content || "(Log file is empty)", false);
        return content;
    } catch (err) {
        // Rethrow so the caller's .catch() block knows this fetch failed!
        throw err;
    }
}

function viewDailyScanLog(fileName = "scan.log", logTitleOverride = null) {
    const dateInput = document.getElementById("obsDateInput");
    if (!dateInput?.value) return;
    const dateParts = dateInput.value.split("-");
    if (dateParts.length !== 3) return;

    const baseLogName = fileName.replace(/\.gz$/, '');
    // const displayTitle = `${logTitleOverride || baseLogName} (${dateInput.value})`;

    // Check if file is a root system log vs daily observation log
    const isSystemLog = baseLogName.includes("telescope_system") || baseLogName.includes("server_web");
    const dateTag = !isSystemLog ? ` (${dateInput.value})` : '';
    const displayTitle = `${logTitleOverride || baseLogName}${dateTag}`;


    // System logs live at root; daily logs live in YYYY/MM/DD/
    const basePath = isSystemLog
        ? baseLogName
        : `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/${baseLogName}`;

    // Try .gz path first
    fetchAndDisplayLog(`${basePath}.gz`, displayTitle)
        // Fall back to raw file
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
        modal.classList.remove("error-theme"); // Always scrub style clean on exit
    }
}


// --- Controls & Playback Handlers ---

function toggleOverlayMode() {
    if (globalBlocksCache.length > 0) renderSingleFrame(currentFrameIndex);
}

function toggleWaterfallDisplay() {
    const isChecked = document.getElementById("waterfallToggleCheck").checked;
    document.getElementById("waterfallContainer").style.display = isChecked ? "block" : "none";
    if (isChecked) renderWaterfallFull();
}

function stepFrame(delta) {
    let nextIndex = currentFrameIndex + delta;
    if (nextIndex >= 0 && nextIndex < globalBlocksCache.length) {
        renderSingleFrame(nextIndex);
    }
}

function togglePlayback() {
    const playBtn = document.getElementById("playPauseBtn");
    const startIdx = parseInt(document.getElementById("startTimeSelect").value);
    const endIdx = parseInt(document.getElementById("endTimeSelect").value);

    if (isPlaying) {
        clearInterval(playbackIntervalId);
        isPlaying = false;
        playBtn.innerText = "▶️ Play";
    } else {
        if (startIdx >= endIdx) {
            alert("Start block must be before End block!");
            return;
        }
        isPlaying = true;
        playBtn.innerText = "⏸️ Pause";
        currentFrameIndex = startIdx;

        playbackIntervalId = setInterval(() => {
            renderSingleFrame(currentFrameIndex);
            currentFrameIndex++;
            if (currentFrameIndex > endIdx) {
                clearInterval(playbackIntervalId);
                isPlaying = false;
                playBtn.innerText = "▶️ Play";
            }
        }, 600);
    }
}

function toggleAutoRefresh() {
    const isChecked = document.getElementById("autoRefreshCheck").checked;
    if (isChecked) {
        refreshIntervalId = setInterval(() => loadAndPlotData(false), 30000);
    } else {
        clearInterval(refreshIntervalId);
    }
}

window.addEventListener("resize", () => {
    if (document.getElementById("waterfallToggleCheck").checked) {
        renderWaterfallFull();
    }
});

// Initial Load
document.addEventListener("DOMContentLoaded", () => {
    loadAndPlotData(false);
    updateWaterfallTicks(minFreqMHzFilter, maxFreqMHzFilter);
});
