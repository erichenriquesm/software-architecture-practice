import type { DepthView } from '../dtos/depthView.js';

export interface DepthDao {
  /** The pre-aggregated levels of the last applied snapshot; an empty book (sequence 0) before the first one. */
  findByPrecision(marketId: string, precision: number): Promise<DepthView>;
}
