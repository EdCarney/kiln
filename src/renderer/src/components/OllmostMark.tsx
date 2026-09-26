/** Ollmost's own mark: an o that almost closes, with a dot in the gap. */
export function OllmostMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M19.49 9.99A7.75 7.75 0 1 1 14.01 4.51" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="17.48" cy="6.52" r="1.5" fill="currentColor" />
    </svg>
  )
}
