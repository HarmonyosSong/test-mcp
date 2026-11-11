type TextRedactor = ((text: string) => string) & {
  sensitiveSuffixLength?: (text: string) => number;
};

/** 只保留可能构成敏感标识的尾部，普通文本继续按增量输出。 */
export function createStreamRedactor(redact: TextRedactor) {
  let buffer = '';
  return {
    push(delta: string): string {
      buffer += delta;
      const holdback = redact.sensitiveSuffixLength?.(buffer) ?? 0;
      const end = buffer.length - holdback;
      if (end <= 0) return '';
      const visible = redact(buffer.slice(0, end));
      buffer = buffer.slice(end);
      return visible;
    },
    flush(): string {
      const visible = redact(buffer);
      buffer = '';
      return visible;
    },
  };
}
