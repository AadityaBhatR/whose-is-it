/** Copy text. In the desktop app this goes through Electron's clipboard (main process). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.imggame?.copyText) return await window.imggame.copyText(text)
  } catch {
    /* fall through */
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
