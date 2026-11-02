// Help articles on writing each kind of diagram (FEAT-090): DocPlan's reference,
// generated into diagram-reference.ts, under one section of the help window.

import { lang, tr } from '#core';
import { diagramKind } from '../diagram/kinds.ts';
import { DIAGRAM_REFERENCE } from './diagram-reference.ts';
import type { Article } from './types.ts';

export function diagramArticles(): Article[] {
  const section = tr('Схемы: как писать');
  return DIAGRAM_REFERENCE.map((r) => {
    const kind = diagramKind(r.layout);
    return {
      id: `diagram-${r.layout}`,
      section,
      title: kind.label,
      keywords: `${lang === 'en' ? r.titleEn : r.title} ${r.layout} ${tr('схема синтаксис команды как писать')}`,
      blocks: [
        { p: kind.hint + '.' },
        ...(lang === 'en' ? [{ tip: 'The commands of diagrams are written in Russian, as in the examples below.' }] : []),
        { html: lang === 'en' ? r.htmlEn : r.html },
      ],
      related: ['diagrams'],
    };
  });
}
