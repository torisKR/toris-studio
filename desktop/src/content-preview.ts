/** Card previews show readable text; the editor keeps the original Markdown untouched. */
export function plainPreview(body: string): string {
  return body
    .split("\n")
    .map(line => line
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+)/, "")
      .replace(/(\*\*|__|\x60)(.+?)\1/g, "$2"))
    .filter(line => line.trim())
    .join("\n");
}
