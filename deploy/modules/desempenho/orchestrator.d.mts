export type PreviousPerformanceMeasurement = {examId: string; measurement: Record<string, unknown>};

export function runPerformanceModule(input: {
  snapshotPath: string;
  imageDigest: string;
  recoveryDirectory: string;
  previousMeasurement?: PreviousPerformanceMeasurement;
  previousMeasurements?: AsyncIterable<PreviousPerformanceMeasurement>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
}): Promise<{coverage: unknown; findings: unknown; measurement: Record<string, unknown>; comparedExamId?: string}>;

export function reconcilePerformanceResources(input: {
  recoveryDirectory: string;
  signal?: AbortSignal;
}): Promise<{cleaned: number; pending: number; active: number; invalid: number}>;
