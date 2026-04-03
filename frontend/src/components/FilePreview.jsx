import { useEffect } from 'react'

/**
 * Full-screen image preview overlay.
 * PDFs are not shown inline — callers should open them in a new tab instead,
 * since the browser's native PDF viewer gives a far better experience.
 *
 * - Click the backdrop or the × button to close.
 * - Press Escape to close.
 *
 * @param {{ url: string, fileName: string, onClose: () => void }} props
 */
// rerender-no-inline-components: defined at module scope, exported for reuse.
export function FilePreviewOverlay({ url, fileName, onClose }) {
  // Close on Escape key — attach once on mount, clean up on unmount.
  useEffect(() => {
    function handleKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      className="preview-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${fileName}`}
    >
      <button
        type="button"
        className="preview-close"
        onClick={onClose}
        aria-label="Close preview"
      >
        ×
      </button>
      <img
        className="preview-image"
        src={url}
        alt={fileName}
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}
