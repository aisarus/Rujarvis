import mammoth from 'mammoth';

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Extract bounded, human-readable text from DOCX bytes for internal previews. */
export async function readDocxText(docxData: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: docxData });
  const html = (result.value || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|section|article|header|footer|blockquote|pre|table|tr)>/gi, '\n')
    .replace(/<\s*(?:p|div|h[1-6]|ul|ol|section|article|header|footer|blockquote|pre|table|tr)\b[^>]*>/gi, '');

  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\t\v\f]/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
