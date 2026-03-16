import { describe, expect, it } from 'vitest';
import { objectToXml } from './xmlGenerator';

describe('objectToXml', () => {
  it('returns empty string for null', () => {
    expect(objectToXml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(objectToXml(undefined)).toBe('');
  });

  it('wraps primitive string in root tag', () => {
    expect(objectToXml('hello', 'msg')).toBe('<msg>hello</msg>');
  });

  it('wraps primitive number in root tag', () => {
    expect(objectToXml(42, 'count')).toBe('<count>42</count>');
  });

  it('wraps boolean in root tag', () => {
    expect(objectToXml(true, 'flag')).toBe('<flag>true</flag>');
  });

  it('uses default root name "data"', () => {
    expect(objectToXml('test')).toBe('<data>test</data>');
  });

  it('converts flat object to XML', () => {
    const result = objectToXml({ name: 'Alice', age: 30 }, 'person');
    expect(result).toContain('<person>');
    expect(result).toContain('<name>Alice</name>');
    expect(result).toContain('<age>30</age>');
    expect(result).toContain('</person>');
  });

  it('converts nested object to XML', () => {
    const result = objectToXml({ user: { name: 'Bob' } }, 'root');
    expect(result).toContain('<root>');
    expect(result).toContain('<user>');
    expect(result).toContain('<name>Bob</name>');
    expect(result).toContain('</user>');
    expect(result).toContain('</root>');
  });

  it('converts array to XML wrapped in rootName tag', () => {
    const result = objectToXml(['a', 'b', 'c'], 'list');
    expect(result).toContain('<list>');
    expect(result).toContain('</list>');
    expect(result).toContain('<item>a</item>');
    expect(result).toContain('<item>b</item>');
    expect(result).toContain('<item>c</item>');
  });

  it('converts array field with key name as wrapper tag', () => {
    const result = objectToXml({ tasks: [{ id: 1 }, { id: 2 }] }, 'root');
    expect(result).toContain('<root>');
    expect(result).toContain('<tasks>');
    expect(result).toContain('</tasks>');
    expect(result).toContain('<id>1</id>');
    expect(result).toContain('<id>2</id>');
  });

  it('escapes special XML characters in values', () => {
    const result = objectToXml('a < b & c > d "e" \'f\'', 'val');
    expect(result).toBe('<val>a &lt; b &amp; c &gt; d &quot;e&quot; &apos;f&apos;</val>');
  });

  it('sanitizes keys with special characters', () => {
    const result = objectToXml({ 'my-key.name': 'value' }, 'root');
    expect(result).toContain('<my_key_name>value</my_key_name>');
  });

  it('handles deeply nested structures', () => {
    const obj = { a: { b: { c: { d: 'deep' } } } };
    const result = objectToXml(obj, 'root');
    expect(result).toContain('<d>deep</d>');
  });

  it('handles empty object', () => {
    const result = objectToXml({}, 'empty');
    expect(result).toBe('<empty>\n</empty>');
  });

  it('handles empty array', () => {
    const result = objectToXml([], 'list');
    expect(result).toBe('');
  });
});
