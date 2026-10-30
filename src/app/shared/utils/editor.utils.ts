import languageMap from '../../../assets/file-extension-to-language.json';

export function getMonacoLanguage(fileName: String): string {
  const lowerName = fileName.toLowerCase();

  if (lowerName === 'dockerfile') return 'dockerfile';
  if (lowerName === 'makefile') return 'makefile';

  const extension = lowerName.split('.').pop();

  if (extension && (languageMap as Record<string, string>)[extension]) {
    return (languageMap as Record<string, string>)[extension];
  }

  return 'plaintext';
}
