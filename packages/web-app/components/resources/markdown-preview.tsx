"use client"

/**
 * Simple markdown preview component.
 * Uses the existing preference-prose CSS class for styling.
 * No external markdown library needed for Phase 1 - renders preformatted text
 * with basic markdown-like styling via the preference-prose class.
 */
export function MarkdownPreview({ content }: { content: string }) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">无文档内容</p>
    )
  }

  return (
    <div
      className="preference-prose"
      role="region"
      aria-label="资源文档"
      dangerouslySetInnerHTML={{ __html: simpleMarkdown(content) }}
    />
  )
}

/**
 * Minimal markdown-to-HTML converter for preview.
 * Handles headings, bold, italic, code, links, lists.
 * Uses DOMPurify-style sanitization by only allowing safe elements.
 */
function simpleMarkdown(md: string): string {
  let html = md
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

    // Code blocks (before inline code)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')

    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")

    // Headings
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")

    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")

    // Links — B-06 fix: only allow safe URL protocols (http/https/mailto), block javascript:
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
      const safeUrl = /^(https?:\/\/|mailto:|\/)/.test(url) ? url : '#'
      return `<a href="${safeUrl}" rel="noopener noreferrer">${text}</a>`
    })

    // Unordered lists
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)

    // Paragraphs (double newline)
    .replace(/\n\n/g, "</p><p>")

  // Wrap in paragraph tags
  html = `<p>${html}</p>`

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, "")
  html = html.replace(/<p>\s*(<h[1-6]>)/g, "$1")
  html = html.replace(/(<\/h[1-6]>)\s*<\/p>/g, "$1")
  html = html.replace(/<p>\s*(<pre>)/g, "$1")
  html = html.replace(/(<\/pre>)\s*<\/p>/g, "$1")
  html = html.replace(/<p>\s*(<ul>)/g, "$1")
  html = html.replace(/(<\/ul>)\s*<\/p>/g, "$1")

  return html
}
