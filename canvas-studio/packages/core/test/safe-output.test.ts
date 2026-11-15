import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cssComment, cssNoTags, cssString, Document, safeBlobData, safeMime } from '../src/index.ts';

test('blobs of a file: data only base64, a type only a type — nothing a data: address, CSS or SVG could be broken out of', () => {
  assert.ok(safeBlobData('iVBORw0KGgo='));
  assert.ok(!safeBlobData('AAAA");}</style><script>alert(1)</script>'));
  assert.equal(safeMime('image/svg+xml'), 'image/svg+xml');
  assert.equal(safeMime('font/woff2'), 'font/woff2');
  assert.equal(safeMime('image/png;base64,AAAA");}</style><script>'), 'application/octet-stream');
  const doc = Document.createEmpty('Т', 'test');
  doc.store.apply({ kind: 'blob', hash: 'h1', mime: 'image/png", x="', data: 'AAAA', time: { counter: 1, session: 'a' } } as never, { blobs: new Set() } as never);
  doc.store.apply({ kind: 'blob', hash: 'h2', mime: 'image/png', data: 'AA"><script>', time: { counter: 2, session: 'a' } } as never, { blobs: new Set() } as never);
  assert.deepEqual(doc.store.blobs.get('h1'), { mime: 'application/octet-stream', data: 'AAAA' });
  assert.equal(doc.store.blobs.get('h2'), undefined);
});

test('a font family as a CSS string: quotes, backslashes, angle brackets and line breaks escaped', () => {
  assert.equal(cssString('Inter'), '"Inter"');
  const evil = cssString('X"; } </style><script>alert(1)</script> \\');
  assert.ok(!/[<>]/.test(evil) && !/[^\\]"/.test(evil.slice(1, -1)), evil);
  assert.equal(cssString('a\nb'), '"a\\a b"');
});

test('a file\'s names in CSS comments and CSS given out: no end of a comment, no tag, no new line (BUG-170)', () => {
  const c = cssComment('Тема */ body{} </style><script>\n// x');
  assert.ok(!c.includes('*/') && !c.includes('<') && !/[\r\n]/.test(c), c);
  assert.equal(cssComment('Тема'), 'Тема');
  assert.ok(!cssNoTags(':root { --a: "</style><script>"; }').includes('<'));
});
