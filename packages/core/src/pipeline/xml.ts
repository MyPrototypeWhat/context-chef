/** Escapes a string for use inside an XML attribute value. */
export function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
