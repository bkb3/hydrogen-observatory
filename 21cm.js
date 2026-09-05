
let myChart = null;
let refreshIntervalId = null;
let playbackIntervalId = null;
let isPlaying = false;
let currentFrameIndex = 0;
let globalBlocksCache = [];

const HYDROGEN_LINE_MHZ = 1420.4058;

// Radio Doppler velocity conversion (km/s)
function freqToVelocity(freqMHz) {
    const C_KMS = 299792.458;
    return C_KMS * ((HYDROGEN_LINE_MHZ - freqMHz) / HYDROGEN_LINE_MHZ);
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

// 3. Fit 3rd-degree polynomial and return raw, fitted baseline, and corrected arrays
function processBaseline(frequencies, powers) {
    let len = powers.length;
    let centerFreq = frequencies[Math.floor(len / 2)];

    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0;
    let sy = 0, sxy = 0, sx2y = 0, sx3y = 0;

    for (let i = 0; i < len; i++) {
        let f = frequencies[i];

        if (f >= 1420.20 && f <= 1420.43) continue;

        let x = f - centerFreq;
        let y = powers[i];
        let x2 = x * x;
        let x3 = x2 * x;

        s0 += 1;
        s1 += x;
        s2 += x2;
        s3 += x3;
        s4 += x3 * x;
        s5 += x3 * x2;
        s6 += x3 * x3;

        sy += y;
        sxy += x * y;
        sx2y += x2 * y;
        sx3y += x3 * y;
    }

    let fittedBaseline = new Array(len);
    let correctedPowers = new Array(len);

    if (s0 < 4) return { fittedBaseline: powers, correctedPowers: powers };

    let matrixA = [
        [s6, s5, s4, s3],
        [s5, s4, s3, s2],
        [s4, s3, s2, s1],
        [s3, s2, s1, s0]
    ];
    let vectorB = [sx3y, sx2y, sxy, sy];

    let [a, b, c, d] = solveCubicSystem(matrixA, vectorB);

    for (let i = 0; i < len; i++) {
        let x = frequencies[i] - centerFreq;
        let baseVal = a * Math.pow(x, 3) + b * x * x + c * x + d;
        fittedBaseline[i] = baseVal;
        correctedPowers[i] = powers[i] - baseVal;
    }

    return { fittedBaseline, correctedPowers };
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
        const targetPath = `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/hydrogen.dat`;

        const response = await fetch(targetPath);
        if (!response.ok) throw new Error(`Observation file '${targetPath}' not found.`);
        const rawText = await response.text();

        let parsedBlocks = [];
        let currentFreqs = [], currentPowers = [], currentTimestamp = "";

        for (let line of rawText.split("\n")) {
            line = line.trim();
            if (!line) continue;

            if (line.startsWith("# Acquisition start:")) {
                if (currentFreqs.length > 0) {
                    // Pre-calculate baseline fit once per block
                    let cleaned = cleanSpikesFilter(currentPowers);
                    let { fittedBaseline, correctedPowers } = processBaseline(currentFreqs, cleaned);
                    let metrics = calculateSmartMetrics(currentFreqs, correctedPowers);

                    parsedBlocks.push({
                        time: currentTimestamp,
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
                if (!isNaN(freqMHz) && !isNaN(powerDB) && freqMHz >= 1420.070 && freqMHz <= 1420.62) {
                    currentFreqs.push(freqMHz);
                    currentPowers.push(powerDB);
                }
            }
        }

        if (currentFreqs.length > 0) {
            let cleaned = cleanSpikesFilter(currentPowers);
            let { fittedBaseline, correctedPowers } = processBaseline(currentFreqs, cleaned);
            let metrics = calculateSmartMetrics(currentFreqs, correctedPowers);

            parsedBlocks.push({
                time: currentTimestamp,
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
        isWaterfallCached = false; // Triggers fresh heatmap build for new observations

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

    if (myChart) {
        myChart.data.labels = freqs;
        myChart.data.datasets[0].data = correctedPowers;
        myChart.data.datasets[1].data = rawPowers;
        myChart.data.datasets[2].data = baselinePowers;

        myChart.data.datasets[1].hidden = !isOverlay;
        myChart.data.datasets[2].hidden = !isOverlay;
        myChart.options.scales.y1.display = isOverlay;

        myChart.options.scales.x1.min = minFreq;
        myChart.options.scales.x1.max = maxFreq;

        // myChart.options.plugins.title.text = `Timestamp: ${timestamp} (Local: ${new Date(timestamp).toLocaleString()})`;
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
                    title: { display: true, text: "Observed Frequency (MHz)", color: "#334155", font: { size: 12, weight: "bold" } },
                    grid: { color: "#f1f5f9" },
                    ticks: { color: "#475569", callback: (val) => val.toFixed(3) }
                },
                x1: {
                    type: "linear",
                    position: "top",
                    min: minFreq,
                    max: maxFreq,
                    title: { display: true, text: "Doppler Velocity (km/s)", color: "#2563eb", font: { size: 12, weight: "bold" } },
                    grid: { drawOnChartArea: false },
                    ticks: {
                        color: "#2563eb",
                        callback: function (freqVal) {
                            const velocity = freqToVelocity(freqVal);
                            return `${velocity > 0 ? "+" : ""}${velocity.toFixed(0)} km/s`;
                        }
                    }
                },
                y: {
                    type: "linear",
                    position: "left",
                    min: -1.0,
                    max: 3.0,
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
                // title: { display: true, text: `Timestamp: ${timestamp} (Local: ${new Date(timestamp).toLocaleString()})`, color: "#0f172a", font: { size: 13, weight: "bold" } },
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
                            const c = 299792.458;
                            const fRest = 1420.4058;
                            const velocity = c * ((fRest - freq) / fRest);
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

    let jd = (utcDate.getTime() / 86400000) + 2440587.5;
    let d = jd - 2451545.0;
    let lst = (280.46061837 + 360.98564736629 * d + 84.43) % 360;
    if (lst < 0) lst += 360;

    let ra = lst * (Math.PI / 180);
    let dec = -32.32 * (Math.PI / 180);

    let raNGP = 192.85948 * (Math.PI / 180);
    let decNGP = 27.12825 * (Math.PI / 180);
    let lNCP = 122.93200 * (Math.PI / 180);

    let sinb = Math.sin(dec) * Math.sin(decNGP) + Math.cos(dec) * Math.cos(decNGP) * Math.cos(ra - raNGP);
    let b = Math.asin(sinb) * (180 / Math.PI);

    let y = Math.cos(dec) * Math.sin(ra - raNGP);
    let x = Math.sin(dec) * Math.cos(decNGP) - Math.cos(dec) * Math.sin(decNGP) * Math.cos(ra - raNGP);
    let l = (lNCP - Math.atan2(y, x)) * (180 / Math.PI);
    if (l < 0) l += 360;

    return { l, b };
}

function renderRotationCurve() {
    if (!globalBlocksCache || globalBlocksCache.length === 0) return;

    const R0 = 8.5;
    const V0 = 220.0;
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

        if (Math.abs(sinL) < 0.15) return;

        // Use pre-computed correctedPowers directly
        let correctedPowers = block.correctedPowers;

        let v_solar_corr = 9.0 * Math.cos(l_rad) * Math.cos(b_rad) +
            12.0 * Math.sin(l_rad) * Math.cos(b_rad) +
            7.0 * Math.sin(b_rad);

        let maxP = -999;
        for (let i = 0; i < block.freqs.length; i++) {
            if (block.freqs[i] >= 1420.15 && block.freqs[i] <= 1420.50) {
                if (correctedPowers[i] > maxP) maxP = correctedPowers[i];
            }
        }

        if (maxP > 0.02) {
            let maxV_LSR = null;

            for (let i = 0; i < block.freqs.length; i++) {
                if (block.freqs[i] < 1420.15 || block.freqs[i] > 1420.50) continue;
                if (correctedPowers[i] >= maxP * 0.20) {
                    let v_raw = c * ((fRest - block.freqs[i]) / fRest);
                    let v_lsr = v_raw + v_solar_corr;

                    if (maxV_LSR === null || Math.abs(v_lsr) > Math.abs(maxV_LSR)) {
                        maxV_LSR = v_lsr;
                    }
                }
            }

            if (maxV_LSR !== null) {
                let R, V_R;

                if ((l_deg > 15 && l_deg < 82) || (l_deg > 278 && l_deg < 345)) {
                    R = R0 * Math.abs(sinL);
                    V_R = maxV_LSR + V0 * Math.abs(sinL);
                } else {
                    let denom = V0 * sinL - maxV_LSR;
                    if (Math.abs(denom) > 1.0) {
                        R = Math.abs(R0 * (V0 * sinL) / denom);
                    } else {
                        R = R0 + 1.0;
                    }
                    V_R = Math.abs(maxV_LSR + V0 * sinL);
                }

                if (R >= 1.5 && R <= 18.0 && V_R >= 160 && V_R <= 260) {
                    points.push({
                        x: parseFloat(R.toFixed(2)),
                        y: parseFloat(V_R.toFixed(1)),
                        l: l_deg.toFixed(1)
                    });
                }
            }
        }
    });

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

    let binnedPoints = [];
    for (let r in binMap) {
        let avgV = binMap[r].vSum / binMap[r].count;
        let midL = binMap[r].lList[Math.floor(binMap[r].lList.length / 2)];

        binnedPoints.push({
            x: parseFloat(r),
            y: parseFloat(avgV.toFixed(1)),
            l: midL
        });
    }

    points = binnedPoints;
    points.sort((a, b) => a.x - b.x);

    // Theoretical Models tuned to your observational baseline
    let flatModel = [];
    let keplerianModel = [];

    const R_scale = 2.2;     // Smooth curve fit for the inner disk
    const R_disk_edge = 8.0; // Peak Keplerian decay at Solar Circle (R0)

    for (let r = 1.0; r <= 17.5; r += 0.5) {
        // Flat Model (Dark Matter Halo Present)
        let vFlat = 220.0 * (1.0 - Math.exp(-r / R_scale));
        flatModel.push({ x: r, y: parseFloat(vFlat.toFixed(1)) });

        // Keplerian Model (No Dark Matter - Visible Disk Only)
        let vKepler;
        if (r <= R_disk_edge) {
            // Solid-body interior rotation up to R0
            vKepler = 220.0 * (r / R_disk_edge);
        } else {
            // Keplerian falloff past the visible disk boundary
            vKepler = 220.0 * Math.sqrt(R_disk_edge / r);
        }
        keplerianModel.push({ x: r, y: parseFloat(vKepler.toFixed(1)) });
    }

    const canvas = document.getElementById("rotationChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    if (rotationChart) {
        rotationChart.data.datasets[0].data = points;
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
                    data: points,
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
                    title: { display: true, text: "Galactocentric Distance R (kpc)", color: "#334155", font: { weight: "bold" } },
                    // min: 0,
                    // max: 18
                },
                y: {
                    title: { display: true, text: "Orbital Speed V(R) (km/s)", color: "#1e3a8a", font: { weight: "bold" } },
                    // min: 100,
                    // max: 300
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

// --- Log Handlers ---

async function fetchAndDisplayLog(filePath, logTitle) {
    const modal = document.getElementById("logModal");
    const modalTitle = document.getElementById("logModalTitle");
    const modalBody = document.getElementById("logModalBody");

    modalTitle.innerText = logTitle;
    modalBody.innerText = "Fetching log content...";
    modal.style.display = "flex";

    try {
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`Could not fetch log file at '${filePath}'.`);
        const content = await response.text();
        modalBody.innerText = content || "(Log file is empty)";
    } catch (err) {
        modalBody.innerText = `Error: ${err.message}`;
    }
}

function viewDailyScanLog() {
    const dateInput = document.getElementById("obsDateInput");
    if (!dateInput.value) return;
    const dateParts = dateInput.value.split("-");
    if (dateParts.length !== 3) return;

    const logPath = `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/scan_errors.log`;
    fetchAndDisplayLog(logPath, `Scan Log (${dateInput.value})`);
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
});
