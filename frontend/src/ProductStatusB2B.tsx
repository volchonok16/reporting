import ProductStatusWorkbook from './ProductStatusWorkbook'
import { loadProductStatusB2bGid, saveProductStatusB2bGid } from './uiState'

export default function ProductStatusB2B() {
  return (
    <ProductStatusWorkbook
      apiBase="/api/product-status/b2b"
      defaultTitle="Статус продукта B2B"
      loadGid={loadProductStatusB2bGid}
      saveGid={saveProductStatusB2bGid}
      enableExcelExport
      enablePresentationExport
      excelFilename="status-produkta-b2b.xlsx"
      presentationFilename="status-produkta-b2b.pptx"
    />
  )
}
