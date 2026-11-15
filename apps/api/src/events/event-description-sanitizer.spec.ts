import { describe, expect, it } from 'vitest';
import { descriptionSanitizerOptions, sanitizeDescription } from './event-description-sanitizer';

const xssPayloads = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src=javascript:alert(1)></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="data:text/html,<script>alert(1)</script>">click</a>',
  '<body onload=alert(1)>',
  '<video><source onerror=alert(1)></video>',
  '<audio src=x onerror=alert(1)>',
  '<object data="javascript:alert(1)">',
  '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><button>go</button></form>',
  '<input autofocus onfocus=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '<marquee onstart=alert(1)>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  '<div style="background-image:url(javascript:alert(1))">',
  '<style>@import "javascript:alert(1)";</style>',
  '<a href="//evil.example/path">protocol-relative</a>',
  '<a href="vbscript:msgbox(1)">vbscript</a>',
  '<a href="https://safe.example" onclick="alert(1)">safe link with handler</a>',
  '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
  '<isindex action="javascript:alert(1)">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
];

describe('event description sanitizer', () => {
  it('uses the narrowly scoped rich-text allowlist', () => {
    expect(descriptionSanitizerOptions.allowedTags).toEqual([
      'a',
      'blockquote',
      'br',
      'em',
      'li',
      'ol',
      'p',
      'strong',
      'ul',
    ]);
    expect(descriptionSanitizerOptions.allowedAttributes).toEqual({ a: ['href', 'title'] });
    expect(descriptionSanitizerOptions.allowedSchemes).toEqual(['http', 'https', 'mailto']);
    expect(descriptionSanitizerOptions.allowProtocolRelative).toBe(false);
  });

  it.each(xssPayloads)('removes unsafe markup from payload: %s', (payload) => {
    const output = sanitizeDescription(`Event details ${payload}`);

    expect(output).not.toMatch(
      /<(script|img|svg|iframe|object|embed|form|input|video|audio|style|meta|math|marquee|details|body)\b/i,
    );
    expect(output).not.toMatch(/\son[a-z]+\s*=/i);
    expect(output).not.toMatch(/(?:javascript|vbscript|data):/i);
    expect(output).not.toMatch(/href=["']?\/\//i);
  });
});
