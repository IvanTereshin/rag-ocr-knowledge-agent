ALTER TABLE rag_ocr_document_chunks
ADD COLUMN IF NOT EXISTS source jsonb;

ALTER TABLE rag_ocr_document_chunks
ADD COLUMN IF NOT EXISTS layout jsonb;
