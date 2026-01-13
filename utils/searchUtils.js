
/**
 * Hybrid Merge Strategy (Weighted Score Fuse)
 * Merges results from BM25 (sparse) and Vector (dense) searches
 * @param {Array} bm25Results - Results from OpenSearch
 * @param {Array} vectorResults - Results from Qdrant
 * @param {string} collectionName - Name of the collection being searched
 * @returns {Array} - Merged and sorted results
 */
export function hybridMerge(bm25Results, vectorResults, collectionName) {
    const map = new Map();

    // Process BM25 Results (OpenSearch)
    bm25Results.forEach(r => {
        // Normalizing max score could be better, but using raw score * 0.6 as per request
        const score = (r._score || 0) * 0.6;
        map.set(r._id, { ...r._source, score, matchType: ['bm25'], collectionName });
    });

    // Process Vector Results (Qdrant)
    vectorResults.forEach(r => {
        const id = r.payload?.mongoId || r.id; // Ensure ID alignment
        // Qdrant scores are usually Cosine (0-1), OpenSearch scores are unbounded BM25.
        // We might need to normalize Qdrant score to scale. Let's assume simple weight for now.
        const score = (r.score || 0) * 0.4; // Weighting vector less? Or 0.4 * scale? 
        // Let's stick to the requested logic: score * 0.4

        if (map.has(id)) {
            const entry = map.get(id);
            entry.score += score;
            // BOOST INTERSECTION: If item exists in both, give it a significant boost (e.g. 50% bonus)
            // This ensures dual-matches obey the user's request for "high priority"
            entry.score *= 1.5;

            entry.matchType.push('vector');
            if (collectionName) entry.collectionName = collectionName;
        } else {
            map.set(id, { ...r.payload, score, matchType: ['vector'], collectionName });
        }
    });

    return [...map.values()].sort((a, b) => b.score - a.score);
}
