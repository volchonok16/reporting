import ProductStatusWorkbook from './ProductStatusWorkbook'
import { loadB2bNewsGid, saveB2bNewsGid } from './uiState'

export default function B2BNews() {
  return (
    <ProductStatusWorkbook
      apiBase="/api/b2b-news"
      defaultTitle="Новости"
      loadGid={loadB2bNewsGid}
      saveGid={saveB2bNewsGid}
    />
  )
}
