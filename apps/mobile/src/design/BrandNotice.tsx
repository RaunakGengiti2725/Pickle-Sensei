import React, { useEffect, useState } from 'react';
import { BrandDialog } from './components';

export interface BrandNotice {
  title: string;
  detail: string;
  tone?: 'neutral' | 'danger' | 'success';
  eyebrow?: string;
  actionLabel?: string;
}

let pendingNotice: BrandNotice | null = null;
let presentNotice: ((notice: BrandNotice) => void) | null = null;

/** Imperative only for one-way notices that may outlive their source screen
 * (external-link failures and post-account-deletion cleanup warnings).
 * Decisions continue to use a locally owned BrandDialog. */
export function showBrandNotice(notice: BrandNotice): void {
  if (presentNotice) {
    presentNotice(notice);
  } else {
    pendingNotice = notice;
  }
}

export function BrandNoticeHost() {
  const [notice, setNotice] = useState<BrandNotice | null>(null);

  useEffect(() => {
    presentNotice = setNotice;
    if (pendingNotice) {
      setNotice(pendingNotice);
      pendingNotice = null;
    }
    return () => {
      presentNotice = null;
    };
  }, []);

  const dismiss = () => setNotice(null);
  return (
    <BrandDialog
      visible={notice !== null}
      title={notice?.title ?? ''}
      detail={notice?.detail ?? ''}
      tone={notice?.tone}
      eyebrow={notice?.eyebrow}
      onDismiss={dismiss}
      testID="brand-notice"
      actions={[
        {
          label: notice?.actionLabel ?? 'Got it',
          variant: 'dark',
          onPress: dismiss,
        },
      ]}
    />
  );
}
