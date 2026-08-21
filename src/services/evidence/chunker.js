/**
 * chunker.js
 * Stage 2 — Content Chunking & Source Traceability Module
 *
 * Chunks large text or code extracted from evidence documents/repositories
 * into manageable segments, retaining source page/path/section metadata for
 * Stage 3 citation.
 */

/**
 * Chunks text into segments with traceability metadata.
 *
 * @param {object} params
 * @param {string} params.content           - The raw text/code content
 * @param {string} params.evidenceId        - Unique evidence ID
 * @param {string} params.sourceType        - Source type ('pdf', 'markdown', 'repository_file', etc.)
 * @param {string} [params.sourceLocation]  - Source location ('page 3', 'src/auth/login.ts', etc.)
 * @param {number} [params.chunkSize=1000]  - Segment size in characters
 * @param {number} [params.overlap=100]     - Overlap size in characters
 * @returns {Array<{
 *   chunk_id: string,
 *   evidence_id: string,
 *   source_type: string,
 *   source_location: string|null,
 *   chunk_index: number,
 *   content: string,
 *   metadata: object
 * }>}
 */
export function chunkContent({
  content,
  evidenceId,
  sourceType,
  sourceLocation = null,
  chunkSize = 1000,
  overlap = 100,
}) {
  if (!content || typeof content !== "string" || !content.trim()) {
    return [];
  }

  const cleaned = content.replace(/\r\n/g, "\n").trim();
  const chunks = [];

  if (cleaned.length <= chunkSize) {
    chunks.push({
      chunk_id: `${evidenceId}_c0`,
      evidence_id: evidenceId,
      source_type: sourceType,
      source_location: sourceLocation,
      chunk_index: 0,
      content: cleaned,
      metadata: {
        length: cleaned.length,
        total_chunks: 1,
      },
    });
    return chunks;
  }

  let index = 0;
  let start = 0;
  const effectiveStep = Math.max(100, chunkSize - overlap);

  while (start < cleaned.length) {
    const end = Math.min(cleaned.length, start + chunkSize);
    const chunkText = cleaned.substring(start, end).trim();

    if (chunkText.length > 0) {
      chunks.push({
        chunk_id: `${evidenceId}_c${index}`,
        evidence_id: evidenceId,
        source_type: sourceType,
        source_location: sourceLocation,
        chunk_index: index,
        content: chunkText,
        metadata: {
          start_offset: start,
          end_offset: end,
          length: chunkText.length,
        },
      });
      index++;
    }

    start += effectiveStep;
  }

  // Record total_chunks in metadata
  chunks.forEach((c) => {
    c.metadata.total_chunks = chunks.length;
  });

  return chunks;
}
