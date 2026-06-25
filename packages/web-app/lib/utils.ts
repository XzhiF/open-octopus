import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function copyToClipboard(text: string): boolean {
  // 非安全上下文（HTTP）下 clipboard API 不存在，execCommand 会谎报成功
  // 直接返回 false，让调用方走 window.prompt 兜底
  if (!window.isSecureContext) return false

  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (ok) return true
  } catch {
    // fall through
  }

  return false
}

export function stripExt(filename: string): string {
  return filename.replace(/\.ya?ml$/, "")
}
