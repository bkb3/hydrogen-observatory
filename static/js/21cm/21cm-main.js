// static/21cm/21cm-main.js

async function loadAndPlotData(forceReload = false) {
    const statusEl = document.getElementById('statusMessage');
    const datePicker = document.getElementById('datePicker');

    if (statusEl) statusEl.innerText = 'Fetching spectrum data...';

    // Safely retrieve selected date or fallback to today
    const selectedDate = (datePicker && datePicker.value)
        ? datePicker.value
        : new Date().toISOString().split('T')[0];

    const dateParts = selectedDate.split('-');
    if (dateParts.length !== 3) return;

    const [year, month, day] = dateParts;
    const basePath = `${year}/${month}/${day}/hydrogen.dat`;

    try {
        // Parallel fetch for compressed raw spectrum data and scan log
        const [rawText, logFreqMap] = await Promise.all([
            fetchAndDecompress(`${basePath}.gz`)
                .catch(() => fetchAndDecompress(`${basePath}`))
                .catch((err) => {
                    throw new Error(`File not found or unreadable.\n\nAttempted paths:\n- ${basePath}.gz\n- ${basePath}`);
                }),
            fetchAndParseScanLog(dateParts).catch((err) => {
                console.warn(`Could not parse scan log for ${selectedDate}:`, err);
                return new Map(); // Fallback empty map if scan log fails
            })
        ]);

        let parsedBlocks = [];
        let currentFreqs = [], currentPowers = [], currentTimestamp = "";

        // Parse line-by-line raw ASCII spectrum output
        for (let line of rawText.split("\n")) {
            line = line.trim();
            if (!line) continue;

            if (line.startsWith("# Acquisition start:")) {
                if (currentFreqs.length > 0) {
                    let cleaned = cleanSpikesFilter(currentPowers);
                    let { fittedBaseline, correctedPowers } = processBaseline(currentFreqs, cleaned);
                    let metrics = typeof calculateSmartMetrics === "function" ? calculateSmartMetrics(currentFreqs, correctedPowers) : {};
                    const logData = logFreqMap.get(currentTimestamp);

                    parsedBlocks.push({
                        time: currentTimestamp,
                        timestamp: currentTimestamp,
                        tunedFreq: logData?.tunedFreq ?? "N/A",
                        integrationTime: logData?.integrationTime ?? "N/A",
                        freqs: currentFreqs,
                        frequencies: currentFreqs,
                        powers: currentPowers,
                        rawPowers: currentPowers,
                        cleanedPowers: cleaned,
                        fittedBaseline: fittedBaseline,
                        baselinePowers: fittedBaseline,
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

                // Filter within frequency range bounds
                const minF = typeof minFreqMHzFilter !== "undefined" ? minFreqMHzFilter : -Infinity;
                const maxF = typeof maxFreqMHzFilter !== "undefined" ? maxFreqMHzFilter : Infinity;

                if (!isNaN(freqMHz) && !isNaN(powerDB) && freqMHz >= minF && freqMHz <= maxF) {
                    currentFreqs.push(freqMHz);
                    currentPowers.push(powerDB);
                }
            }
        }

        // Flush last remaining frame block
        if (currentFreqs.length > 0) {
            let cleaned = cleanSpikesFilter(currentPowers);
            let { fittedBaseline, correctedPowers } = processBaseline(currentFreqs, cleaned);
            let metrics = typeof calculateSmartMetrics === "function" ? calculateSmartMetrics(currentFreqs, correctedPowers) : {};
            const logData = logFreqMap.get(currentTimestamp);

            parsedBlocks.push({
                time: currentTimestamp,
                timestamp: currentTimestamp,
                tunedFreq: logData?.tunedFreq ?? "N/A",
                integrationTime: logData?.integrationTime ?? "N/A",
                freqs: currentFreqs,
                frequencies: currentFreqs,
                powers: currentPowers,
                rawPowers: currentPowers,
                cleanedPowers: cleaned,
                fittedBaseline: fittedBaseline,
                baselinePowers: fittedBaseline,
                correctedPowers: correctedPowers,
                metrics: metrics
            });
        }

        if (parsedBlocks.length === 0) {
            throw new Error('Decompressed data is empty or malformed.');
        }

        // Synchronize Global Application State
        if (typeof state !== "undefined") {
            state.globalBlocksCache = parsedBlocks;
            state.currentFrameIndex = parsedBlocks.length - 1;
        }
        globalBlocksCache = parsedBlocks;
        isWaterfallCached = false;
        cachedMappedPoints = null;

        // Dynamic Waterfall Ticks Calculation
        const freqs = parsedBlocks[0].freqs;
        const minFreq = Math.min(...freqs);
        const maxFreq = Math.max(...freqs);
        if (typeof updateWaterfallTicks === "function") {
            updateWaterfallTicks(minFreq, maxFreq);
        }

        // Populate Dropdown Selection Lists
        const timestamps = parsedBlocks.map((b) => b.time);
        populateDropdownMenus(timestamps);

        const startSel = document.getElementById("startTimeSelect");
        const endSel = document.getElementById("endTimeSelect");
        if (startSel) startSel.value = 0;
        if (endSel) endSel.value = parsedBlocks.length - 1;

        // Render Canvas Views
        buildWaterfallCache();
        const activeIdx = parsedBlocks.length - 1;
        renderSingleFrame(activeIdx);

        if (typeof renderWaterfallFull === "function") renderWaterfallFull();
        if (typeof renderRotationCurve === "function") renderRotationCurve();

        // Calculate and Render Oort Kinematic Constants
        if (typeof calculateOortA_WNM === "function") {
            const summary = calculateOortA_WNM();
            const elOortA = document.getElementById('statOortA');
            const elOortIAU = document.getElementById('statOortIAU');
            const elOortDev = document.getElementById('statOortDev');
            const elOortFrames = document.getElementById('statOortFrames');

            if (elOortA) elOortA.innerText = summary.oortA ?? "--";
            if (elOortIAU) elOortIAU.innerText = summary.iauStandard ?? "--";
            if (elOortDev) elOortDev.innerText = summary.deviationPct ?? "--";
            if (elOortFrames) elOortFrames.innerText = summary.cleanFrames ?? summary.deviationPct ?? "--";
        }

        if (typeof renderColumnDensity === "function") renderColumnDensity();
        if (typeof analyzeGasPhases === "function") analyzeGasPhases();

        if (statusEl) statusEl.innerText = `Loaded ${parsedBlocks.length} frames successfully.`;

    } catch (err) {
        if (statusEl) statusEl.innerText = 'Failed to load spectrum data.';
        displayGlobalError(`Loading Data (${selectedDate})`, err.message || err);
    }
}

function bindEventListeners() {
    document.getElementById('headerRefreshBtn')?.addEventListener('click', () => loadAndPlotData(true));
    document.getElementById('refreshBtn')?.addEventListener('click', () => loadAndPlotData(true));

    document.getElementById('datePicker')?.addEventListener('change', () => loadAndPlotData(true));
    document.getElementById('prevFrameBtn')?.addEventListener('click', () => stepFrame(-1));
    document.getElementById('nextFrameBtn')?.addEventListener('click', () => stepFrame(1));
    document.getElementById('playPauseBtn')?.addEventListener('click', () => togglePlayback(loadAndPlotData));
    document.getElementById('autoRefreshCheck')?.addEventListener('change', toggleAutoRefresh);

    document.getElementById('frameSelect')?.addEventListener('change', (e) => {
        renderSingleFrame(parseInt(e.target.value, 10));
    });

    document.getElementById('viewLogBtnScan')?.addEventListener('click', () => {
        viewDailyScanLog('scan.log', 'Daily Scan Log');
    });

    document.getElementById('viewLogBtnSys')?.addEventListener('click', () => {
        viewDailyScanLog('telescope_system.log', 'Telescope System Log');
    });

    document.getElementById('closeModalBtn')?.addEventListener('click', closeLogModal);

    window.addEventListener('resize', () => {
        renderWaterfallFull();
        renderGalactic2DMap();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const datePicker = document.getElementById('datePicker');
    if (datePicker && !datePicker.value) {
        datePicker.value = new Date().toISOString().split('T')[0];
    }

    bindEventListeners();
    loadAndPlotData();
    
});