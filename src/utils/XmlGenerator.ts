function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

/**
 * Deeply converts a JavaScript object into XML tags.
 */
export function objectToXml(obj: unknown, rootName = 'data'): string {
  if (obj === null || obj === undefined) return '';

  if (typeof obj !== 'object') {
    return `<${rootName}>${escapeXml(String(obj))}</${rootName}>`;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => objectToXml(item, 'item')).join('\n');
  }

  let xml = `<${rootName}>\n`;
  for (const [key, value] of Object.entries(obj)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
    xml += `  ${objectToXml(value, safeKey)}\n`;
  }
  xml += `</${rootName}>`;

  return xml;
}

/** @deprecated Use objectToXml() instead */
export const XmlGenerator = { objectToXml };
