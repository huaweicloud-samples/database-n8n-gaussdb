import { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export interface GaussDBVectorStoreArgs {
	pool: Pool;
	tableName: string;
	dimensions?: number;
	indexType?: 'auto' | 'gsivfflat' | 'gsdiskann';
	filter?: Record<string, unknown>;
}

interface SearchResultRow {
	id: string;
	content: string;
	metadata: Record<string, unknown>;
	distance: number;
}

interface FilterClauses {
	clauses: string[];
	params: unknown[];
}

/**
 * GaussDB vector store using legacy floatvector/GsIVFFLAT/GsDiskANN APIs.
 *
 * Designed for GaussDB Kernel 507 centralized mode (enable_vectordb=on).
 * O-mode (ORA compatibility) is handled by using varchar(36) + app-layer uuid
 * instead of gen_random_uuid(), and jsonb operators (->>/->/?|) for filtering.
 */
export class GaussDBVectorStore extends VectorStore {
	pool: Pool;
	tableName: string;
	dimensions: number;
	indexType: 'auto' | 'gsivfflat' | 'gsdiskann';
	filter?: Record<string, unknown>;

	constructor(embeddings: EmbeddingsInterface, args: GaussDBVectorStoreArgs) {
		super(embeddings, args);
		this.pool = args.pool;
		this.tableName = args.tableName;
		this.dimensions = args.dimensions ?? 0;
		this.indexType = args.indexType ?? 'auto';
		this.filter = args.filter;
	}

	_vectorstoreType(): string {
		return 'gaussdb';
	}

	async addDocuments(documents: Document[]): Promise<void> {
		const texts = documents.map(({ pageContent }) => pageContent);
		return await this.addVectors(await this.embeddings.embedDocuments(texts), documents);
	}

	static async initialize(
		embeddings: EmbeddingsInterface,
		args: GaussDBVectorStoreArgs,
	): Promise<GaussDBVectorStore> {
		const store = new GaussDBVectorStore(embeddings, args);
		if (store.dimensions) {
			await store.ensureTable();
			await store.createIndex();
		}
		return store;
	}

	/**
	 * Detect topology: datcompatibility 'A' = centralized, 'ORA' = distributed.
	 */
	async detectTopology(): Promise<boolean> {
		const r = await this.pool.query(
			"SELECT datcompatibility FROM pg_database WHERE datname = current_database()",
		);
		return r.rows[0].datcompatibility === 'A';
	}

	/**
	 * Probe whether the given dimension is supported by creating a temp floatvector column.
	 */
	async probeDimSupport(dim: number): Promise<boolean> {
		try {
			await this.pool.query(
				`CREATE TABLE n8n_dimprobe (id int, v floatvector(${dim}) NOT NULL)`,
			);
			await this.pool.query('DROP TABLE n8n_dimprobe');
			return true;
		} catch {
			return false;
		}
	}

	async ensureTable(): Promise<void> {
		await this.pool.query(
			`CREATE TABLE IF NOT EXISTS "${this.tableName}" (
				id varchar(36) PRIMARY KEY,
				content text,
				embedding floatvector(${this.dimensions}) NOT NULL,
				metadata jsonb
			)`,
		);
	}

	async createIndex(): Promise<void> {
		// GaussDB requires quoted string for maintenance_work_mem
		await this.pool.query("SET maintenance_work_mem = '512MB'");

		const dim = this.dimensions;
		let useIvfflat = dim <= 1024;
		let useDiskannPq = false;

		if (this.indexType === 'gsivfflat') {
			// Auto-fallback for dims > 1024 (GsIVFFLAT limit), no error
			if (dim > 1024) {
				useIvfflat = false;
				useDiskannPq = true;
			}
		} else if (this.indexType === 'gsdiskann') {
			useIvfflat = false;
			useDiskannPq = dim > 1024;
		} else {
			// auto: pick based on dimension
			useIvfflat = dim <= 1024;
			useDiskannPq = dim > 1024;
			if (useDiskannPq) {
				const isCentralized = await this.detectTopology();
				if (!isCentralized) {
					// Distributed mode: probe actual dim limit
					const supported = await this.probeDimSupport(dim);
					if (!supported) {
						throw new Error(
							'当前 GaussDB 库为分布式形态（向量维度上限 1024），不支持 ' +
								`${dim} 维。请选 ≤ 1024 维的 embedding 模型，` +
								'或联系 DBA 确认是否可切换集中式形态以支持更高维度。',
						);
					}
				}
			}
		}

		if (useIvfflat) {
			await this.pool.query(
				`CREATE INDEX IF NOT EXISTS "${this.tableName}_embedding_idx" ` +
					`ON "${this.tableName}" USING gsivfflat (embedding cosine) ` +
					'WITH (ivf_nlist = 256)',
			);
		} else {
			const pqNseg = this.calcPqNseg(dim);
			const enablePq = useDiskannPq;
			await this.pool.query(
				`CREATE INDEX IF NOT EXISTS "${this.tableName}_embedding_idx" ` +
					`ON "${this.tableName}" USING gsdiskann (embedding cosine) ` +
					`WITH (pq_nseg = ${pqNseg}, pq_nclus = 16, enable_pq = ${enablePq}, ` +
					'subgraph_count = 1, enable_vector_copy = false)',
			);
		}
	}

	calcPqNseg(dim: number): number {
		if (dim <= 512) return dim;
		if (dim <= 1024) return dim / 2;
		for (const c of [96, 128, 192, 256, 384]) {
			if (dim % c === 0) return c;
		}
		// fallback: find the largest factor of dim within [8, dim/4] so pq_nseg divides dim
		const target = Math.floor(dim / 4);
		for (let c = target; c >= 8; c--) {
			if (dim % c === 0) return c;
		}
		return dim; // prime dim: pq_nseg = dim always divides dim
	}

	async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
		// O-mode: app-layer uuid (gen_random_uuid does not exist), [v1,v2,...] string literal
		const rows = vectors.map((v, i) => ({
			id: uuidv4(),
			content: documents[i].pageContent,
			embedding: `[${v.join(',')}]`,
			metadata: JSON.stringify(documents[i].metadata ?? {}),
		}));

		const placeholders = rows
			.map(
				(_, i) =>
					`($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}::floatvector, $${i * 4 + 4})`,
			)
			.join(', ');

		const params = rows.flatMap((r) => [r.id, r.content, r.embedding, r.metadata]);

		await this.pool.query(
			`INSERT INTO "${this.tableName}" (id, content, embedding, metadata) VALUES ${placeholders}`,
			params,
		);
	}

	async similaritySearchVectorWithScore(
		query: number[],
		k: number,
		filter?: Record<string, unknown>,
	): Promise<Array<[Document, number]>> {
		const mergedFilter = { ...this.filter, ...filter };
		const fc = this.buildFilterClauses(mergedFilter, 1); // offset=1 for query vector ($1)
		const where = fc.clauses.length ? `WHERE ${fc.clauses.join(' AND ')}` : '';
		const limitIndex = 1 + fc.params.length + 1; // $1 (vector) + filter params + $N (k)

		const sql =
			'SELECT id, content, metadata, embedding <+> $1::floatvector AS distance ' +
			`FROM "${this.tableName}" ${where} ORDER BY distance LIMIT $${limitIndex}`;

		const r = await this.pool.query(sql, [`[${query.join(',')}]`, ...fc.params, k]);

		return r.rows.map((row: SearchResultRow) => [
			new Document({ pageContent: row.content, metadata: row.metadata }),
			1 - Number(row.distance),
		]);
	}

	/**
	 * Build WHERE clause conditions with parameterized keys and values.
	 * Keys are parameterized (metadata->>$N::text) to prevent SQL injection
	 * from user-supplied metadata keys.
	 */
	buildFilterClauses(
		filter: Record<string, unknown>,
		paramOffset = 0,
	): FilterClauses {
		const clauses: string[] = [];
		const params: unknown[] = [];
		let paramCount = paramOffset;

		for (const [key, value] of Object.entries(filter)) {
			if (Array.isArray(value)) {
				const keyPh = `$${paramCount + 1}`;
				const valuePlaceholders = value
					.map((_, i) => `$${paramCount + 2 + i}`)
					.join(',');
				clauses.push(`metadata->>${keyPh}::text IN (${valuePlaceholders})`);
				paramCount += 1 + value.length;
				params.push(key, ...value);
			} else {
				const keyPh = `$${paramCount + 1}`;
				const valuePh = `$${paramCount + 2}`;
				clauses.push(`metadata->>${keyPh}::text = ${valuePh}`);
				paramCount += 2;
				params.push(key, value);
			}
		}

		return { clauses, params };
	}

	async delete(params: {
		ids?: string[];
		filter?: Record<string, unknown>;
	}): Promise<void> {
		if ('ids' in params && params.ids) {
			await this.pool.query(
				`DELETE FROM "${this.tableName}" WHERE id = ANY($1)`,
				[params.ids],
			);
		} else if ('filter' in params && params.filter) {
			const fc = this.buildFilterClauses(params.filter, 0);
			await this.pool.query(
				`DELETE FROM "${this.tableName}" WHERE ${fc.clauses.join(' AND ')}`,
				fc.params,
			);
		}
	}
}
