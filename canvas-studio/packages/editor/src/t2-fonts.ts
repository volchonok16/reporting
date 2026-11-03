// Шрифты айдентики T2. Лежат в образе Симметрики и подключаются в браузере,
// поэтому текст не подменяется «похожим», даже если на компьютере шрифтов нет.

export const BRAND_FAMILIES = ['T2 Rooftop', 'T2 Rooftop Medium', 'T2 Halvar Breit', 'T2 Halvar Breit ExtraBold'] as const;

export interface BrandFace {
  family: string;
  /** CSS weight. 400 — обычное начертание этой семьи. */
  weight: string;
  url: string;
}

/** Семья в файле шрифта и то же начертание отдельным именем, как его пишет PowerPoint. */
export const BRAND_FACES: BrandFace[] = [
  { family: 'T2 Rooftop', weight: '400', url: '/apps/web/fonts/t2/T2Rooftop-Regular.ttf' },
  { family: 'T2 Rooftop', weight: '500', url: '/apps/web/fonts/t2/T2Rooftop-Medium.ttf' },
  { family: 'T2 Rooftop Medium', weight: '400', url: '/apps/web/fonts/t2/T2Rooftop-Medium.ttf' },
  { family: 'T2 Halvar Breit', weight: '800', url: '/apps/web/fonts/t2/T2HalvarBreit-ExtraBold.ttf' },
  { family: 'T2 Halvar Breit ExtraBold', weight: '400', url: '/apps/web/fonts/t2/T2HalvarBreit-ExtraBold.ttf' },
];

const asked = new Set<string>();

export function isBrandFamily(family: string): boolean {
  return (BRAND_FAMILIES as readonly string[]).includes(family);
}

/** Подключает шрифты один раз. `ready` — семьи, которые стали доступны. */
export function loadBrandFonts(ready?: (families: string[]) => void): void {
  if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') return;
  for (const face of BRAND_FACES) {
    const key = `${face.family}\u0000${face.weight}`;
    if (asked.has(key)) continue;
    asked.add(key);
    void fetch(face.url)
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then(async (bytes) => {
        if (!bytes) {
          asked.delete(key);
          return;
        }
        const loaded = new FontFace(face.family, bytes, { weight: face.weight });
        await loaded.load();
        document.fonts.add(loaded);
        ready?.([face.family]);
      })
      .catch(() => {
        asked.delete(key);
      });
  }
}
