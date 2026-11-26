import { ComponentCatalog } from './ComponentCatalog';
import { Hub } from '../features/hub/Hub';
import { Workspace } from '../features/intake/Workspace';

export function App() {
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'catalog') return <ComponentCatalog />;
  if (params.get('view') === 'legacy' || params.has('case')) return <Hub />;
  return <Workspace />;
}
