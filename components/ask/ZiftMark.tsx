// Zift mark: a Z whose base is sifted into three grains. Decorative only; the
// product name is always present as text beside it.
export function ZiftMark({ size = 16, boxed = false, className = '' }: { size?: number; boxed?: boolean; className?: string }) {
  const mark = <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true" focusable="false" className={boxed ? undefined : `shrink-0 text-cipher-gold ${className}`}>
    <path d="M5.5 5.5h13L7 15.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="7" cy="19.5" r="1.6" fill="currentColor" />
    <circle cx="12" cy="19.5" r="1.6" fill="currentColor" />
    <circle cx="17" cy="19.5" r="1.6" fill="currentColor" />
  </svg>;
  return boxed ? <span className={`inline-flex shrink-0 items-center justify-center border border-cipher-border bg-cipher-surface text-cipher-gold ${className}`} aria-hidden="true">{mark}</span> : mark;
}
