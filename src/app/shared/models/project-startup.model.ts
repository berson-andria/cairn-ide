import type { LaunchArgs } from '../../core/services/tauri/work-api.service';

export function selectStartupFolder(
  args: LaunchArgs,
  lastProject: string | null,
  launchFolderExists: boolean,
  lastProjectExists: boolean,
): string | null {
  if (args.folder !== undefined) return launchFolderExists ? args.folder : null;
  if (!args.newWindow && lastProject) return lastProjectExists ? lastProject : null;
  return null;
}
