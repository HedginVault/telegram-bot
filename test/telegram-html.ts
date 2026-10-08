const ALLOWED_TAGS = new Set(["b", "i", "code", "a", "blockquote"]);

/** Throws unless every line is self-contained Telegram HTML with escaped text. */
export function assertTelegramHtml(html: string): void {
  for (const line of html.split("\n")) {
    const open: string[] = [];
    const text = line.replace(/<(\/?)([a-z]+)(?: [^<>]*)?>/g, (_, closing: string, tag: string) => {
      if (!ALLOWED_TAGS.has(tag)) throw new Error(`tag <${tag}> is not allowed: ${line}`);
      if (closing) {
        if (open.pop() !== tag) throw new Error(`unbalanced </${tag}>: ${line}`);
      } else open.push(tag);
      return "";
    });
    if (open.length > 0) throw new Error(`unclosed <${open.join(">, <")}>: ${line}`);
    if (/[<>]/.test(text)) throw new Error(`unescaped angle bracket: ${line}`);
    if (/&(?!amp;|lt;|gt;)/.test(text)) throw new Error(`unescaped ampersand: ${line}`);
  }
}
