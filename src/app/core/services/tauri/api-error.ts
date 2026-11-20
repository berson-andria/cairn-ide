import type { ApiError } from './work-api.service';
import { NoticeManager } from '../notification/notification.service';

export async function handleApiError(
  reason: unknown,
  notices: NoticeManager,
  refresh?: () => Promise<void>,
  message?: string,
): Promise<void> {
  const error = reason as ApiError;
  if (error?.code === 'StaleRev' && refresh) {
    try {
      await refresh();
    } catch (refreshError) {
      console.error('Could not refresh after a stale update', refreshError);
    }
  }
  if (error?.code === 'NoProject') return;
  notices.error(
    message ??
      (error?.code === 'StaleRev'
        ? 'This changed elsewhere; try again.'
        : (error?.message ?? String(reason))),
  );
}
