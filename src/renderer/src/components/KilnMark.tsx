/** Kiln's own mark: a kiln arch with an ember inside. */
export function KilnMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M4.5 20.5v-9a7.5 7.5 0 0 1 15 0v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M2.5 20.5h19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M12 9.2c1.9 1.9 3.1 3.4 3.1 5.3a3.1 3.1 0 0 1-6.2 0c0-1.2.5-2.1 1.3-2.9.2.9.7 1.5 1.3 1.7-.2-1.4.1-2.8.5-4.1Z"
        fill="currentColor"
      />
    </svg>
  )
}
