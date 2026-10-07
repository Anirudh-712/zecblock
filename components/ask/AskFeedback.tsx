'use client';
import { useEffect, useState } from 'react';
import { askFailure, type AskFailure } from '@/lib/ask/client';
import styles from './AskFeedback.module.css';

export function useAskFeedback() {
  const [failure, setFailure] = useState<AskFailure | null>(null);
  const [blockedUntil, setBlockedUntil] = useState(0);
  useEffect(() => {
    if (!blockedUntil) return;
    const timer = setTimeout(() => setBlockedUntil(0), Math.max(0, blockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [blockedUntil]);
  return { failure, blocked: blockedUntil > 0, clear: () => { if (!blockedUntil) setFailure(null); }, report: (error: unknown) => {
    const next = askFailure(error); setFailure(next); if (next.retryAt) setBlockedUntil(next.retryAt);
  } };
}
export function AskFeedback({ title, detail, working = false, error = false, onRetry, retryLabel = 'Try again', extra }: { title: string; detail?: string; working?: boolean; error?: boolean; onRetry?: () => void; retryLabel?: string; extra?: string }) {
  return <div className={`${styles.feedback} ${error ? styles.error : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} aria-atomic="true">
    <span className={styles.mark} aria-hidden="true">{working ? <span className={styles.dots}><i/><i/><i/></span> : error ? '!' : '›'}</span>
    <div className={styles.content}><p className={styles.title}>{title}</p>{detail ? <p className={styles.detail}>{detail}</p> : null}{extra ? <p className={styles.detail} aria-hidden="true">{extra}</p> : null}{onRetry ? <button type="button" onClick={onRetry} className={styles.retry}>{retryLabel} →</button> : null}</div>
  </div>;
}
export function AskFailureFeedback({ failure, blocked, onRetry }: { failure: AskFailure; blocked: boolean; onRetry: () => void }) {
  const reset = failure.retryAt ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(failure.retryAt)) : null;
  return <AskFeedback error={blocked || !failure.retryAt} title={failure.retryAt && !blocked ? 'You can try again' : failure.title} detail={`${failure.detail}${reset ? blocked ? ` Resets at ${reset}. Your draft is kept here.` : ' The request window has reset. Your draft is kept here.' : ' Your draft is kept here.'}`} onRetry={failure.retryable || failure.retryAt && !blocked ? onRetry : undefined}/>;
}
