import { buildSamplingBatches } from "./sampler.js";
import { SamplingBatch, ScanConfig } from "../types.js";
import { buildFileMap } from "./file-map.js";
import { getOrCreateSummaries, toAbsReal } from "./summary-merger.js";
import { relative } from "path";

export function prepareAnalysisBatches(
  filesToScan: string[],
  knowledgeDir: string,
  projectRoot: string,
  config: ScanConfig,
): SamplingBatch[] {
  const existingSummaries = getOrCreateSummaries(knowledgeDir, projectRoot);
  const allProjectFiles = [...new Set([
    ...filesToScan,
    ...[...existingSummaries.files.entries()].filter(([, v]) => !v.deleted)
      .map(([abs]) => relative(toAbsReal(projectRoot, '.'), abs).replace(/\\/g, '/')),
  ])];
  const fileMap = buildFileMap(filesToScan, projectRoot, allProjectFiles);
  return buildSamplingBatches(filesToScan, fileMap, existingSummaries, config, projectRoot);
}