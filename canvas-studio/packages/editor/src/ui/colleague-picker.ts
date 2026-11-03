// Поле приглашения: фамилия или почта, список сотрудников reporting.

import { directory } from '../cloud.ts';
import { clear, h } from './dom.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function colleagueEmailField(placeholder: string, label: string): { wrap: HTMLElement; input: HTMLInputElement; email: () => string } {
  const input = h('input', {
    class: 'dialog-input share-email',
    type: 'text',
    placeholder,
    'aria-label': label,
    'aria-autocomplete': 'list',
    autocomplete: 'off',
    spellcheck: false,
  });
  const list = h('div', { class: 'share-suggest', role: 'listbox', hidden: true });
  const wrap = h('div', { class: 'share-email-wrap' }, input, list);
  let people: { name: string; email: string }[] = [];
  let active = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chosen = '';

  const hide = () => {
    list.hidden = true;
    active = -1;
  };

  const paint = () => {
    clear(list);
    list.hidden = people.length === 0;
    people.forEach((person, index) => {
      const button = h(
        'button',
        { type: 'button', role: 'option', class: index === active ? 'active' : '', 'aria-selected': String(index === active) },
        h('strong', {}, person.name || person.email),
        h('small', {}, person.email),
      );
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(person);
      });
      list.append(button);
    });
  };

  const pick = (person: { name: string; email: string }) => {
    chosen = person.email;
    input.value = person.name ? `${person.name} · ${person.email}` : person.email;
    hide();
  };

  input.addEventListener('input', () => {
    chosen = '';
    const q = input.value.trim();
    if (timer) clearTimeout(timer);
    if (q.length < 2) {
      people = [];
      paint();
      return;
    }
    timer = setTimeout(() => {
      void directory
        .search(q)
        .then((result) => {
          if (input.value.trim() !== q) return;
          people = result.people;
          active = people.length ? 0 : -1;
          paint();
        })
        .catch(() => {
          people = [];
          paint();
        });
    }, 200);
  });

  input.addEventListener('keydown', (event) => {
    if (list.hidden || !people.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : people.length - 1)) % people.length;
      paint();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      const person = people[active];
      if (person) pick(person);
    } else if (event.key === 'Escape') {
      hide();
    }
  });

  input.addEventListener('blur', () => setTimeout(hide, 150));

  return {
    wrap,
    input,
    email: () => {
      if (chosen) return chosen;
      const value = input.value.trim();
      const marked = value.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}$/);
      if (marked && EMAIL.test(marked[0])) return marked[0].toLowerCase();
      return EMAIL.test(value) ? value.toLowerCase() : '';
    },
  };
}
