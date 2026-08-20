import type { ISupplyDataFunctions } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

// Mock @n8n/ai-utilities — minimal createVectorStoreNode that delegates to config functions
vi.mock('@n8n/ai-utilities', () => ({
	metadataFilterField: {},
	createVectorStoreNode: (config: {
		getVectorStoreClient: (...args: unknown[]) => unknown;
		populateVectorStore: (...args: unknown[]) => unknown;
	}) =>
		class BaseNode {
			async getVectorStoreClient(...args: unknown[]) {
				return config.getVectorStoreClient.apply(config, args);
			}
			async populateVectorStore(...args: unknown[]) {
				return config.populateVectorStore.apply(config, args);
			}
		},
}));

vi.mock('n8n-nodes-base/dist/nodes/Postgres/transport/index', () => ({
	configurePostgres: vi.fn(),
}));

vi.mock('./GaussDBVectorStore', () => ({
	GaussDBVectorStore: {
		initialize: vi.fn(),
	},
}));

import { configurePostgres } from 'n8n-nodes-base/dist/nodes/Postgres/transport/index';
import { GaussDBVectorStore } from './GaussDBVectorStore';
import * as GaussDBNode from './VectorStoreGaussDB.node';
import type { MockedFunction } from 'vitest';

const MockConfigurePostgres = configurePostgres as MockedFunction<typeof configurePostgres>;
const MockInitialize = GaussDBVectorStore.initialize as MockedFunction<
	typeof GaussDBVectorStore.initialize
>;

const baseCredentials = {
	host: 'localhost',
	port: 5432,
	database: 'test',
	user: 'test',
	password: 'test',
};

const mockPool = { id: 'mock-pool' };
const mockStore = {
	addDocuments: vi.fn().mockResolvedValue(undefined),
};

function createContext(paramMap: Record<string, unknown> = {}) {
	return {
		getCredentials: vi.fn().mockResolvedValue(baseCredentials),
		getNodeParameter: vi.fn((name: string) => {
			const defaults: Record<string, unknown> = {
				tableName: 'n8n_vectors',
				indexType: 'auto',
			};
			return paramMap[name] ?? defaults[name];
		}),
		getNode: () => ({ name: 'VectorStoreGaussDB' }),
	};
}

describe('VectorStoreGaussDB.node', () => {
	const helpers = mock<ISupplyDataFunctions['helpers']>();
	const dataFunctions = mock<ISupplyDataFunctions>({ helpers });
	dataFunctions.logger = {
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		verbose: vi.fn(),
	} as unknown as ISupplyDataFunctions['logger'];

	beforeEach(() => {
		vi.resetAllMocks();
		MockConfigurePostgres.mockResolvedValue({
			db: { $pool: mockPool },
		} as never);
		MockInitialize.mockResolvedValue(mockStore as never);
	});

	describe('getVectorStoreClient', () => {
		it('should create vector store client with default tableName and indexType', async () => {
			const mockEmbeddings = {} as never;
			const context = createContext();

			const node = new GaussDBNode.VectorStoreGaussDB();
			const result = await (node as unknown as { getVectorStoreClient: (...a: unknown[]) => Promise<unknown> }).getVectorStoreClient(
				context,
				undefined,
				mockEmbeddings,
				0,
			);

			expect(context.getCredentials).toHaveBeenCalledWith('postgres');
			expect(MockConfigurePostgres).toHaveBeenCalledWith(baseCredentials);
			expect(MockInitialize).toHaveBeenCalledWith(mockEmbeddings, {
				pool: mockPool,
				tableName: 'n8n_vectors',
				indexType: 'auto',
				filter: undefined,
			});
			expect(result).toBe(mockStore);
		});

		it('should pass custom tableName and indexType', async () => {
			const mockEmbeddings = {} as never;
			const context = createContext({
				tableName: 'my_vectors',
				indexType: 'gsivfflat',
			});

			const node = new GaussDBNode.VectorStoreGaussDB();
			await (node as unknown as { getVectorStoreClient: (...a: unknown[]) => Promise<unknown> }).getVectorStoreClient(
				context,
				undefined,
				mockEmbeddings,
				0,
			);

			expect(MockInitialize).toHaveBeenCalledWith(mockEmbeddings, {
				pool: mockPool,
				tableName: 'my_vectors',
				indexType: 'gsivfflat',
				filter: undefined,
			});
		});

		it('should pass filter to initialize', async () => {
			const mockEmbeddings = {} as never;
			const context = createContext();
			const filter = { category: 'docs' };

			const node = new GaussDBNode.VectorStoreGaussDB();
			await (node as unknown as { getVectorStoreClient: (...a: unknown[]) => Promise<unknown> }).getVectorStoreClient(
				context,
				filter,
				mockEmbeddings,
				0,
			);

			expect(MockInitialize).toHaveBeenCalledWith(mockEmbeddings, {
				pool: mockPool,
				tableName: 'n8n_vectors',
				indexType: 'auto',
				filter,
			});
		});
	});

	describe('populateVectorStore', () => {
		it('should get dimensions from embeddings.embedQuery and add documents', async () => {
			const mockEmbeddings = {
				embedQuery: vi.fn().mockResolvedValue([1, 2, 3, 4]),
			};
			const mockDocuments = [
				{ pageContent: 'doc 1', metadata: { id: 1 } },
				{ pageContent: 'doc 2', metadata: { id: 2 } },
			];
			const context = createContext({
				tableName: 'my_table',
				indexType: 'gsdiskann',
			});

			const node = new GaussDBNode.VectorStoreGaussDB();
			await (node as unknown as { populateVectorStore: (...a: unknown[]) => Promise<unknown> }).populateVectorStore(
				context,
				mockEmbeddings,
				mockDocuments,
				0,
			);

			expect(mockEmbeddings.embedQuery).toHaveBeenCalledWith('test');
			expect(MockInitialize).toHaveBeenCalledWith(mockEmbeddings, {
				pool: mockPool,
				tableName: 'my_table',
				dimensions: 4,
				indexType: 'gsdiskann',
			});
			expect(mockStore.addDocuments).toHaveBeenCalledWith(mockDocuments);
		});

		it('should use default tableName and indexType when not specified', async () => {
			const mockEmbeddings = {
				embedQuery: vi.fn().mockResolvedValue([1, 2, 3]),
			};
			const mockDocuments = [{ pageContent: 'doc 1', metadata: {} }];
			const context = createContext();

			const node = new GaussDBNode.VectorStoreGaussDB();
			await (node as unknown as { populateVectorStore: (...a: unknown[]) => Promise<unknown> }).populateVectorStore(
				context,
				mockEmbeddings,
				mockDocuments,
				0,
			);

			expect(MockInitialize).toHaveBeenCalledWith(mockEmbeddings, {
				pool: mockPool,
				tableName: 'n8n_vectors',
				dimensions: 3,
				indexType: 'auto',
			});
		});

		it('should call configurePostgres with postgres credentials', async () => {
			const mockEmbeddings = {
				embedQuery: vi.fn().mockResolvedValue([1, 2, 3]),
			};
			const mockDocuments = [{ pageContent: 'doc 1', metadata: {} }];
			const context = createContext();

			const node = new GaussDBNode.VectorStoreGaussDB();
			await (node as unknown as { populateVectorStore: (...a: unknown[]) => Promise<unknown> }).populateVectorStore(
				context,
				mockEmbeddings,
				mockDocuments,
				0,
			);

			expect(context.getCredentials).toHaveBeenCalledWith('postgres');
			expect(MockConfigurePostgres).toHaveBeenCalledWith(baseCredentials);
		});
	});
});
