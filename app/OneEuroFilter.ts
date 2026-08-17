class LowPassFilter {
  private y: number | null = null;

  filter(value: number, alpha: number): number {
    if (this.y === null) {
      this.y = value;
    } else {
      this.y = alpha * value + (1.0 - alpha) * this.y;
    }
    return this.y;
  }

  setLastValue(value: number) {
    this.y = value;
  }
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  private xFilter: LowPassFilter;
  private dxFilter: LowPassFilter;
  private lastTime: number | null = null;

  constructor(minCutoff = 0.5, beta = 0.005, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
  }

  private alpha(cutoff: number, rate: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau * rate);
  }

  filter(value: number, timestamp: number): number {
    if (this.lastTime === null) {
      this.lastTime = timestamp;
      this.xFilter.setLastValue(value);
      this.dxFilter.setLastValue(0);
      return value;
    }

    const dt = (timestamp - this.lastTime) / 1000.0; // convert ms to seconds
    if (dt <= 0) return value;

    const rate = 1.0 / dt;
    this.lastTime = timestamp;

    // Filter the derivative (velocity)
    const prevX = this.xFilter.filter(value, this.alpha(this.minCutoff, rate)); // temporary evaluation
    const dx = (value - prevX) * rate;
    const edx = this.dxFilter.filter(dx, this.alpha(this.dCutoff, rate));

    // Use velocity to change cutoff frequency dynamically
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(value, this.alpha(cutoff, rate));
  }
}
