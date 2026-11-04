import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface LoadedSkill {
  name: string;
  description: string;
  version: string;
  stage: string;
  modes: string[];
  requiredTools: string[];
  instructions: string;
  source: string;
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
  return match?.[1]?.trim();
}

function metadata(frontmatter: string): string {
  return (frontmatter.match(/^metadata:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? '').replace(/^  /gm, '');
}

function list(fields: string, key: string): string[] {
  const inline = fields.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm'))?.[1];
  if (inline !== undefined) {
    return inline.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  const block = fields.match(new RegExp(`^${key}:\\s*\\n((?:[ \\t]+-\\s*[^\\n]+\\n?)*)`, 'm'))?.[1];
  if (block !== undefined) return [...block.matchAll(/^\s+-\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((match) => match[1]!.trim());
  return [];
}

export function parseSkill(source: string, path: string): LoadedSkill {
  if (!source.startsWith('---\n')) throw new Error(`missing YAML frontmatter: ${path}`);
  const end = source.indexOf('\n---', 4);
  if (end < 0) throw new Error(`invalid frontmatter: ${path}`);
  const frontmatter = source.slice(4, end);
  const metadataFields = metadata(frontmatter);
  const instructions = source.slice(end + 4).trim();
  const name = scalar(frontmatter, 'name');
  const description = scalar(frontmatter, 'description');
  if (!name || !description) throw new Error(`missing skill name or description: ${path}`);
  return {
    name,
    description,
    version: scalar(metadataFields, 'version') ?? '0.1.0',
    stage: scalar(metadataFields, 'stage') ?? 'general',
    modes: list(metadataFields, 'modes').length ? list(metadataFields, 'modes') : ['chat', 'diagnosis'],
    requiredTools: list(metadataFields, 'required_tools'),
    instructions,
    source: path,
  };
}

export class SkillRegistry {
  private readonly skills = new Map<string, LoadedSkill>();

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    const entries = await readdir(resolve(this.directory), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.directory, entry.name, 'SKILL.md');
      try {
        const skill = parseSkill(await readFile(path, 'utf8'), path);
        this.skills.set(skill.name, skill);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  all(): LoadedSkill[] {
    const stageOrder: Record<string, number> = { intake: 0, locate: 1, investigate: 2, diagnose: 3, general: 4 };
    return [...this.skills.values()].sort((left, right) =>
      (stageOrder[left.stage] ?? 99) - (stageOrder[right.stage] ?? 99) || left.name.localeCompare(right.name));
  }

  available(mode: string, tools: Set<string>): LoadedSkill[] {
    return this.all().filter((skill) => skill.modes.includes(mode) && skill.requiredTools.every((tool) => tools.has(tool)));
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  summaries() {
    return this.all().map(({ name, description, version, stage }) => ({ name, description, version, stage }));
  }
}
