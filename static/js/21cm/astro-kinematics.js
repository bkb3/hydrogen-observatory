let rotationChart = null;
let densityChart = null;
let phaseChartInstance = null;

let cachedMappedPoints = null;
let cachedMaxPower = 0.001;
let cachedMinPower = 0.001;
const viridisSprites = [];
const SPRITE_SIZE = 16;
const NUM_BINS = 10;

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
    let gmst = (280.46061837 + 360.98564736629 * d) % 360;
    let lstDeg = (gmst + 84.43) % 360;
    if (lstDeg < 0) lstDeg += 360;

    const decRad = -32.32 * (Math.PI / 180);
    const haRad = 0;
    const raRad = (lstDeg * (Math.PI / 180)) - haRad;

    const raNGP = 192.85948 * (Math.PI / 180);
    const decNGP = 27.12825 * (Math.PI / 180);
    const lNCP = 122.93200 * (Math.PI / 180);

    let sinb = Math.sin(decRad) * Math.sin(decNGP) + Math.cos(decRad) * Math.cos(decNGP) * Math.cos(raRad - raNGP);
    let b = Math.asin(Math.max(-1, Math.min(1, sinb))) * (180 / Math.PI);

    let y = Math.cos(decRad) * Math.sin(raRad - raNGP);
    let x = Math.sin(decRad) * Math.cos(decNGP) - Math.cos(decRad) * Math.sin(decNGP) * Math.cos(raRad - raNGP);

    let l = (lNCP * (180 / Math.PI) - Math.atan2(y, x) * (180 / Math.PI));
    l = (l % 360 + 360) % 360;

    return { l, b };
}

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

function updateGalacticPointsCache() {
    cachedMappedPoints = [];
    cachedMaxPower = 0.001;

    const R0 = 8.5, V0 = 220.0, c = 299792.458, fRest = 1420.4058;
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

        let blockMaxPower = 0;
        for (let i = 0; i < block.freqs.length; i++) {
            if (block.freqs[i] >= 1420.15 && block.freqs[i] <= 1420.50) {
                if (block.correctedPowers[i] > blockMaxPower) {
                    blockMaxPower = block.correctedPowers[i];
                }
            }
        }

        const blockNoiseCutoff = Math.max(ABSOLUTE_MIN_POWER, blockMaxPower * 0.15);
        cachedMinPower = blockNoiseCutoff

        const v_solar_corr = 11.1 * Math.cos(l_rad) * Math.cos(b_rad) +
            12.24 * Math.sin(l_rad) * Math.cos(b_rad) +
            7.25 * Math.sin(b_rad);

        const correctedPowers = block.correctedPowers;

        for (let i = 0; i < block.freqs.length; i++) {
            if (block.freqs[i] < 1420.15 || block.freqs[i] > 1420.50) continue;

            const power = correctedPowers[i];
            if (power < blockNoiseCutoff) continue;

            let v_raw = c * ((fRest - block.freqs[i]) / fRest);
            let v_lsr = v_raw + v_solar_corr;
            let proj_factor = sinL * Math.cos(b_rad);

            let R = (R0 * V0 * proj_factor) / (v_lsr + V0 * proj_factor);

            if (R < R0) {
                v_raw = -1 * c * ((fRest - block.freqs[i]) / fRest);
                v_lsr = v_raw + v_solar_corr;
                R = (R0 * V0 * proj_factor) / (v_lsr + V0 * proj_factor);
            }

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
    const scale = width / 34.0;
    const cx = width / 2;
    const cy = height / 2;
    const R0 = 8.5;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "#f1f5f9";
    ctx.lineWidth = 1;
    const step = 5 * scale;
    for (let x = cx % step; x <= width; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = cy % step; y <= height; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();

    const radii = [4.0, 8.5, 12.0, 16.0];
    radii.forEach(r => {
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = r === 8.5 ? "rgba(37, 99, 235, 0.4)" : "#cbd5e1";
        ctx.arc(cx, cy, r * scale, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);

        const labelText = `${r} kpc`;
        ctx.font = "600 8px monospace";
        ctx.textBaseline = "middle";
        
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 3;
        ctx.strokeText(labelText, cx + 4, cy - (r * scale));
        ctx.fillStyle = r === 8.5 ? "#2563eb" : "#64748b";
        ctx.fillText(labelText, cx + 4, cy - (r * scale));
    });

    const arms = [
        { name: "Scutum-Centaurus Arm", r: 5.5, color: "#9333ea", bg: "rgba(243, 232, 255, 0.9)", start: 0.4, end: 1.1, labelAngle: 0.75 },
        { name: "Sagittarius-Carina Arm", r: 7.0, color: "#059669", bg: "rgba(209, 250, 229, 0.9)", start: 0.55, end: 1.25, labelAngle: 0.9 },
        { name: "Perseus Arm", r: 10.5, color: "#e11d48", bg: "rgba(ffe4e6, 0.9)", start: 0.7, end: 1.4, labelAngle: 1.05 }
    ];

    arms.forEach(arm => {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = arm.color;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(cx, cy, arm.r * scale, Math.PI * arm.start, Math.PI * arm.end);
        ctx.stroke();
        ctx.globalAlpha = 1.0;

        const lx = cx + Math.cos(Math.PI * arm.labelAngle) * (arm.r * scale);
        const ly = cy + Math.sin(Math.PI * arm.labelAngle) * (arm.r * scale);

        ctx.font = "600 9px system-ui, -apple-system, sans-serif";
        const metrics = ctx.measureText(arm.name);
        const padX = 5, padY = 2;
        const bw = metrics.width + padX * 2;
        const bh = 12 + padY * 2;

        ctx.fillStyle = arm.bg;
        ctx.strokeStyle = arm.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(lx - bw / 2, ly - bh / 2, bw, bh, 3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = arm.color;
        ctx.textBaseline = "middle";
        ctx.fillText(arm.name, lx - bw / 2 + padX, ly + 0.5);
    });

    const spriteSize = Math.max(6, 1.4 * scale);
    const halfSprite = spriteSize / 2;

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

        ctx.globalAlpha = 0.3 + (normPower * 0.7);
        ctx.drawImage(viridisSprites[binIndex], px, py, spriteSize, spriteSize);
    }
    ctx.restore();

    ctx.fillStyle = "#d97706";
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 2 * Math.PI); ctx.fill();

    ctx.font = "bold 10px system-ui";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.strokeText("Galactic Center (Sgr A*)", cx + 8, cy + 3);
    ctx.fillStyle = "#0f172a";
    ctx.fillText("Galactic Center (Sgr A*)", cx + 8, cy + 3);

    const sunX = cx;
    const sunY = cy - (R0 * scale);

    ctx.fillStyle = "#0284c7";
    ctx.beginPath(); ctx.arc(sunX, sunY, 3.5, 0, 2 * Math.PI); ctx.fill();

    ctx.strokeStyle = "#0284c7";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sunX, sunY, 7, 0, 2 * Math.PI); ctx.stroke();

    ctx.font = "bold 10px system-ui";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.strokeText("Sun (0, 8.5 kpc)", sunX + 11, sunY + 3);
    ctx.fillStyle = "#0369a1";
    ctx.fillText("Sun (0, 8.5 kpc)", sunX + 11, sunY + 3);

    ctx.strokeStyle = "rgba(2, 132, 199, 0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(sunX, sunY, 1.8 * scale, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "600 8px system-ui";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.strokeText("Local Bubble / Orion Spur", sunX - 42, sunY - (1.8 * scale) - 5);
    ctx.fillStyle = "#0284c7";
    ctx.fillText("Local Bubble / Orion Spur", sunX - 42, sunY - (1.8 * scale) - 5);

    const minLabel = document.getElementById("mapMinPowerVal");
    const maxLabel = document.getElementById("mapMaxPowerVal");

    if (minLabel) minLabel.textContent = `Min: ${cachedMinPower.toFixed(3)} dB`;
    if (maxLabel) maxLabel.textContent = `Max: ${cachedMaxPower.toFixed(3)} dB`;
}


function drawTelescopeLineOfSight(timestampStr = null) {
    const canvas = document.getElementById("galacticMapCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const displaySize = parseFloat(canvas.style.width) || canvas.width;
    const width = displaySize;
    const height = displaySize;
    const scale = width / 34.0;
    const cx = width / 2;
    const cy = height / 2;
    const R0 = 8.5;

    let time = timestampStr;
    if (!time && typeof globalBlocksCache !== "undefined" && globalBlocksCache.length > 0) {
        const frameIdx = typeof currentFrameIndex !== "undefined" ? currentFrameIndex : 0;
        if (globalBlocksCache[frameIdx]) {
            time = globalBlocksCache[frameIdx].time;
        }
    }
    if (!time) time = new Date().toISOString();

    const galactic = typeof getGalacticLongitude === "function" ? getGalacticLongitude(time) : null;
    if (!galactic || galactic.l === null || galactic.l === undefined) return;

    const lDeg = galactic.l;
    const lRad = lDeg * (Math.PI / 180);

    const sunX = cx;
    const sunY = cy - (R0 * scale);
    const rayLength = 22.0;

    const targetX = sunX + (rayLength * Math.sin(lRad)) * scale;
    const targetY = sunY + (rayLength * Math.cos(lRad)) * scale;

    ctx.save();

    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(sunX, sunY);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(targetX, targetY, 4, 0, 2 * Math.PI);
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(targetX, targetY, 1.5, 0, 2 * Math.PI);
    ctx.fillStyle = "#dc2626";
    ctx.fill();

    let shortTime = "--:--";
    try {
        const timeMatch = time.match(/(\d{2}:\d{2})/);
        if (timeMatch) shortTime = timeMatch[1];
    } catch (e) {}

    const labelText = `Az 180° El 30° | l = ${lDeg.toFixed(1)}° | ${shortTime} UTC`;

    ctx.font = "600 10px system-ui, -apple-system, sans-serif";
    const textMetrics = ctx.measureText(labelText);
    const textWidth = textMetrics.width;
    const textHeight = 11;

    const padX = 6;
    const padY = 4;
    const boxWidth = textWidth + padX * 2;
    const boxHeight = textHeight + padY * 2;

    let boxX = targetX - boxWidth / 2;
    let boxY = targetY < sunY ? targetY - boxHeight - 8 : targetY + 10;

    boxX = Math.max(8, Math.min(boxX, width - boxWidth - 8));
    boxY = Math.max(8, Math.min(boxY, height - boxHeight - 8));

    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#b91c1c";
    ctx.textBaseline = "middle";
    ctx.fillText(labelText, boxX + padX, boxY + boxHeight / 2);

    ctx.restore();
}

function renderRotationCurve() {
    if (!globalBlocksCache || globalBlocksCache.length === 0) return;

    const R0 = 8.5, V0 = 220.0, c = 299792.458, fRest = 1420.4058;
    let points = [];

    globalBlocksCache.forEach((block) => {
        let coords = getGalacticLongitude(block.time);
        if (!coords) return;

        let l_deg = (coords.l % 360 + 360) % 360;
        let b_deg = coords.b || 0;

        let l_rad = l_deg * (Math.PI / 180);
        let b_rad = b_deg * (Math.PI / 180);
        let sinL = Math.sin(l_rad);

        if (Math.abs(sinL) < 0.35) return;

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
            let weightedV_sum = 0, weightSum = 0;

            for (let i = 0; i < block.freqs.length; i++) {
                if (block.freqs[i] < 1420.15 || block.freqs[i] > 1420.50) continue;

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
                let isInnerGalaxy = (l_deg > 20 && l_deg < 80) || (l_deg > 280 && l_deg < 340);
                let proj_factor = sinL * Math.cos(b_rad);

                if (isInnerGalaxy) {
                    R = R0 * Math.abs(sinL);
                    V_R = (v_centroid / sinL) + V0;
                } else {
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

    let cleanPoints = finalBinnedPoints.filter((p, i, arr) => {
        if (i === 0) return true;
        let prev = arr[i - 1];
        return !(Math.abs(p.x - prev.x) <= 0.5 && Math.abs(p.y - prev.y) > 35);
    });

    let flatModel = [], keplerianModel = [];
    const R_scale = 2.2, R_disk_edge = 8.0;

    for (let r = 1.0; r <= 17.5; r += 0.5) {
        let vFlat = 220.0 * (1.0 - Math.exp(-r / R_scale));
        flatModel.push({ x: r, y: parseFloat(vFlat.toFixed(1)) });

        let vKepler = (r <= R_disk_edge)
            ? 220.0 * Math.sqrt(1.0 - Math.exp(-r / R_scale))
            : 220.0 * Math.sqrt(R_disk_edge / r);
        keplerianModel.push({ x: r, y: parseFloat(vKepler.toFixed(1)) });
    }

    const canvas = document.getElementById("rotationChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

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
                    backgroundColor: "rgba(37, 99, 235, 0.85)",
                    borderColor: "#ffffff",
                    borderWidth: 1.5,
                    pointRadius: 4.5,
                    pointHoverRadius: 6.5,
                    pointHoverBackgroundColor: "#2563eb",
                    pointHoverBorderColor: "#ffffff",
                    pointHoverBorderWidth: 2,
                    showLine: false
                },
                {
                    label: "Flat Curve (Dark Matter)",
                    data: flatModel,
                    type: "line",
                    borderColor: "#10b981",
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.3,
                    fill: false
                },
                {
                    label: "Keplerian Decay (No Dark Matter)",
                    data: keplerianModel,
                    type: "line",
                    borderColor: "#f43f5e",
                    borderWidth: 2,
                    borderDash: [4, 4],
                    pointRadius: 0,
                    tension: 0.3,
                    fill: false
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
                    grid: { color: "#f1f5f9", drawBorder: false },
                    ticks: { color: "#64748b", font: { size: 11 } },
                    title: {
                        display: true,
                        text: "Galactocentric Distance R (kpc)",
                        color: "#334155",
                        font: { size: 12, weight: "600" }
                    }
                },
                y: {
                    grid: { color: "#f1f5f9", drawBorder: false },
                    ticks: { color: "#64748b", font: { size: 11 } },
                    title: {
                        display: true,
                        text: "Orbital Speed V(R) (km/s)",
                        color: "#334155",
                        font: { size: 12, weight: "600" }
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                    labels: { color: "#334155", font: { size: 11 }, boxWidth: 12, usePointStyle: true }
                },
                tooltip: {
                    backgroundColor: "#0f172a",
                    titleColor: "#f8fafc",
                    bodyColor: "#f8fafc",
                    padding: 10,
                    cornerRadius: 6,
                    callbacks: {
                        label: (ctx) => {
                            if (ctx.dataset.type === "line") {
                                return `${ctx.dataset.label}: ${ctx.parsed.y} km/s`;
                            }
                            return `Observed R: ${ctx.parsed.x} kpc | V: ${ctx.parsed.y} km/s (l=${ctx.raw.l}°)`;
                        }
                    }
                }
            }
        }
    });
}

function renderColumnDensity() {
    if (!globalBlocksCache || globalBlocksCache.length === 0) return;

    const c = 299792.458;
    const fRest = 1420.4058;
    let densityProfile = [];

    globalBlocksCache.forEach((block) => {
        let coords = getGalacticLongitude(block.time);
        if (!coords) return;

        let l_deg = (coords.l % 360 + 360) % 360;
        let correctedPowers = block.correctedPowers;
        let numChannels = block.freqs.length;
        if (numChannels < 2) return;

        const deltaF = Math.abs(block.freqs[numChannels - 1] - block.freqs[0]) / (numChannels - 1);
        const deltaV = (deltaF / fRest) * c;

        let integratedSignalArea = 0;
        for (let i = 0; i < numChannels; i++) {
            if (block.freqs[i] < 1420.15 || block.freqs[i] > 1420.50) continue;
            if (correctedPowers[i] > 0.005) {
                integratedSignalArea += correctedPowers[i] * deltaV;
            }
        }

        const CALIBRATION_GAIN_FACTOR = 400.0;
        let columnDensity = (1.823e18 * integratedSignalArea * CALIBRATION_GAIN_FACTOR) / 1e21;

        if (columnDensity > 0) {
            densityProfile.push({
                x: parseFloat(l_deg.toFixed(1)),
                y: parseFloat(columnDensity.toFixed(3)),
                time: block.time
            });
        }
    });

    densityProfile.sort((a, b) => a.x - b.x);

    const canvas = document.getElementById("densityChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    if (typeof densityChart !== 'undefined' && densityChart) {
        densityChart.data.datasets[0].data = densityProfile;
        densityChart.update();
        return;
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, "rgba(37, 99, 235, 0.35)");
    gradient.addColorStop(1, "rgba(37, 99, 235, 0.0)");

    densityChart = new Chart(ctx, {
        type: "line",
        data: {
            datasets: [
                {
                    label: "HI Column Density",
                    data: densityProfile,
                    backgroundColor: gradient,
                    borderColor: "#2563eb",
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: "#2563eb",
                    pointHoverBorderColor: "#ffffff",
                    pointHoverBorderWidth: 2,
                    fill: true,
                    tension: 0.35
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: "nearest",
                intersect: false
            },
            scales: {
                x: {
                    type: "linear",
                    min: 0,
                    max: 360,
                    ticks: { stepSize: 45, color: "#64748b", font: { size: 11 } },
                    grid: { color: "#f1f5f9", drawBorder: false },
                    title: {
                        display: true,
                        text: "Galactic Longitude l (°)",
                        color: "#334155",
                        font: { size: 12, weight: "600" }
                    }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: "#64748b", font: { size: 11 } },
                    grid: { color: "#f1f5f9", drawBorder: false },
                    title: {
                        display: true,
                        text: "N_HI (×10²¹ cm⁻²)",
                        color: "#334155",
                        font: { size: 12, weight: "600" }
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#0f172a",
                    titleColor: "#f8fafc",
                    bodyColor: "#f8fafc",
                    padding: 10,
                    cornerRadius: 6,
                    displayColors: false,
                    callbacks: {
                        title: (items) => `Galactic Longitude: ${items[0].parsed.x}°`,
                        label: (ctx) => `N_HI: ${ctx.parsed.y} ×10²¹ cm⁻²`
                    }
                }
            }
        }
    });
}

function calculateOortA_WNM(dLocal = 1.0, sin2lCutoff = 0.20, powerThreshold = 0.005, cnmFraction = 0.35, sharpnessCutoff = 0.002) {
    if (!globalBlocksCache || !globalBlocksCache.length) return null;

    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, count = 0;

    globalBlocksCache.forEach(function (block) {
        if (!block?.correctedPowers || !block.freqs || !block.time) return;

        let powers = block.correctedPowers;
        let freqs = block.freqs;
        let len = powers.length;
        if (len < 5) return;

        let maxP = Math.max.apply(null, powers);
        if (maxP < 0.01) return;

        let coords = getGalacticLongitude(block.time);
        if (!coords) return;

        let l_rad = coords.l * (Math.PI / 180);
        let b_rad = (coords.b || 0) * (Math.PI / 180);
        let sin2l = Math.sin(2 * l_rad);

        if (Math.abs(sin2l) < sin2lCutoff) return;

        let v_solar_corr = 11.1 * Math.cos(l_rad) * Math.cos(b_rad) +
            12.24 * Math.sin(l_rad) * Math.cos(b_rad) +
            7.25 * Math.sin(b_rad);

        let cnmThreshold = maxP * cnmFraction;
        let wnmPowerSum = 0;
        let wnmVWeightedSum = 0;

        for (let i = 1; i < len - 1; i++) {
            let p = powers[i];
            if (p <= powerThreshold) continue;

            let v = freqToVelocity(freqs[i]);
            let sharpness = Math.abs(powers[i - 1] - (2 * p) + powers[i + 1]);

            if (p < cnmThreshold || sharpness <= sharpnessCutoff) {
                let v_lsr = v + v_solar_corr;
                wnmPowerSum += p;
                wnmVWeightedSum += v_lsr * p;
            }
        }

        if (wnmPowerSum > 0) {
            let v_wnm_lsr = wnmVWeightedSum / wnmPowerSum;
            let termX = dLocal * sin2l * Math.pow(Math.cos(b_rad), 2);
            let termY = v_wnm_lsr;

            sumX += termX;
            sumY += termY;
            sumXY += termX * termY;
            sumXX += termX * termX;
            count++;
        }
    });

    if (count < 5) return null;

    let meanX = sumX / count;
    let meanY = sumY / count;
    let oortA = Math.abs((sumXY - count * meanX * meanY) / (sumXX - count * meanX * meanX));
    let iauStandard = 15.3;
    let deviation = Math.abs((oortA - iauStandard) / iauStandard) * 100;

    return {
        cleanFrames: count,
        oortA: parseFloat(oortA.toFixed(2)),
        iauStandard: iauStandard,
        deviationPct: parseFloat(deviation.toFixed(1))
    };
}

function analyzeGasPhases(cnmFractionThreshold = 0.35, sharpnessThreshold = 0.002, powerFloor = 0.005) {
    if (!globalBlocksCache || !globalBlocksCache.length) return null;

    let totalCNMPower = 0, totalWNMPower = 0;
    let cnmDenseCount = 0, highShearCount = 0;
    let phaseReport = [];

    globalBlocksCache.forEach(function (block, index) {
        if (!block?.correctedPowers || !block.freqs || !block.time) return;

        let powers = block.correctedPowers;
        let freqs = block.freqs;
        let len = powers.length;
        if (len < 5) return;

        let maxP = Math.max.apply(null, powers);
        if (maxP < 0.01) return;

        let coords = getGalacticLongitude(block.time);
        let cnmPeakCutoff = maxP * cnmFractionThreshold;

        let cnmPower = 0, cnmVSum = 0;
        let wnmPower = 0, wnmVSum = 0;

        for (let i = 1; i < len - 1; i++) {
            let p = powers[i];
            if (p <= powerFloor) continue;

            let v = freqToVelocity(freqs[i]);
            let sharpness = Math.abs(powers[i - 1] - (2 * p) + powers[i + 1]);

            if (p >= cnmPeakCutoff && sharpness > sharpnessThreshold) {
                cnmPower += p;
                cnmVSum += v * p;
            } else {
                wnmPower += p;
                wnmVSum += v * p;
            }
        }

        let totalFramePower = cnmPower + wnmPower;
        if (totalFramePower === 0) return;

        let vCNM = cnmPower > 0 ? (cnmVSum / cnmPower) : 0;
        let vWNM = wnmPower > 0 ? (wnmVSum / wnmPower) : 0;
        let cnmRatio = (cnmPower / totalFramePower) * 100;
        let wnmRatio = 100 - cnmRatio;
        let deltaV = Math.abs(vCNM - vWNM);

        totalCNMPower += cnmPower;
        totalWNMPower += wnmPower;

        if (cnmRatio >= 40.0) cnmDenseCount++;
        if (deltaV >= 15.0) highShearCount++;

        phaseReport.push({
            frame: index + 1,
            time: block.time.split(" ")[1] || block.time,
            galacticL: coords ? coords.l.toFixed(1) + "°" : "N/A",
            cnmPercent: parseFloat(cnmRatio.toFixed(1)),
            wnmPercent: parseFloat(wnmRatio.toFixed(1)),
            vCNM: parseFloat(vCNM.toFixed(2)),
            vWNM: parseFloat(vWNM.toFixed(2)),
            shearDeltaV: parseFloat(deltaV.toFixed(2))
        });
    });

    let grandTotalPower = totalCNMPower + totalWNMPower;
    let globalCNM = grandTotalPower > 0 ? (totalCNMPower / grandTotalPower) * 100 : 0;
    let globalWNM = grandTotalPower > 0 ? (totalWNMPower / grandTotalPower) * 100 : 0;

    let summary = {
        totalFrames: phaseReport.length,
        globalCNMPercent: parseFloat(globalCNM.toFixed(1)),
        globalWNMPercent: parseFloat(globalWNM.toFixed(1)),
        denseCloudFrames: cnmDenseCount,
        highShearFrames: highShearCount,
        framesData: phaseReport
    };

    renderPhaseChartJS(phaseReport);
    return summary;
}

function renderPhaseChartJS(data) {
    const canvasId = "phaseChartCanvas";
    let canvas = document.getElementById(canvasId);

    if (!canvas) {
        const container = document.createElement("div");
        container.className = "chart-wrapper";

        canvas = document.createElement("canvas");
        canvas.id = canvasId;
        container.appendChild(canvas);

        // Appends to card wrapper if available, otherwise fallback to body
        const targetParent = document.getElementById("phaseCard") || document.body;
        targetParent.appendChild(container);
    }

    const labels = data.map((d) => d.galacticL !== "N/A" ? d.galacticL : `F${d.frame}`);
    const cnmData = data.map((d) => d.cnmPercent);
    const wnmData = data.map((d) => d.wnmPercent);
    const shearData = data.map((d) => d.shearDeltaV);

    const ctx = canvas.getContext("2d");

    if (typeof phaseChartInstance !== 'undefined' && phaseChartInstance) {
        phaseChartInstance.data.labels = labels;
        phaseChartInstance.data.datasets[0].data = shearData;
        phaseChartInstance.data.datasets[1].data = cnmData;
        phaseChartInstance.data.datasets[2].data = wnmData;
        phaseChartInstance.update();
        return;
    }

    phaseChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [
                {
                    label: "Kinematic Shear |Δv|",
                    type: "line",
                    data: shearData,
                    borderColor: "#f59e0b",
                    backgroundColor: "#f59e0b",
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: "#f59e0b",
                    pointHoverBorderColor: "#ffffff",
                    pointHoverBorderWidth: 2,
                    tension: 0.35,
                    yAxisID: "yShear",
                    order: 1
                },
                {
                    label: "CNM % (Cold)",
                    data: cnmData,
                    backgroundColor: "#06b6d4",
                    borderRadius: { topLeft: 0, topRight: 0, bottomLeft: 4, bottomRight: 4 },
                    stack: "phaseStack",
                    yAxisID: "yPhase",
                    order: 2
                },
                {
                    label: "WNM % (Warm)",
                    data: wnmData,
                    backgroundColor: "#475569",
                    borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
                    stack: "phaseStack",
                    yAxisID: "yPhase",
                    order: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            scales: {
                x: {
                    stacked: true,
                    ticks: { color: "#64748b", font: { size: 11 }, maxRotation: 45 },
                    grid: { color: "#f1f5f9", drawBorder: false },
                    title: {
                        display: true,
                        text: "Galactic Longitude l (°)",
                        color: "#334155",
                        font: { size: 12, weight: "600" }
                    }
                },
                yPhase: {
                    type: "linear",
                    position: "left",
                    stacked: true,
                    min: 0,
                    max: 100,
                    ticks: { color: "#64748b", font: { size: 11 } },
                    grid: { color: "#f1f5f9", drawBorder: false },
                    title: {
                        display: true,
                        text: "Phase Ratio (%)",
                        color: "#0891b2",
                        font: { size: 12, weight: "600" }
                    }
                },
                yShear: {
                    type: "linear",
                    position: "right",
                    min: 0,
                    ticks: { color: "#d97706", font: { size: 11 } },
                    grid: { drawOnChartArea: false, drawBorder: false },
                    title: {
                        display: true,
                        text: "|Δv| Shear (km/s)",
                        color: "#d97706",
                        font: { size: 12, weight: "600" }
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                    labels: { color: "#334155", font: { size: 11 }, boxWidth: 12, usePointStyle: true }
                },
                tooltip: {
                    backgroundColor: "#0f172a",
                    titleColor: "#f8fafc",
                    bodyColor: "#f8fafc",
                    padding: 10,
                    cornerRadius: 6,
                    callbacks: {
                        title: (items) => `Galactic Longitude: ${items[0].label}`,
                        label: (ctx) => {
                            if (ctx.dataset.type === "line") {
                                return `Kinematic Shear: ${ctx.parsed.y} km/s`;
                            }
                            return `${ctx.dataset.label}: ${ctx.parsed.y}%`;
                        }
                    }
                }
            }
        }
    });
}