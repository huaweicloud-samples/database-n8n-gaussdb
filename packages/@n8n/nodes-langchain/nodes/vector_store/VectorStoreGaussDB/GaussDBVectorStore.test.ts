import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { Pool } from 'pg';

import { GaussDBVectorStore } from './GaussDBVectorStore';

type MockPool = { query: ReturnType<typeof vi.fn> };

function createMockPool(): MockPool {
	return { query: vi.fn() };
}

function createMockEmbeddings(): EmbeddingsInterface {
	return {
		embedDocuments: vi.fn().mockResolvedValue([[1, 2, 3]]),
		embedQuery: vi.fn().mockResolvedValue([1, 2, 3]),
	} as unknown as EmbeddingsInterface;
}

function makeDoc(content: string, metadata: Record<string, unknown> = {}): Document {
	return { pageContent: content, metadata } as Document;
}

describe('GaussDBVectorStore', () => {
	let mockPool: MockPool;
	let embeddings: EmbeddingsInterface;

	beforeEach(() => {
		mockPool = createMockPool();
		embeddings = createMockEmbeddings();
		mockPool.query.mockReset();
	});

	describe('ensureTable', () => {
		it('should use varchar(36) id and floatvector(dim) column (O-mode: no gen_random_uuid)', async () => {
			mockPool.query.mockResolvedValue({ rows: [] });
			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 1536,
			});

			await store.ensureTable();

			const tableSql = mockPool.query.mock.calls
				.map((c: unknown[]) => String(c[0]))
				.find((s) => s.includes('CREATE TABLE'));

			expect(tableSql).toBeDefined();
			expect(tableSql).toContain('id varchar(36) PRIMARY KEY');
			expect(tableSql).toContain('floatvector(1536)');
			// O-mode: must NOT use gen_random_uuid
			expect(tableSql).not.toContain('gen_random_uuid');
		});
	});

	describe('similaritySearchVectorWithScore', () => {
		it('should use <+> operator and return score = 1 - distance', async () => {
			mockPool.query.mockResolvedValue({
				rows: [
					{ id: 'doc1', content: 'hello', metadata: { source: 'test' }, distance: 0.2 },
				],
			});

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
			});

			const results = await store.similaritySearchVectorWithScore([1, 2, 3], 5);

			const sql = String(mockPool.query.mock.calls[0][0]);
			expect(sql).toContain('<+>');
			expect(sql).toContain('ORDER BY distance');
			expect(results).toHaveLength(1);
			expect(results[0][1]).toBeCloseTo(0.8, 10); // 1 - 0.2 = 0.8
			expect(results[0][0].pageContent).toBe('hello');
		});

		it('should merge instance filter and call filter', async () => {
			mockPool.query.mockResolvedValue({ rows: [] });

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
				filter: { category: 'news' },
			});

			await store.similaritySearchVectorWithScore([1, 2, 3], 5, { source: 'test' });

			const sql = String(mockPool.query.mock.calls[0][0]);
			expect(sql).toContain('WHERE');
			expect(sql).toContain('AND');
		});
	});

	describe('createIndex', () => {
		it('auto mode dim <= 1024 should use gsivfflat', async () => {
			mockPool.query.mockResolvedValue({ rows: [] });

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 768,
				indexType: 'auto',
			});

			await store.createIndex();

			const indexSql = mockPool.query.mock.calls
				.map((c: unknown[]) => String(c[0]))
				.find((s) => s.includes('CREATE INDEX'));

			expect(indexSql).toBeDefined();
			expect(indexSql).toContain('USING gsivfflat');
			expect(indexSql).toContain('cosine');
			expect(indexSql).toContain('ivf_nlist');
		});

		it('auto mode dim > 1024 centralized should use gsdiskann with enable_pq=true', async () => {
			mockPool.query.mockImplementation(async (sql: string) => {
				if (sql.includes('datcompatibility')) {
					return { rows: [{ datcompatibility: 'A' }] };
				}
				return { rows: [] };
			});

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 1536,
				indexType: 'auto',
			});

			await store.createIndex();

			const indexSql = mockPool.query.mock.calls
				.map((c: unknown[]) => String(c[0]))
				.find((s) => s.includes('CREATE INDEX'));

			expect(indexSql).toBeDefined();
			expect(indexSql).toContain('USING gsdiskann');
			expect(indexSql).toContain('enable_pq = true');
			expect(indexSql).toContain('pq_nseg');
		});

		it('auto mode dim > 1024 distributed and unsupported should throw friendly error', async () => {
			mockPool.query.mockImplementation(async (sql: string) => {
				if (sql.includes('datcompatibility')) {
					return { rows: [{ datcompatibility: 'ORA' }] };
				}
				if (sql.includes('n8n_dimprobe')) {
					throw new Error('dimension too large');
				}
				return { rows: [] };
			});

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 1536,
				indexType: 'auto',
			});

			await expect(store.createIndex()).rejects.toThrow(/分布式形态/);
			await expect(store.createIndex()).rejects.toThrow(/≤ 1024 维/);
		});

		it('should set maintenance_work_mem before creating index', async () => {
			mockPool.query.mockResolvedValue({ rows: [] });

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 768,
				indexType: 'auto',
			});

			await store.createIndex();

			const setSql = mockPool.query.mock.calls
				.map((c: unknown[]) => String(c[0]))
				.find((s) => s.includes('maintenance_work_mem'));

			expect(setSql).toBeDefined();
			expect(setSql).toContain("512MB");
		});
	});

	describe('calcPqNseg', () => {
		it('should return correct pq_nseg for common dimensions', () => {
			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 1536,
			});

			expect(store.calcPqNseg(1536)).toBe(96);
			expect(store.calcPqNseg(3072)).toBe(96);
			expect(store.calcPqNseg(4096)).toBe(128);
			expect(store.calcPqNseg(768)).toBe(384);
		});

		it('should return a pq_nseg that divides dim when dim is not divisible by [96,128,192,256,384]', () => {
			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 1536,
			});

			// 1025 = 5 * 205; not divisible by any of [96,128,192,256,384]
			const result = store.calcPqNseg(1025);
			expect(result).toBe(205);
			expect(1025 % result).toBe(0);
		});
	});

	describe('addVectors', () => {
		it('should use app-layer uuid and [v1,v2] string literal format', async () => {
			mockPool.query.mockResolvedValue({ rows: [] });

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
			});

			const vectors = [[1, 2, 3], [4, 5, 6]];
			const docs = [makeDoc('hello'), makeDoc('world')];

			await store.addVectors(vectors, docs);

			const insertCall = mockPool.query.mock.calls.find((c: unknown[]) =>
				String(c[0]).includes('INSERT INTO'),
			);

			expect(insertCall).toBeDefined();
			const sql = String(insertCall![0]);
			const params = insertCall![1] as unknown[];

			// O-mode: must NOT use gen_random_uuid
			expect(sql).not.toContain('gen_random_uuid');

			// App-layer uuid: first param should be a uuid-like string (36 chars with dashes)
			const firstId = params[0];
			expect(typeof firstId).toBe('string');
			expect((firstId as string).length).toBe(36);

			// Embedding should be in [v1,v2,v3] format
			const embeddingParam = params[2];
			expect(embeddingParam).toBe('[1,2,3]');
		});
	});

	describe('buildFilterClauses', () => {
		it('should parameterize key and use IN for array values', () => {
			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
			});

			const result = store.buildFilterClauses({ tags: ['a', 'b'] });

			expect(result.clauses).toHaveLength(1);
			expect(result.clauses[0]).toContain('IN (');
			expect(result.clauses[0]).toContain('::text');
			// Key is parameterized (not string-interpolated)
			expect(result.clauses[0]).not.toMatch(/->>'tags'/);
			// Params include key + values
			expect(result.params).toEqual(['tags', 'a', 'b']);
		});

		it('should parameterize key and use = for single values', () => {
			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
			});

			const result = store.buildFilterClauses({ category: 'news' });

			expect(result.clauses).toHaveLength(1);
			expect(result.clauses[0]).toContain('=');
			expect(result.clauses[0]).toContain('::text');
			expect(result.clauses[0]).not.toMatch(/->>'category'/);
			expect(result.params).toEqual(['category', 'news']);
		});

		it('should handle multiple filters with correct param offset', () => {
			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
			});

			const result = store.buildFilterClauses(
				{ category: 'news', tags: ['a', 'b'] },
				1, // paramOffset=1 (e.g. query vector is $1)
			);

			expect(result.clauses).toHaveLength(2);
			// First clause: key at $2, value at $3
			expect(result.clauses[0]).toContain('$2');
			expect(result.clauses[0]).toContain('$3');
			// Second clause: key at $4, values at $5,$6
			expect(result.clauses[1]).toContain('$4');
			expect(result.clauses[1]).toContain('$5');
			expect(result.clauses[1]).toContain('$6');
			expect(result.params).toEqual(['category', 'news', 'tags', 'a', 'b']);
		});
	});

	describe('delete', () => {
		it('should delete by ids using ANY()', async () => {
			mockPool.query.mockResolvedValue({ rows: [] });

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
			});

			await store.delete({ ids: ['id1', 'id2'] });

			const sql = String(mockPool.query.mock.calls[0][0]);
			expect(sql).toContain('DELETE FROM');
			expect(sql).toContain('ANY($1)');
		});

		it('should delete by filter', async () => {
			mockPool.query.mockResolvedValue({ rows: [] });

			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
			});

			await store.delete({ filter: { category: 'old' } });

			const sql = String(mockPool.query.mock.calls[0][0]);
			expect(sql).toContain('DELETE FROM');
			expect(sql).toContain('WHERE');
		});
	});

	describe('initialize', () => {
		it('should call ensureTable and createIndex when dimensions provided', async () => {
			mockPool.query.mockImplementation(async (sql: string) => {
				if (sql.includes('datcompatibility')) {
					return { rows: [{ datcompatibility: 'A' }] };
				}
				return { rows: [] };
			});

			const store = await GaussDBVectorStore.initialize(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 768,
			});

			expect(store).toBeInstanceOf(GaussDBVectorStore);
			expect(store.dimensions).toBe(768);

			// Should have called CREATE TABLE and CREATE INDEX
			const calls = mockPool.query.mock.calls.map((c: unknown[]) => String(c[0]));
			expect(calls.some((s) => s.includes('CREATE TABLE'))).toBe(true);
			expect(calls.some((s) => s.includes('CREATE INDEX'))).toBe(true);
		});

		it('should skip table/index creation when dimensions is 0', async () => {
			mockPool.query.mockResolvedValue({ rows: [] });

			const store = await GaussDBVectorStore.initialize(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
			});

			expect(store.dimensions).toBe(0);
			expect(mockPool.query).not.toHaveBeenCalled();
		});
	});

	describe('_vectorstoreType', () => {
		it('should return gaussdb', () => {
			const store = new GaussDBVectorStore(embeddings, {
				pool: mockPool as unknown as Pool,
				tableName: 'n8n_vectors',
				dimensions: 3,
			});

			expect(store._vectorstoreType()).toBe('gaussdb');
		});
	});
});
