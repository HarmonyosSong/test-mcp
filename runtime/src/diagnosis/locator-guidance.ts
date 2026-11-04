type Locator = { path: string; line: number | null };

const backtick = /`([^`\s]+)`/g;
const pathPattern = /^([\w./-]+\.(?:ets|ts|json5?))(?::(\d+))?(?:-\d+)?$/;
const symbolPattern = /^(?=.*[A-Z_])[A-Za-z_$][\w$]{3,40}$/;

export class CodeLocatorRegistry {
  private readonly symbols = new Map<string, Locator[]>();
  private readonly readRanges = new Map<string, Array<[number, number]>>();

  register(value: unknown): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    const paths: Locator[] = [];
    const symbols: string[] = [];
    for (const [, token] of text.matchAll(backtick)) {
      const match = pathPattern.exec(token!);
      if (match) paths.push({ path: match[1]!, line: match[2] ? Number(match[2]) : null });
      else if (symbolPattern.test(token!)) symbols.push(token!);
    }
    for (const symbol of symbols) {
      const locators = this.symbols.get(symbol) ?? [];
      for (const locator of paths) {
        if (!locators.some((item) => item.path === locator.path && item.line === locator.line)) locators.push(locator);
      }
      this.symbols.set(symbol, locators);
    }
  }

  markRead(path: string, start: number, end: number): void {
    const ranges = this.readRanges.get(path) ?? [];
    ranges.push([start, end]);
    this.readRanges.set(path, ranges);
  }

  hint(query: string): string | null {
    const hits: string[] = [];
    for (const [symbol, locators] of this.symbols) {
      if (!query.toLocaleLowerCase().includes(symbol.toLocaleLowerCase())) continue;
      for (const locator of locators) {
        const covered = (this.readRanges.get(locator.path) ?? []).some(([start, end]) =>
          locator.line === null || (start <= locator.line && locator.line <= end));
        if (!covered) hits.push(`\`${symbol}\` 已索引于 ${locator.path}${locator.line ? `:${locator.line}` : ''}`);
      }
    }
    return hits.length
      ? `知识索引已给出位置:${hits.slice(0, 3).join(';')}。建议直接 read_project_file 该位置 ±60 行核实，无需重新搜索定位。`
      : null;
  }
}
