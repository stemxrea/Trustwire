export const ALPHA = 0.18; // Sweet spot for local radar responsiveness vs smoothing

export function updateTargetSignal(existingTargets: Map<string, number>, deviceId: string, newRssi: number) {
  const prevRssi = existingTargets.get(deviceId);

  if (prevRssi === undefined) {
    // New target initial baseline
    existingTargets.set(deviceId, newRssi);
  } else {
    // Low-pass filter application to block signal noise spikes
    const smoothedRssi = ALPHA * newRssi + (1 - ALPHA) * prevRssi;
    existingTargets.set(deviceId, smoothedRssi);
  }

  return existingTargets;
}
