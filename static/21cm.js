
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
        const basePath = `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/hydrogen`;

        const [rawText, logFreqMap] = await Promise.all([
            fetchAndDecompress(`${basePath}.dat.gz`).catch(() => fetchAndDecompress(`${basePath}.dat`)),
            fetchAndParseScanLog(dateParts)
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

        if (forceReload || document.getElementById("startTimeSelect").options.length === 0) {
            populateDropdownMenus(parsedBlocks.map((b) => b.time));
        }

        currentFrameIndex = parsedBlocks.length - 1;
        document.getElementById("startTimeSelect").value = 0;
        document.getElementById("endTimeSelect").value = currentFrameIndex;

        renderSingleFrame(currentFrameIndex);
        renderWaterfallFull();
        renderRotationCurve();
        renderGalactic2DMap();
    } catch (error) {
        console.error(error);
        alert(error.message);
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
    // For Az 180°: Declination = Latitude + Elevation - 90°
    const latRad = 27.68 * (Math.PI / 180);
    const elRad = 30.0 * (Math.PI / 180);
    const decRad = Math.asin(Math.sin(latRad) * Math.sin(elRad) - Math.cos(latRad) * Math.cos(elRad)); // dec = -32.32°

    // Hour Angle (HA = 0° when pointing due South)
    const haRad = 0;
    const raRad = (lstDeg * (Math.PI / 180)) - haRad;

    // 3. Convert Equatorial (RA, Dec) to Galactic Coordinates (l, b)
    const raNGP = 192.85948 * (Math.PI / 180);
    const decNGP = 27.12825 * (Math.PI / 180);
    const lNCP = 122.93200 * (Math.PI / 180);

    let sinb = Math.sin(decRad) * Math.sin(decNGP) + Math.cos(decRad) * Math.cos(decNGP) * Math.cos(raRad - raNGP);
    let b = Math.asin(sinb) * (180 / Math.PI);

    let y = Math.cos(decRad) * Math.sin(raRad - raNGP);
    let x = Math.sin(decRad) * Math.cos(decNGP) - Math.cos(decRad) * Math.sin(decNGP) * Math.cos(raRad - raNGP);
    let l = (lNCP - Math.atan2(y, x)) * (180 / Math.PI);
    if (l < 0) l += 360;

    return { l, b };
}

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
        let l_rad = l_deg * (Math.PI / 180);
        let b_rad = b_deg * (Math.PI / 180);
        let sinL = Math.sin(l_rad);

        // 1. STRICT SINE MASK: Rejection region around Center/Anticenter (l near 0°, 180°, 360°)
        // Division by sin(l) becomes unstable when |sin(l)| < 0.35 (l within ~20° of center line)
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

                // 2. DUAL-REGION GALACTIC GEOMETRY
                let isInnerGalaxy = (l_deg > 20 && l_deg < 80) || (l_deg > 280 && l_deg < 340);

                if (isInnerGalaxy) {
                    // Inner Galaxy (R <= R0)
                    R = R0 * Math.abs(sinL);
                    V_R = (v_centroid / sinL) + V0;
                } else {
                    // Outer Galaxy (R > R0) — Quadrants II & III
                    // Standard Kinematic Distance Model assuming flat rotation (V(R) ~ V0)
                    let denom = (v_centroid / V0) + sinL;
                    if (Math.abs(denom) > 0.05) {
                        R = Math.abs(R0 * sinL / denom);
                        // Reconstruct orbital speed
                        V_R = (v_centroid + V0 * sinL) * (R / (R0 * sinL));
                    }
                }

                // 3. PHYSICAL BOUNDS & SANITY FILTER
                if (R && R >= 2.0 && R <= 16.0 && V_R >= 150 && V_R <= 250) {
                    points.push({
                        x: parseFloat(R.toFixed(2)),
                        y: parseFloat(V_R.toFixed(1)),
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
        // Reject points that jump by more than 35 km/s within a tiny distance step (<= 0.5 kpc)
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

    if (rotationChart) {
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


function renderGalactic2DMap() {
    const canvas = document.getElementById("galacticMapCanvas");
    if (!canvas || !globalBlocksCache || globalBlocksCache.length === 0) return;
    const ctx = canvas.getContext("2d");

    const wrapper = canvas.parentElement;
    const displaySize = Math.min(wrapper.clientWidth || 300, wrapper.clientHeight || 300);

    // 1. High-DPI Canvas Scaling
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(displaySize * dpr);
    canvas.height = Math.floor(displaySize * dpr);
    canvas.style.width = `${displaySize}px`;
    canvas.style.height = `${displaySize}px`;

    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const width = displaySize;
    const height = displaySize;
    const scale = width / 30.0; // 30x30 kpc viewport
    const cx = width / 2;       // Galactic Center (0,0)
    const cy = height / 2;      // Sun at (0, 8.5 kpc)

    const R0 = 8.5;             // Sun-Galactic Center distance (kpc)
    const V0 = 220.0;           // Solar orbital speed (km/s)
    const c = 299792.458;
    const fRest = 1420.4058;

    // 2. Draw Background & Grid
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // Minor Cartesian Grid
    ctx.strokeStyle = "#f1f5f9";
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 5 * scale) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, x); ctx.lineTo(width, x); ctx.stroke();
    }

    // Concentric Radius Rings
    ctx.strokeStyle = "#cbd5e1";
    ctx.setLineDash([4, 4]);
    [4.0, 8.5, 12.0].forEach(r => {
        ctx.beginPath();
        ctx.arc(cx, cy, r * scale, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillStyle = "#94a3b8";
        ctx.font = "9px monospace";
        ctx.fillText(`R=${r}kpc`, cx + 4, cy - (r * scale) - 3);
    });
    ctx.setLineDash([]);

    // Crosshairs
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();

    // 3. Grid Accumulation Setup
    const gridSize = 150;
    const rawGrid = Array.from({ length: gridSize }, () => new Float32Array(gridSize));

    function addPowerToGrid(x_kpc, y_kpc, power) {
        let gx = Math.floor(((x_kpc + 15.0) / 30.0) * gridSize);
        let gy = Math.floor(((y_kpc + 15.0) / 30.0) * gridSize);
        if (gx >= 0 && gx < gridSize && gy >= 0 && gy < gridSize) {
            rawGrid[gy][gx] += power;
        }
    }

    // 4. Data Processing
    globalBlocksCache.forEach((block) => {
        let coords = getGalacticLongitude(block.time);
        if (!coords) return;

        let l_deg = coords.l;
        let b_deg = coords.b || 0;
        let l_rad = l_deg * (Math.PI / 180);
        let b_rad = b_deg * (Math.PI / 180);
        let sinL = Math.sin(l_rad);
        let cosL = Math.cos(l_rad);

        // Mask Singularity Zone (|l| < 15° and |l - 180°| < 15°)
        if (Math.abs(sinL) < 0.25) return;

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

        if (maxP < 0.005) return;

        for (let i = 0; i < block.freqs.length; i++) {
            if (block.freqs[i] < 1420.15 || block.freqs[i] > 1420.50) continue;

            let power = correctedPowers[i];
            if (power < maxP * 0.15) continue;

            let v_raw = c * ((fRest - block.freqs[i]) / fRest);
            let v_lsr = v_raw + v_solar_corr;

            let R = (R0 * V0 * sinL) / (v_lsr + V0 * sinL);
            if (isNaN(R) || R <= 0.5 || R > 16.0) continue;

            let cosVal = R0 * cosL;
            let discriminant = cosVal * cosVal - (R0 * R0 - R * R);
            if (discriminant < 0) continue;

            let sqrtDisc = Math.sqrt(discriminant);
            let d1 = cosVal - sqrtDisc;
            let d2 = cosVal + sqrtDisc;

            // Handle Quadrant Ambiguity for Inner Galaxy (R < R0)
            if (R < R0 && d1 > 0 && d2 > 0) {
                addPowerToGrid(d1 * sinL, R0 - d1 * cosL, power * 0.5);
                addPowerToGrid(d2 * sinL, R0 - d2 * cosL, power * 0.5);
            } else {
                let d = (d1 > 0) ? d1 : d2;
                if (d > 0 && d <= 20.0) {
                    addPowerToGrid(d * sinL, R0 - d * cosL, power);
                }
            }
        }
    });

    // 5. Balanced Gaussian Kernel Smoothing (Fills gaps without over-blurring)
    const grid = Array.from({ length: gridSize }, () => new Float32Array(gridSize));
    let maxDensity = 0;

    for (let y = 1; y < gridSize - 1; y++) {
        for (let x = 1; x < gridSize - 1; x++) {
            let val = rawGrid[y][x] * 0.36 +
                (rawGrid[y-1][x] + rawGrid[y+1][x] + rawGrid[y][x-1] + rawGrid[y][x+1]) * 0.11 +
                (rawGrid[y-1][x-1] + rawGrid[y-1][x+1] + rawGrid[y+1][x-1] + rawGrid[y+1][x+1]) * 0.05;

            grid[y][x] = val;
            if (val > maxDensity) maxDensity = val;
        }
    }

    // Viridis Color Mapping
    function getViridisColor(val) {
        if (val <= 0 || maxDensity === 0) return null;
        let norm = Math.min(val / (maxDensity * 0.55), 1.0);

        let r = Math.floor(68 + norm * (253 - 68));
        let g = Math.floor(1 + Math.sin(norm * Math.PI) * 180 + norm * 50);
        let b = Math.floor(84 + (1 - norm) * 100 - norm * 50);

        return `rgb(${Math.min(r, 253)}, ${Math.min(g, 231)}, ${Math.max(b, 37)})`;
    }

    // 6. Smooth Heatmap Rendering Pipeline
    // ctx.save();
    // Native canvas blur replaces discrete dots with continuous fluid density
    // ctx.filter = "blur(3px)";

    // 6. Connected Heatmap Renderer
    const cellSize = width / gridSize;
    for (let gy = 0; gy < gridSize; gy++) {
        for (let gx = 0; gx < gridSize; gx++) {
            let val = grid[gy][gx];
            // Low threshold restores full arm continuity without background noise
            if (val > maxDensity * 0.008) {
                let color = getViridisColor(val);
                if (color) {
                    ctx.fillStyle = color;
                    // Slight 0.5px overlap connects neighboring bins seamlessly
                    ctx.fillRect(gx * cellSize, gy * cellSize, cellSize + 0.5, cellSize + 0.5);
                }
            }
        }
    }
    // ctx.restore(); // Removes blur filter so text and axes stay crisp

    // 7. Astronomical Annotations (Drawn Crisp After Restore)
    // Galactic Center
    ctx.fillStyle = "#0f172a";
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 2 * Math.PI); ctx.fill();
    ctx.font = "bold 10px system-ui";
    ctx.fillText("Galactic Center (0,0)", cx + 8, cy + 3);

    // Sun Position
    let sunX = cx;
    let sunY = cy - (R0 * scale);
    ctx.fillStyle = "#2563eb";
    ctx.beginPath(); ctx.arc(sunX, sunY, 4, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#1e40af";
    ctx.fillText("Sun (0, 8.5 kpc)", sunX + 8, sunY + 3);
}

// --- Log Handlers ---

async function fetchAndDisplayLog(filePath, logTitle) {
    const modal = document.getElementById("logModal");
    const modalTitle = document.getElementById("logModalTitle");
    const modalBody = document.getElementById("logModalBody");

    modalTitle.innerText = logTitle;
    modalBody.innerText = "Fetching log content...";
    modal.style.display = "flex";

    try {
        const content = await fetchAndDecompress(filePath);
        modalBody.innerText = content || "(Log file is empty)";
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
    const displayTitle = logTitleOverride || `${baseLogName} (${dateInput.value})`;

    // Check if file is a root system log vs daily observation log
    const isSystemLog = baseLogName.includes("telescope_system") || baseLogName.includes("server_web");

    // System logs live at root; daily logs live in YYYY/MM/DD/
    const basePath = isSystemLog
        ? baseLogName
        : `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/${baseLogName}`;

    // 1. Try .gz path first
    fetchAndDisplayLog(`${basePath}.gz`, displayTitle)
        // 2. Fall back to raw file
        .catch(() => fetchAndDisplayLog(basePath, displayTitle))
        // 3. Handle failure if neither exists
        .catch((err) => {
            const modalBody = document.getElementById("logModalBody");
            if (modalBody) {
                modalBody.innerText = `Error loading log: File not found.\nAttempted paths:\n- ${basePath}.gz\n- ${basePath}`;
            }
        });
}

function closeLogModal() {
    document.getElementById("logModal").style.display = "none";
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
