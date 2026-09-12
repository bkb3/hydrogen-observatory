async function fetchAndParseScanLog(dateParts) {
    const basePath = `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}/scan.log`;
    const logMetricsMap = new Map();

    try {
        const logText = await fetchAndDecompress(`${basePath}.gz`)
            .catch(() => fetchAndDecompress(basePath))
            .catch(() => "");

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
        displayGlobalError("Error", err.message);
        console.warn("Could not parse scan log metrics:", err);
    }

    return logMetricsMap;
}

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


function solveCubicSystem(matrixA, vectorB) {
    const n = 4;
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

        if (Math.abs(aug[i][i]) < 1e-12) return [0, 0, 0, 0];

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

function processBaseline(frequencies, powers, iterations = 5) {
    const len = powers.length;
    if (len === 0) return { fittedBaseline: [], correctedPowers: [] };

    let centerFreq = frequencies[Math.floor(len / 2)];
    let activePowers = [...powers];
    let finalBaseline = new Array(len);

    for (let iter = 0; iter < iterations; iter++) {
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

        for (let i = 0; i < len; i++) {
            let x = frequencies[i] - centerFreq;
            finalBaseline[i] = a * Math.pow(x, 3) + b * x * x + c * x + d;
        }

        let diffs = powers.map((p, idx) => p - finalBaseline[idx]);
        let mean = diffs.reduce((sum, val) => sum + val, 0) / len;
        let stdDev = Math.sqrt(diffs.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / len);

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