import { mock } from 'vitest-mock-extended';
import type { ILoadOptionsFunctions, INode } from 'n8n-workflow';

import type { GaussDbNodeCredentials } from '../../helpers/interfaces';

const { mockConfigureGaussDb, mockDb } = vi.hoisted(() => ({
	mockConfigureGaussDb: vi.fn(),
	mockDb: { any: vi.fn() },
}));

vi.mock('../../transport', () => ({
	configureGaussDb: mockConfigureGaussDb,
}));

import { schemaSearch, tableSearch } from '../../methods/listSearch';

describe('listSearch', () => {
	const credentialsData: GaussDbNodeCredentials = {
		host: 'localhost',
		database: 'testdb',
		user: 'gaussdb',
		password: 'secret',
		port: 8000,
		ssl: 'disable',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockConfigureGaussDb.mockResolvedValue({ db: mockDb, pgp: vi.fn() });
	});

	describe('schemaSearch', () => {
		it('returns schemas as { results: [{name, value}] }', async () => {
			const schemas = [{ schema_name: 'public' }, { schema_name: 'information_schema' }];
			mockDb.any.mockResolvedValue(schemas);

			const thisArg = mock<ILoadOptionsFunctions>();
			thisArg.getCredentials.mockResolvedValue(credentialsData);
			thisArg.getNode.mockReturnValue({ typeVersion: 1 } as INode);

			const result = await schemaSearch.call(thisArg);

			expect(result).toEqual({
				results: schemas.map(({ schema_name }) => ({ name: schema_name, value: schema_name })),
			});
			expect(mockDb.any).toHaveBeenCalledWith(
				'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name',
			);
		});
	});

	describe('tableSearch', () => {
		it('returns tables filtered by schema and passes schema as $1', async () => {
			const tables = [{ table_name: 'users' }, { table_name: 'orders' }];
			mockDb.any.mockResolvedValue(tables);

			const thisArg = mock<ILoadOptionsFunctions>();
			thisArg.getCredentials.mockResolvedValue(credentialsData);
			thisArg.getNode.mockReturnValue({ typeVersion: 1 } as INode);
			thisArg.getNodeParameter.mockReturnValue('public');

			const result = await tableSearch.call(thisArg);

			expect(result).toEqual({
				results: tables.map(({ table_name }) => ({ name: table_name, value: table_name })),
			});
			expect(mockDb.any).toHaveBeenCalledWith(
				'SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name',
				['public'],
			);
		});
	});
});
