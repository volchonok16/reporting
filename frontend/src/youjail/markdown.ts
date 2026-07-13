function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/@\[([^\]]+)\]\(employee:\d+\)/g, '<span class="youjail-mention-chip">@$1</span>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

export function mentionPreviewText(markdown: string): string {
  return markdown
    .replace(/@\[([^\]]+)\]\(employee:\d+\)/g, '@$1')
    .split('\n')
    .find((line) => line.trim()) ?? ''
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const chunks: string[] = []
  let inCode = false
  let codeLines: string[] = []
  let listItems: string[] = []

  const flushList = () => {
    if (listItems.length === 0) return
    chunks.push(`<ul>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`)
    listItems = []
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushList()
      if (inCode) {
        chunks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        codeLines = []
        inCode = false
      } else {
        inCode = true
      }
      continue
    }

    if (inCode) {
      codeLines.push(line)
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      listItems.push(line.replace(/^[-*]\s+/, ''))
      continue
    }

    flushList()

    if (!line.trim()) {
      continue
    }
    if (line.startsWith('### ')) {
      chunks.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`)
    } else if (line.startsWith('## ')) {
      chunks.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`)
    } else if (line.startsWith('# ')) {
      chunks.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`)
    } else {
      chunks.push(`<p>${inlineMarkdown(line)}</p>`)
    }
  }

  flushList()
  if (inCode && codeLines.length > 0) {
    chunks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  }

  return chunks.join('') || '<p class="youjail-md-empty">Нет заметок</p>'
}
