/**
 * Verification modules facade. The implementation lives in the verification-modules-<part>.ts files;
 * this file keeps the public import path stable for callers.
 */
/** Container runtime binary. Tests compare against this constant and do not quote the name. */
export {MODULE_RUNTIME_BIN, runBoundedCollectorProcess, type BoundedProcessResult} from './module-container-cleanup.ts';
export {type CollectorRunnerSpec, DEFAULT_COLLECTOR_TIMEOUT_MS, MAX_COLLECTOR_STDOUT_BYTES, MODULE_CONTAINER_USER, MODULE_MEMORY_BYTES, MODULE_NANO_CPUS, MODULE_PIDS_LIMIT, MODULE_TITLES, ModuleCollectorOutput, ModuleRawFinding, ModuleReportSummary, ModuleToolCoverage, ModuleToolStatus, type VerificationModuleRunInput, type VerificationModuleRunResult, assertModuleRepoRelativePath, assertVerificationModule, collectorMeasuredDetailFile, isVerificationModule} from './verification-modules-contracts.ts';
export {parseModuleCollectorOutput, validateModuleCollectorObject} from './verification-modules-collector.ts';
export {type ModuleRetention, assertPinnedModuleImage, moduleCollectorArguments, moduleDigestPath, parsePinnedModuleImage, prepareModuleSnapshot, readPinnedModuleImage, removeModuleSnapshot, resolveModuleLabImage, runModuleCollectorContainer} from './verification-modules-container.ts';
export {buildModuleReviewPrompt, listModuleReports, moduleReportDirectoryName, readModuleAchadoMarkdown, readModuleReport, renderModuleCoverageMarkdown, writeModuleReport} from './verification-modules-report.ts';
export {runVerificationModule, validateModuleCollectorPublication} from './verification-modules-run.ts';
export {requestModuleCorrection} from './verification-modules-correction.ts';
export {discardModuleReport, reconcileModuleReports} from './verification-modules-persistence.ts';
export {type ModuleRecheckReview, moduleRemeasurementTarget, recheckModuleFindings} from './verification-modules-recheck.ts';
