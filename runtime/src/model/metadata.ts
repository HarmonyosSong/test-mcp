export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.2': 400_000,
  'gpt-5-mini': 400_000,
  'deepseek-v4-pro': 128_000,
  'deepseek-flash': 128_000,
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  'qwen-plus': 131_072,
  'qwen-max': 262_144,
  'qwen-turbo': 131_072,
  'kimi-k3': 262_144,
  'moonshot-v1-8k': 8_192,
  'moonshot-v1-32k': 32_768,
  'glm-5.3': 200_000,
  'glm-4-flash': 128_000,
  'glm-4-plus': 128_000,
  'doubao-seed-2-1-pro-260628': 262_144,
  k3: 1_048_576,
  'k3-256k': 262_144,
  'kimi-for-coding': 262_144,
  'kimi-for-coding-highspeed': 262_144,
};

export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'deepseek-chat': { input: 2, output: 8 },
  'deepseek-reasoner': { input: 4, output: 16 },
  'qwen-plus': { input: 0.8, output: 4.8 },
  'qwen-max': { input: 20, output: 60 },
  'qwen-turbo': { input: 0.3, output: 3 },
  'moonshot-v1-8k': { input: 12, output: 12 },
  'moonshot-v1-32k': { input: 24, output: 24 },
  'glm-4-flash': { input: 0, output: 0 },
  'glm-4-plus': { input: 50, output: 50 },
};

export const REPOSITORY_MCP_TOOL_NAMES = [
  'list_project_files',
  'search_project_text',
  'read_project_file',
  'parse_hilog',
  'load_business_context',
];
