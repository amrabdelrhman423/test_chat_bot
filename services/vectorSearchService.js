
import { qdrant, clientOS } from '../config/vectorDbConfig.js';
import { embed } from './embeddingService.js';
import { hybridMerge } from '../utils/searchUtils.js';
import { normalizeArabicMedical, fixEncoding } from '../utils/encoding.js';

/**
 * Perform hybrid search (Vector + BM25)
 * @param {string} query - The search query
 * @param {string} collection - The collection name
 * @param {number} limit - Number of results to return
 * @param {number} scoreThreshold - Minimum similarity score
 * @returns {Array} - Fused results
 */
export async function performVectorSearch(query, collection, limit = 5, scoreThreshold = 0.5) {

    const normalizedQuery = normalizeArabicMedical(query);

    console.log(`🔍 Performing Hybrid Search on ${collection} for: "${normalizedQuery}"`);

    const searchLimit = limit; // Fetch more for better intersection

    // 1. Generate Vector
    const vectorPromise = embed(query, "retrieval.query"); // Task for Jina v3
    // Let's use normalized for consistency if your embedding model is simple, but vast LLMS handle raw well.
    // Sticking to original for embedding to keep semantic nuance, normalized for BM25.

    // 2. Parallel Search Execution
    try {
        const [vector, bm25Res] = await Promise.all([
            vectorPromise,
            clientOS.search({
                index: collection,
                body: {
                    size: searchLimit,
                    query: {
                        bool: {
                            should: [
                                // 1️⃣ Arabic exact-ish
                                {
                                    multi_match: {
                                        query: normalizedQuery,
                                        fields: [
                                            'nameAr^4',
                                            'fullnameAr^4',
                                            'title^3',
                                            'text^2'
                                        ],
                                        type: 'best_fields'
                                    }
                                },

                                // 2️⃣ Partial Arabic (ngram)
                                {
                                    multi_match: {
                                        query: normalizedQuery,
                                        fields: [
                                            'nameAr.ngram^2',
                                            'fullnameAr.ngram^2'
                                        ]
                                    }
                                },

                                // 3️⃣ English (typos allowed)
                                {
                                    multi_match: {
                                        query: normalizedQuery,
                                        fields: [
                                            'nameEn^3',
                                            'fullname^3'
                                        ],
                                        fuzziness: 'AUTO'
                                    }
                                }
                            ],
                            minimum_should_match: 1,
                            must_not: [
                                { term: { isDeleted: true } }
                            ]
                        }
                    }
                }
            }).catch(e => {
                console.error("OpenSearch BM25 Failed:", e.message);
                return { body: { hits: { hits: [] } } };
            })
        ]);



        const vectorRes = await qdrant.search(collection, {
            vector: vector,
            limit: searchLimit,
            score_threshold: scoreThreshold,
            filter: {
                must_not: [
                    { key: "isDeleted", match: { value: true } }
                ]
            }
        }).catch(e => {
            console.error("Qdrant Vector Search Failed:", e.message);
            return [];
        });

        const bm25Hits = bm25Res.body.hits.hits;

        console.log(`📊 Raw Results: OpenSearch(BM25) = ${bm25Hits.length}, Qdrant(Vector) = ${vectorRes.length} `);

        // Fusion
        const fusedResults = hybridMerge(bm25Hits, vectorRes, collection).slice(0, limit);

        console.log(`🤝 Hybrid Fusion yielded ${fusedResults.length} unique results.`);

        fusedResults.forEach((r, i) => {
            console.log(` ${fixEncoding(r.text || r.name)} ➤ Score: ${r.score.toFixed(4)} [${r.matchType.join('+')}]`);
        });

        // Return full objects so we can use metadata (like scores and names) for refinement
        return fusedResults;

    } catch (e) {
        console.error("Hybrid Search Error:", e);
        return [];
    }
}
