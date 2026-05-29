export const KNOWLEDGE_DIRECTORY: string = '.knowledge';
export const SUMMARIES_FILE: string = 'summaries.json';
export const SCAN_FILE: string = 'scan.json';
export const FORMAT_FLAT: string = 'flat';
export const FORMAT_GROUPED: string = 'grouped';
export const QUERY_RESULT_MAX: number = 25;
export const SAMPLING_DELAY_MS: number = 1500;
export const SAMPLING_TOKEN_BUDGET: number = 50_000;
export const ENV_INCLUDE_PATHS = 'PROJECT_INTEL_TOOL_INCLUDE_PATHS';
export const ENV_EXCLUDE_PATHS = 'PROJECT_INTEL_TOOL_EXCLUDE_PATHS';

export interface ScanConfig {
  maxTokensPerBatch: number;
  minBatchTokens: number;
  charsPerToken: number;
  includePaths: string[];
  excludePaths: string[];
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  maxTokensPerBatch: SAMPLING_TOKEN_BUDGET,
  minBatchTokens: 3_200,
  charsPerToken: 2.5,
  includePaths: [],
  excludePaths: [],
};

export interface SubKnowledgeRef {
  location: string;
  knowledgeDir: string;
}

export interface FileSummary {
  summary?: string;
  purpose?: string;
  role?: string;
  technologies?: string[];
  exports?: string[];
  imports?: string[];
  refs?: string[];       // intra-project file references resolved from imports
  sizeChars?: number;
  lineCount?: number;
  deleted?: boolean;
  lastUpdated?: string;
}

export interface SummariesDataStorage {
  generated: string;
  files: { [filePath: string]: FileSummary };
  subKnowledge?: SubKnowledgeRef[];
}

export interface SummariesData {
  generated: string;
  files: Map<string, FileSummary>;
  subKnowledge: SubKnowledgeRef[];
}

// Output of one sampling call per file; refs/sizeChars/lineCount merged from file-map before persisting
export interface SamplingFileSummary {
  path: string;
  summary?: string;
  purpose?: string;
  role?: string;
  technologies?: string[];
  exports?: string[];
  imports?: string[];
  refs?: string[];
  sizeChars?: number;
  lineCount?: number;
}

export interface SamplingBatch {
  files: string[];
  contextFiles: { path: string; summary: string }[];
  estimatedTokens: number;
}

// Query output
export interface HierarchicalGrouping {
  folderPath: string;
  folderScore: number;
  files: GroupedScoredFileSummary[];
}

export interface ScoredFileSummary extends FileSummary {
  path: string;
  fileScore: number;
}

export interface GroupedScoredFileSummary extends FileSummary {
  fileName: string;
  path?: string;
  fileScore: number;
}

// Session start hook
export interface HookResponse {
  continue: boolean;
  suppressOutput: boolean;
  systemMessage: string;
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}
