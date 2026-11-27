import {
  Binary,
  BookMarked,
  Braces,
  Briefcase,
  Bug,
  ClipboardCheck,
  Compass,
  Crosshair,
  Database,
  FileText,
  FolderGit2,
  FolderTree,
  HardDrive,
  KeyRound,
  Layers,
  Library,
  ListTree,
  MessageCircleQuestion,
  PackageOpen,
  ScanSearch,
  ScrollText,
  Server,
  Sigma,
  Stethoscope,
  TableProperties,
  Tags,
  TextSearch,
  UserSearch,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/** 工具 → 专属图标（按能力族分：源码/知识/日志/数据/协查）；未登记的工具兜底扳手。 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  // 源码与反编译
  prepare_source: FolderGit2,
  list_project_files: FolderTree,
  read_project_file: FileText,
  search_project_text: TextSearch,
  search_code_index: ScanSearch,
  search_code_symbols: Braces,
  get_code_outline: ListTree,
  list_code_index_scopes: Layers,
  decompile_binary: Binary,
  // 知识库与技能
  load_skill: PackageOpen,
  search_knowledge: Library,
  get_knowledge_entry: BookMarked,
  list_knowledge_domains: Library,
  list_symptoms: Stethoscope,
  load_business_context: Briefcase,
  // 日志
  search_both_logs: ScrollText,
  search_cloud_logs: ScrollText,
  cloud_search: ScrollText,
  count_logs: Sigma,
  count_cloud_logs: Sigma,
  cloud_count: Sigma,
  count: Sigma,
  cloud_topics: Tags,
  resolve_log_target: Crosshair,
  get_fields: TableProperties,
  // 数据与服务查询
  query: Database,
  lookup_learner: UserSearch,
  lookup_issue: Bug,
  list_services: Server,
  search_services: Server,
  get_storage_type: HardDrive,
  get_simulation_login_token: KeyRound,
  // 协查与产出
  consult_compass: Compass,
  request_compass_followup: MessageCircleQuestion,
  submit_diagnosis_report: ClipboardCheck,
};

export function toolIcon(tool: string): LucideIcon {
  return TOOL_ICONS[tool] ?? Wrench;
}

export function ToolIcon({ tool, size = 13 }: { tool: string; size?: number }) {
  const Icon = toolIcon(tool);
  return <Icon size={size} aria-hidden="true" />;
}
