import { z } from "zod";

export const KNOWLEDGE_DIRECTORY: string = '.knowledge';
export const BATCHES_DIRECTORY: string = 'batches';
export const SUMMARIES_FILE: string = 'summaries.json';
export const SCAN_FILE: string = 'scan.json';
export const FORMAT_FLAT: string = 'flat';
export const FORMAT_GROUPED: string = 'grouped';
export const FORMAT_VALUES = [FORMAT_FLAT, FORMAT_GROUPED] as const;
export type FormatType = typeof FORMAT_VALUES[number];
export const VERBOSITY_VALUES = ['full', 'structure', 'semantic'] as const;
export type VerbosityType = typeof VERBOSITY_VALUES[number];
export const ROLE_VALUES = ['implementation', 'executable', 'helperScript', 'test', 'configuration', 'build', 'documentation', 'data'] as const;
export type FileRole = typeof ROLE_VALUES[number];
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
  role?: FileRole;
  technologies?: string[];
  searchTags?: string[];
  exports?: string[];
  imports?: string[];
  refs?: string[];       // intra-project file references resolved from imports
  sizeChars?: number;
  lineCount?: number;
  sizeCharsWhenAnalysed?: number;
  lineCountWhenAnalysed?: number;
  analysisDelta?: string;
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
  role?: string;
  technologies?: string[];
  searchTags?: string[];
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

export interface FluentFile { 
  lineCount?: number;
  sizeChars?: number;
  role?: string;
  summary?: string;
  analysisDelta?: string;
  imports?: string[];
  exports?: string[];
  refs?: string[];
  technologies?: string[];
}

export interface FluentFileInGroupedOutput extends FluentFile {
  fileName: string;
}

export interface FluentFileInFlatOutput extends FluentFile {
  path: string;
}

export interface FluentGroup { 
  folderPath: string;
  technologies?: string[];
  files: FluentFileInGroupedOutput[];
}

export type FluentOutput = {
  total?: number;
  grouped?: FluentGroup[];
  results?: FluentFileInFlatOutput[];
}

export interface HierarchicalGrouping {
  folderPath: string;
  folderScore: number;
  technologies?: string[];
  files: GroupedScoredFileSummary[];
}

export interface ScoredFileSummary extends FileSummary {
  path: string;
  fileScore: number;
}

export interface GroupedScoredFileSummary extends FileSummary {
  fileName: string;
  path?: string;
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

export const AudienceType = z.enum([
    'user',
    'assistant'
  ]);
export type AudienceType = z.infer<typeof AudienceType>;

export const ToolContentResult = z.object({
    type: z.literal("text"),
    text: z.string(),
    annotations: z.object({
        audience: z.array(AudienceType).optional(),
        priority: z.number().min(0.0).max(1.0).optional(),
        lastModified: z.string().optional()
    }).strip().strict().optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
  }).strip().strict();
  
export type ToolContentResult = z.infer<typeof ToolContentResult>;

export const AnalysisSubmission = z.object({
  results: z.array(z.object({
    path: z.string(),
    summary: z.string(),
    role: z.enum(ROLE_VALUES).optional(),
    technologies: z.array(z.string()).optional(),
    searchTags: z.array(z.string()).optional()
  }).strip().strict()),
}).strip().strict();

export type AnalysisSubmission = z.infer<typeof AnalysisSubmission>;