import type { TradeStatsView } from '../dtos/marketStatsView.js';
import { Exact, scale } from './exact.js';

const present = (values: readonly (string | null)[]) => values.flatMap((value) => (value === null ? [] : [new Exact(value)]));

/** Joins the statistics of the pieces of a period: lowest min, highest max, summed volume. */
export const combineStats = (parts: readonly TradeStatsView[]): TradeStatsView => {
  const mins = present(parts.map((part) => part.min));
  const maxes = present(parts.map((part) => part.max));
  const volume = parts.reduce((total, part) => total.plus(part.volume), new Exact(0));
  return {
    min: mins.length === 0 ? null : Exact.min(...mins).toFixed(scale),
    max: maxes.length === 0 ? null : Exact.max(...maxes).toFixed(scale),
    volume: volume.toFixed(scale),
  };
};
