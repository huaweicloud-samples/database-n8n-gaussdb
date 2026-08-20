import { mock } from 'vitest-mock-extended';
import type { ILoadOptionsFunctions, INode } from 'n8n-workflow';

import type { GaussDbNodeCredentials } from '../../helpers/interfaces';

const { mockConfigureGaussDb, mockDb, mockGetTableSchema } = vi.hoisted(() => ({
	mockConfigureGaussDb: vi.fn(),
	mockDb: {},
	mockGetTableSchema: vi.fn(),
}));

vi.mock('../../transport', () => ({
	configureGaussDb: mockConfigureGaussDb,
}));

vi.mock('../../../Postgres/v2/helpers/utils', () => ({
	getTableSchema: mockGetTableSchema,
}));

import {
	getColumns,
	getColumnsMultiOptions,
	getColumnsWithoutColumnToMatchOn,
} from '../../methods/loadOptions';

describe('loadOptions', () => {
	const credentialsData: GaussDbNodeCredentials = {
		host: 'localhost',
		database: 'testdb',
		user: 'gaussdb',
		password: 'secret',
		port: 8000,
		ssl: 'disable',
	};

	const columnsInfo = [
		{
			column_name: 'id',
			data_type: 'integer',
			is_nullable: 'NO',
			udt_name: 'int4',
			column_default: null,
		},
		{
			column_name: 'name',
			data_type: 'text',
			is_nullable: 'YES',
			udt_name: 'text',
			column_default: null,
		},
	];

	const setupThisArg = (parameterOverrides: Record<string, string> = {}) => {
		const thisArg = mock<ILoadOptionsFunctions>();
		thisArg.getCredentials.mockResolvedValue(credentialsData);
		thisArg.getNode.mockReturnValue({ typeVersion: 1 } as INode);
		thisArg.getNodeParameter.mockImplementation((name: string) => {
			if (name in parameterOverrides) return parameterOverrides[name];
			if (name === 'schema') return 'public';
			if (name === 'table') return 'users';
			return '';
		});
		return thisArg;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockConfigureGaussDb.mockResolvedValue({ db: mockDb, pgp: vi.fn() });
		mockGetTableSchema.mockResolvedValue(columnsInfo);
	});

	describe('getColumns', () => {
		it('returns columns with type and nullable description', async () => {
			const thisArg = setupThisArg();

			const result = await getColumns.call(thisArg);

			expect(result).toEqual([
				{
					name: columnsInfo[0].column_name,
					value: columnsInfo[0].column_name,
					description: 'Type: INTEGER, Nullable: NO',
				},
				{
					name: columnsInfo[1].column_name,
					value: columnsInfo[1].column_name,
					description: 'Type: TEXT, Nullable: YES',
				},
			]);
			expect(mockGetTableSchema).toHaveBeenCalledWith(mockDb, 'public', 'users');
		});
	});

	describe('getColumnsMultiOptions', () => {
		it('prepends an "All columns" option', async () => {
			const thisArg = setupThisArg();

			const result = await getColumnsMultiOptions.call(thisArg);

			expect(result[0]).toEqual({ name: '*', value: '*', description: 'All columns' });
			expect(result).toHaveLength(3);
		});
	});

	describe('getColumnsWithoutColumnToMatchOn', () => {
		it('excludes the columnToMatchOn column', async () => {
			const thisArg = setupThisArg({ columnToMatchOn: 'id' });

			const result = await getColumnsWithoutColumnToMatchOn.call(thisArg);

			expect(result).toEqual([
				{
					name: columnsInfo[1].column_name,
					value: columnsInfo[1].column_name,
					description: 'Type: TEXT, Nullable: YES',
				},
			]);
		});
	});
});
