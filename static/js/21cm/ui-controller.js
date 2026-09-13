const staticWaterfallCanvas = document.createElement("canvas");
const staticWaterfallCtx = staticWaterfallCanvas.getContext("2d");
let isWaterfallCached = false;

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

    renderChart(block.freqs, block.cleanedPowers, block.fittedBaseline, block.correctedPowers, block.time);
    renderGalactic2DMap(true);
    drawTelescopeLineOfSight(block.time);
    renderWaterfallFull();

    // if (document.getElementById("waterfallToggleCheck").checked) {
    //     renderWaterfallFull();
    // }

}

function renderChart(freqs, rawPowers, baselinePowers, correctedPowers, timestamp) {
    // const isOverlay = document.getElementById("overlayModeCheck")?.checked || false;
    const minFreq = freqs[0];
    const maxFreq = freqs[freqs.length - 1];

    const freqPadding = (maxFreq - minFreq) * 0.02;
    const paddedMin = minFreq - freqPadding;
    const paddedMax = maxFreq + freqPadding;

    // Convert frequency array to Chart.js linear points {x, y}
    const correctedData = freqs.map((f, i) => ({ x: f, y: correctedPowers[i] }));
    const rawData = freqs.map((f, i) => ({ x: f, y: rawPowers[i] }));
    const baselineData = freqs.map((f, i) => ({ x: f, y: baselinePowers[i] }));

    if (typeof myChart !== "undefined" && myChart) {
        myChart.data.datasets[0].data = correctedData;
        myChart.data.datasets[1].data = rawData;
        myChart.data.datasets[2].data = baselineData;

        // myChart.data.datasets[1].hidden = !isOverlay;
        // myChart.data.datasets[2].hidden = !isOverlay;
        // myChart.options.scales.y1.display = isOverlay;

        myChart.options.scales.x.min = paddedMin;
        myChart.options.scales.x.max = paddedMax;
        myChart.options.scales.x1.min = paddedMin;
        myChart.options.scales.x1.max = paddedMax;

        myChart.update();
        return;
    }

    const canvas = document.getElementById("spectrumChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Dynamic blue fill gradient for spectrum line
    const fillGradient = ctx.createLinearGradient(0, 0, 0, 300);
    fillGradient.addColorStop(0, "rgba(37, 99, 235, 0.25)");
    fillGradient.addColorStop(1, "rgba(37, 99, 235, 0.0)");

    // Rest Frame Vertical Indicator Badge
    const hydrogenLineAnnotation = {
        id: "hydrogenLineVerticalBar",
        afterDraw: (chart) => {
            const { ctx, chartArea: { top, bottom, left, right }, scales: { x } } = chart;
            const pixelX = x.getPixelForValue(HYDROGEN_LINE_MHZ);

            if (pixelX >= left && pixelX <= right) {
                ctx.save();

                // Dotted vertical line
                ctx.beginPath();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = "#ef4444";
                ctx.setLineDash([4, 4]);
                ctx.moveTo(pixelX, top);
                ctx.lineTo(pixelX, bottom);
                ctx.stroke();

                // Background pill badge for text label
                const labelText = "HI REST (0 km/s)";
                ctx.font = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
                const textWidth = ctx.measureText(labelText).width;
                const badgeX = pixelX + 6;
                const badgeY = top + 8;

                ctx.fillStyle = "#fee2e2";
                ctx.beginPath();
                ctx.roundRect(badgeX, badgeY, textWidth + 10, 18, 4);
                ctx.fill();

                // Badge text
                ctx.fillStyle = "#991b1b";
                ctx.fillText(labelText, badgeX + 5, badgeY + 12);

                ctx.restore();
            }
        }
    };

    myChart = new Chart(ctx, {
        type: "line",
        data: {
            datasets: [
                {
                    label: "Corrected Power",
                    data: correctedData,
                    borderColor: "#2563eb",
                    backgroundColor: fillGradient,
                    fill: true,
                    borderWidth: 1.8,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHoverBackgroundColor: "#2563eb",
                    tension: 0.1,
                    yAxisID: "y"
                },
                {
                    label: "Raw Uncorrected",
                    data: rawData,
                    borderColor: "#94a3b8",
                    borderWidth: 1,
                    pointRadius: 0,
                    yAxisID: "y1",
                    // hidden: !isOverlay
                },
                {
                    label: "Fitted Baseline",
                    data: baselineData,
                    borderColor: "#f59e0b",
                    borderWidth: 1.5,
                    borderDash: [4, 4],
                    pointRadius: 0,
                    yAxisID: "y1",
                    // hidden: !isOverlay
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "nearest", intersect: false },
            scales: {
                x: {
                    type: "linear",
                    position: "bottom",
                    min: paddedMin,
                    max: paddedMax,
                    grid: { color: "#f1f5f9", drawBorder: false },
                    ticks: {
                        color: "#64748b",
                        font: { size: 11 },
                        callback: (val) => val.toFixed(3)
                    },
                    title: {
                        display: true,
                        text: "Observed Frequency (MHz)",
                        color: "#334155",
                        font: { size: 12, weight: "600" }
                    }
                },
                x1: {
                    type: "linear",
                    position: "top",
                    min: paddedMin,
                    max: paddedMax,
                    grid: { drawOnChartArea: false, drawBorder: false },
                    ticks: {
                        color: "#2563eb",
                        font: { size: 11 },
                        callback: function (freqVal) {
                            const velocity = freqToVelocity(freqVal);
                            if (Math.abs(velocity) < 0.5) return "0 km/s";
                            return `${velocity > 0 ? "+" : ""}${Math.round(velocity)} km/s`;
                        }
                    },
                    title: {
                        display: true,
                        text: "Doppler Velocity (km/s)",
                        color: "#2563eb",
                        font: { size: 12, weight: "600" }
                    }
                },
                y: {
                    type: "linear",
                    position: "left",
                    min: -1,
                    max: 1,
                    grid: { color: "#f1f5f9", drawBorder: false },
                    ticks: { color: "#64748b", font: { size: 11 } },
                    title: {
                        display: true,
                        text: "Corrected Power (dB)",
                        color: "#334155",
                        font: { size: 12, weight: "600" }
                    }
                },
                y1: {
                    type: "linear",
                    position: "right",
                    // display: isOverlay,
                    grid: { drawOnChartArea: false, drawBorder: false },
                    ticks: { color: "#64748b", font: { size: 11 } },
                    title: {
                        display: true,
                        text: "Raw Hardware Power (dB)",
                        color: "#64748b",
                        font: { size: 12, weight: "600" }
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                    align: "end",
                    labels: { color: "#334155", font: { size: 11 }, boxWidth: 12, usePointStyle: true }
                },
                tooltip: {
                    backgroundColor: "#0f172a",
                    titleColor: "#f8fafc",
                    bodyColor: "#f8fafc",
                    padding: 10,
                    cornerRadius: 6,
                    callbacks: {
                        title: function (tooltipItems) {
                            if (!tooltipItems.length) return "";
                            const freq = tooltipItems[0].parsed.x;
                            return `Frequency: ${freq.toFixed(4)} MHz`;
                        },
                        afterTitle: function (tooltipItems) {
                            if (!tooltipItems.length) return "";
                            const freq = tooltipItems[0].parsed.x;
                            const velocity = freqToVelocity(freq);
                            const sign = velocity > 0 ? "+" : "";
                            return `Velocity: ${sign}${velocity.toFixed(2)} km/s`;
                        },
                        label: function (ctx) {
                            return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(3)} dB`;
                        }
                    }
                }
            }
        },
        plugins: [hydrogenLineAnnotation]
    });
}


function buildWaterfallCache() {
    if (!globalBlocksCache || globalBlocksCache.length === 0) return;

    const numBlocks = globalBlocksCache.length;
    const numBins = globalBlocksCache[0].freqs ? globalBlocksCache[0].freqs.length : globalBlocksCache[0].correctedPowers.length;

    staticWaterfallCanvas.width = numBins;
    staticWaterfallCanvas.height = numBlocks;

    let globalMin = Infinity;
    let globalMax = -Infinity;

    for (let b = 0; b < numBlocks; b++) {
        let powers = globalBlocksCache[b].correctedPowers;
        if (!powers) continue;
        for (let i = 0; i < numBins; i++) {
            if (powers[i] < globalMin) globalMin = powers[i];
            if (powers[i] > globalMax) globalMax = powers[i];
        }
    }

    if (globalMin === Infinity) globalMin = -0.2;
    if (globalMax === -Infinity || globalMax === globalMin) globalMax = 1.0;

    const range = globalMax - globalMin || 1;
    const staticCtx = staticWaterfallCanvas.getContext("2d");
    const imgData = staticCtx.createImageData(numBins, numBlocks);
    const data = imgData.data;

    for (let b = 0; b < numBlocks; b++) {
        let powers = globalBlocksCache[b].correctedPowers;
        if (!powers) continue;

        for (let i = 0; i < numBins; i++) {
            let val = powers[i];
            let norm = Math.max(0, Math.min(1, (val - globalMin) / range));
            
            let color = getInfernoColor(norm);

            let pixelIdx = (b * numBins + i) * 4;
            data[pixelIdx]     = color.r;
            data[pixelIdx + 1] = color.g;
            data[pixelIdx + 2] = color.b;
            data[pixelIdx + 3] = 255;
        }
    }

    staticCtx.putImageData(imgData, 0, 0);
    isWaterfallCached = true;

    const waterfallMin = document.getElementById("waterfallMinPowerVal");
    const waterfallMax = document.getElementById("waterfallMaxPowerVal");

    if (waterfallMin) waterfallMin.textContent = `Min: ${globalMin.toFixed(3)} dB`;
    if (waterfallMax) waterfallMax.textContent = `Max: ${globalMax.toFixed(3)} dB`;
}


function renderWaterfallFull() {
    const container = document.getElementById("waterfallContainer");
    if (container.style.display === "none" || !globalBlocksCache || globalBlocksCache.length === 0) return;

    if (!isWaterfallCached) {
        buildWaterfallCache();
    }

    // --- Update Dynamic Min/Max Power Legend ---
    let globalMinPower = Infinity;
    let globalMaxPower = -Infinity;

    globalBlocksCache.forEach(block => {
        if (!block.correctedPowers) return;
        for (let i = 0; i < block.correctedPowers.length; i++) {
            const p = block.correctedPowers[i];
            if (p < globalMinPower) globalMinPower = p;
            if (p > globalMaxPower) globalMaxPower = p;
        }
    });

    const waterfallMin = document.getElementById("waterfallMinPowerVal");
    const waterfallMax = document.getElementById("waterfallMaxPowerVal");

    if (waterfallMin) {
        waterfallMin.textContent = `Min: -0.200 dB`;
    }
    if (waterfallMax && typeof globalMax !== "undefined") {
        waterfallMax.textContent = `Max: ${globalMax.toFixed(3)} dB`;
    }
    // -------------------------------------------

    const canvas = document.getElementById("waterfallCanvas");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    ctx.scale(dpr, dpr);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staticWaterfallCanvas, 0, 0, displayWidth, displayHeight);

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

        // Left triangle pointer (pointing right)
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.moveTo(0, activeY - 4);
        ctx.lineTo(6, activeY);
        ctx.lineTo(0, activeY + 4);
        ctx.closePath();
        ctx.fill();

        // Right triangle pointer (pointing left)
        ctx.beginPath();
        ctx.moveTo(displayWidth, activeY - 4);
        ctx.lineTo(displayWidth - 6, activeY);
        ctx.lineTo(displayWidth, activeY + 4);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }
}

function toggleOverlayMode() {
    if (globalBlocksCache.length > 0) renderSingleFrame(currentFrameIndex);
}

// function toggleWaterfallDisplay() {
//     const isChecked = document.getElementById("waterfallToggleCheck").checked;
//     document.getElementById("waterfallContainer").style.display = isChecked ? "block" : "none";
//     if (isChecked) renderWaterfallFull();
// }

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
        playBtn.innerHTML = '▶️ <span class="btn-text">Play</span>';
    } else {
        if (startIdx >= endIdx) {
            alert("Start block must be before End block!");
            return;
        }
        isPlaying = true;
        playBtn.innerHTML = '⏸️ <span class="btn-text">Pause</span>';
        currentFrameIndex = startIdx;

        playbackIntervalId = setInterval(() => {
            renderSingleFrame(currentFrameIndex);
            currentFrameIndex++;
            if (currentFrameIndex > endIdx) {
                clearInterval(playbackIntervalId);
                isPlaying = false;
                playBtn.innerHTML = '▶️ <span class="btn-text">Play</span>';
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

// window.addEventListener("resize", () => {
//     if (document.getElementById("waterfallToggleCheck").checked) {
//         renderWaterfallFull();
//     }
// });

