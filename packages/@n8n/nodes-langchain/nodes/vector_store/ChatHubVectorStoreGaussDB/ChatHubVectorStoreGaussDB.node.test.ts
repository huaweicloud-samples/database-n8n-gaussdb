import { mock } from 'vitest-mock-extended';
import { vi, describe, test, expect, beforeEach } from 'vitest';
import { Document } from '@langchain/core/documents';
import type { Embeddings } from '@langchain/core/embeddings';
import type {
	ILoadOptionsFunctions,
	ICredentialTestFunctions,
	ISupplyDataFunctions,
	ICredentialsDecrypted,
	IDataObject,
} from 'n8n-workflow';
import type pg from 'pg';

vi.mock('n8n-nodes-base/dist/nodes/Postgres/transport/index', () => ({
	configurePostgres: vi.fn(),
}));
vi.mock('n8n-nodes-base/dist/nodes/Postgres/v2/methods/credentialTest', () => ({
	postgresConnectionTest: vi.fn(),
}));
vi.mock('../VectorStoreGaussDB/GaussDBVectorStore', () => ({
	GaussDBVectorStore: { initialize: vi.fn() },
}));
vi.mock('../shared/userScoped', () => ({
	getUserScopedSlot: vi.fn(),
}));

import { configurePostgres } from 'n8n-nodes-base/dist/nodes/Postgres/transport/index';
import { postgresConnectionTest } from 'n8n-nodes-base/dist/nodes/Postgres/v2/methods/credentialTest';
import { GaussDBVectorStore } from '../VectorStoreGaussDB/GaussDBVectorStore';
import { getUserScopedSlot } from '../shared/userScoped';
import {
	ChatHubVectorStoreGaussDB,
	getVectorStoreClient,
	populateVectorStore,
} from './ChatHubVectorStoreGaussDB.node';

const TABLE_NAME = 'n8n_vectors_user123';

type PostgresConf = Awaited<ReturnType<typeof configurePostgres>>;

function makePool(queryResult?: { rows: unknown[] }) {
	const pool = {
		query: vi.fn().mockResolvedValue(queryResult ?? { rows: [] }),
	};
	return pool as unknown as pg.Pool;
}

function makeEmbeddings(dim = 3): Embeddings {
	return { embedQuery: vi.fn().mockResolvedValue(Array.from({ length: dim }, (_, i) => i)) } as unknown as Embeddings;
}

function makeGaussCredentials() {
	return {
		host: 'localhost',
		port: 5432,
		user: 'u',
		password: 'p',
		database: 'db',
		tableNamePrefix: 'n8n_vectors',
		enable_vectordb: 'on',
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getUserScopedSlot).mockReturnValue(TABLE_NAME);
});

describe('ChatHubVectorStoreGaussDB credentials test', () => {
	function getNode() {
		return new ChatHubVectorStoreGaussDB();
	}

	async function runConnectionTest(pool: pg.Pool) {
		vi.mocked(postgresConnectionTest).mockResolvedValue({ status: 'OK', message: '' });
		vi.mocked(configurePostgres).mockResolvedValue({ db: { $pool: pool } } as unknown as PostgresConf);

		const ctx = mock<ICredentialTestFunctions>();
		const credential: ICredentialsDecrypted = {
			id: '1',
			name: 'test',
			type: 'chatHubVectorStoreGaussDBApi',
			data: makeGaussCredentials(),
		} as unknown as ICredentialsDecrypted;

		const fn = getNode().methods?.credentialTest?.chatHubVectorStoreGaussDBApiConnectionTest;
		if (!fn) throw new Error('credentialTest function not found');
		return await fn.call(ctx, credential);
	}

	test('returns OK when enable_vectordb is on', async () => {
		const pool = makePool({ rows: [{ enable_vectordb: 'on' }] });

		const result = await runConnectionTest(pool);

		expect(result.status).toBe('OK');
		expect(pool.query).toHaveBeenCalledWith('SHOW enable_vectordb');
	});

	test('returns Error when enable_vectordb is off', async () => {
		const pool = makePool({ rows: [{ enable_vectordb: 'off' }] });

		const result = await runConnectionTest(pool);

		expect(result.status).toBe('Error');
		expect(result.message).toContain('enable_vectordb');
	});

	test('returns Error when postgres connection test fails', async () => {
		vi.mocked(postgresConnectionTest).mockResolvedValue({
			status: 'Error',
			message: 'connection refused',
		});

		const ctx = mock<ICredentialTestFunctions>();
		const credential = { id: '1', name: 't', type: 'x', data: makeGaussCredentials() } as unknown as ICredentialsDecrypted;
		const fn = getNode().methods?.credentialTest?.chatHubVectorStoreGaussDBApiConnectionTest;
		if (!fn) throw new Error('credentialTest function not found');
		const result = await fn.call(ctx, credential);

		expect(result.status).toBe('Error');
	});
});

describe('ChatHubVectorStoreGaussDB getVectorStoreClient', () => {
	async function setup() {
		const pool = makePool();
		vi.mocked(configurePostgres).mockResolvedValue({ db: { $pool: pool } } as unknown as PostgresConf);

		const ctx = mock<ISupplyDataFunctions>({
			getCredentials: vi.fn().mockResolvedValue(makeGaussCredentials()),
		});

		const fakeStore = {
			similaritySearchVectorWithScore: vi.fn().mockResolvedValue([
				[
					new Document({
						pageContent: 'doc',
						metadata: { loc: { page: 1 }, fileName: 'a.pdf', secret: 'hidden' },
					}),
					0.9,
				],
			]),
		};
		vi.mocked(GaussDBVectorStore.initialize).mockResolvedValue(fakeStore as unknown as GaussDBVectorStore);

		const embeddings = makeEmbeddings();
		const store = await getVectorStoreClient(ctx, undefined, embeddings, 0);
		return { ctx, pool, embeddings, store, fakeStore };
	}

	test('uses user-scoped table name and passes pool/filter to initialize', async () => {
		const { ctx, pool, embeddings } = await setup();

		expect(getUserScopedSlot).toHaveBeenCalledWith(ctx, 'n8n_vectors', 0);
		expect(GaussDBVectorStore.initialize).toHaveBeenCalledWith(embeddings, {
			pool,
			tableName: TABLE_NAME,
			filter: undefined,
		});
	});

	test('wraps similaritySearchVectorWithScore to filter metadata', async () => {
		const { store } = await setup();

		const results = await store.similaritySearchVectorWithScore([1, 2, 3], 4);

		expect(results).toHaveLength(1);
		expect(results[0][0].metadata).toEqual({ loc: { page: 1 }, fileName: 'a.pdf' });
		expect(results[0][0].metadata).not.toHaveProperty('secret');
	});

	test('forwards provided filter to initialize', async () => {
		const pool = makePool();
		vi.mocked(configurePostgres).mockResolvedValue({ db: { $pool: pool } } as unknown as PostgresConf);
		const ctx = mock<ISupplyDataFunctions>({
			getCredentials: vi.fn().mockResolvedValue(makeGaussCredentials()),
		});
		const fakeStore = { similaritySearchVectorWithScore: vi.fn().mockResolvedValue([]) };
		vi.mocked(GaussDBVectorStore.initialize).mockResolvedValue(fakeStore as unknown as GaussDBVectorStore);

		const filter = { agentId: 'a1' };
		await getVectorStoreClient(ctx, filter as unknown as Record<string, never>, makeEmbeddings(), 0);

		expect(GaussDBVectorStore.initialize).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ filter }),
		);
	});
});

describe('ChatHubVectorStoreGaussDB deleteDocuments', () => {
	function getDeleteFn() {
		const fn = new ChatHubVectorStoreGaussDB().methods?.actionHandler?.deleteDocuments;
		if (!fn) throw new Error('deleteDocuments not found');
		return fn;
	}

	async function setupContext() {
		const pool = makePool();
		vi.mocked(configurePostgres).mockResolvedValue({ db: { $pool: pool } } as unknown as PostgresConf);
		const ctx = mock<ILoadOptionsFunctions>({
			getCredentials: vi.fn().mockResolvedValue(makeGaussCredentials()),
		});
		return { ctx, pool };
	}

	test('drops the user-scoped table when no filter is provided', async () => {
		const { ctx, pool } = await setupContext();
		const fn = getDeleteFn();

		await fn.call(ctx, undefined);

		expect(pool.query).toHaveBeenCalledWith(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
	});

	test('deletes by filter when a filter is provided', async () => {
		const { ctx, pool } = await setupContext();
		const fn = getDeleteFn();

		await fn.call(ctx, JSON.stringify({ filter: { agentId: 'a1' } }));

		const callArgs = vi.mocked(pool.query).mock.calls[0];
		expect(callArgs[0]).toContain(`DELETE FROM "${TABLE_NAME}"`);
		expect(callArgs[0]).toContain('metadata->>');
		expect(callArgs[1]).toEqual(expect.arrayContaining(['agentId', 'a1']));
	});

	test('accepts object payload (not just string)', async () => {
		const { ctx, pool } = await setupContext();
		const fn = getDeleteFn();

		const payload: IDataObject = { filter: { fileName: 'x.pdf' } };
		await fn.call(ctx, payload);

		const callArgs = vi.mocked(pool.query).mock.calls[0];
		expect(callArgs[0]).toContain(`DELETE FROM "${TABLE_NAME}"`);
	});
});

describe('ChatHubVectorStoreGaussDB populateVectorStore', () => {
	test('probes dimensions via embedQuery and adds filtered documents', async () => {
		const pool = makePool();
		vi.mocked(configurePostgres).mockResolvedValue({ db: { $pool: pool } } as unknown as PostgresConf);
		const ctx = mock<ISupplyDataFunctions>({
			getCredentials: vi.fn().mockResolvedValue(makeGaussCredentials()),
		});

		const embeddings = makeEmbeddings(4);
		const fakeStore = { addDocuments: vi.fn().mockResolvedValue(undefined) };
		vi.mocked(GaussDBVectorStore.initialize).mockResolvedValue(fakeStore as unknown as GaussDBVectorStore);

		const documents = [
			new Document({ pageContent: 'a', metadata: { fileName: 'a.pdf', secret: 'x' } }),
		];

		await populateVectorStore(ctx, embeddings, documents, 0);

		// dimensions probed via embedQuery('test')
		expect(embeddings.embedQuery).toHaveBeenCalledWith('test');
		// initialize called with probed dimensions (4)
		expect(GaussDBVectorStore.initialize).toHaveBeenCalledWith(embeddings, {
			pool,
			tableName: TABLE_NAME,
			dimensions: 4,
		});
		// documents filtered before insert (secret key stripped)
		expect(fakeStore.addDocuments).toHaveBeenCalledTimes(1);
		const passedDocs = fakeStore.addDocuments.mock.calls[0][0] as Document[];
		expect(passedDocs[0].metadata).toEqual({ fileName: 'a.pdf' });
	});
});
