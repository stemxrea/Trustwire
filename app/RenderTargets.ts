export interface RadarTarget {
  id: string;
  rssi: number;
  type: 'BLE' | 'WiFi';
}

export function calculateRadarCoordinates(
  target: RadarTarget,
  index: number,
  total: number,
  maxRadiusPx: number,
  minRadiusPx = 0,
) {
  const safeTotal = Math.max(1, total);

  // Clamp RSSI between -40 (near) and -100 (far)
  const clampedRssi = Math.max(-100, Math.min(-40, Number.isFinite(target.rssi) ? target.rssi : -100));
  const distanceRatio = (clampedRssi - (-40)) / (-100 - (-40)); // 0 (near) → 1 (far)
  const clampedMin = Math.max(0, Math.min(minRadiusPx, maxRadiusPx));
  const radius = clampedMin + distanceRatio * (maxRadiusPx - clampedMin);

  // Fallback spread angle when no trusted hardware angle exists
  const angle = (index * (2 * Math.PI)) / safeTotal;

  // Polar -> Cartesian
  const x = radius * Math.cos(angle);
  const y = radius * Math.sin(angle);

  return { x, y };
}
