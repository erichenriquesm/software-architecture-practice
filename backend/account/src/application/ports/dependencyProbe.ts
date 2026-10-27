export interface DependencyProbe {
  readonly dependency: string;
  isHealthy(): Promise<boolean>;
}
