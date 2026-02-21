export class XmlGenerator {
  /**
   * Deeply converts a JavaScript object into XML tags.
   */
  public static objectToXml(obj: any, rootName = 'data'): string {
    if (obj === null || obj === undefined) return '';

    if (typeof obj !== 'object') {
      return `<${rootName}>${XmlGenerator.escapeXml(String(obj))}</${rootName}>`;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => XmlGenerator.objectToXml(item, 'item')).join('\n');
    }

    let xml = `<${rootName}>\n`;
    for (const [key, value] of Object.entries(obj)) {
      // Basic normalization of keys
      const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
      xml += `  ${XmlGenerator.objectToXml(value, safeKey)}\n`;
    }
    xml += `</${rootName}>`;

    return xml;
  }

  private static escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&'"]/g, c => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  }
}
