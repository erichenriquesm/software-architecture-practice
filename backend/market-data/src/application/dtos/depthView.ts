export interface DepthLevelView {
  readonly quantity: string;
  readonly price: string;
}

export interface DepthView {
  /** Highest price first. */
  readonly buys: readonly DepthLevelView[];
  /** Lowest price first. */
  readonly sells: readonly DepthLevelView[];
  readonly sequence: number;
  readonly asOf: string | null;
}
