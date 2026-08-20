import get from 'lodash/get';
import pgPromise from 'pg-promise';
import type {
	IDataObject,
	IExecuteFunctions,
	IGetNodeParameterOptions,
	INode,
	INodeParameters,
} from 'n8n-workflow';

import * as insert from '../../../actions/database/insert.operation';
import type { ColumnInfo, PgpDatabase, QueriesRunner } from '../../../../Postgres/v2/helpers/interfaces';

const runQueries: QueriesRunner = vi.fn().mockResolvedValue([]);

const node: INode = {
	id: '1',
	name: 'GaussDB node',
	typeVersion: 1,
	type: 'n8n-nodes-base.gaussDb',
	position: [0, 0],
	parameters: {
		operation: 'insert',
	},
};

const items = [{ json: {} }];

const createMockExecuteFunction = (nodeParameters: IDataObject) => {
	const fakeExecuteFunction = {
		getNodeParameter(
			parameterName: string,
			_itemIndex: number,
			fallbackValue?: IDataObject,
			options?: IGetNodeParameterOptions,
		) {
			const parameter = options?.extractValue ? `${parameterName}.value` : parameterName;
			return get(nodeParameters, parameter, fallbackValue);
		},
		getNode() {
			node.parameters = { ...node.parameters, ...(nodeParameters as INodeParameters) };
			return node;
		},
		evaluateExpression(str: string, _: number) {
			return str.replace('{{', '').replace('}}', '');
		},
		continueOnFail() {
			return false;
		},
	} as unknown as IExecuteFunctions;
	return fakeExecuteFunction;
};

const createMockDb = (columnInfo: ColumnInfo[]) => {
	return {
		async any() {
			return columnInfo;
		},
	} as unknown as PgpDatabase;
};

describe('Test GaussDb, insert operation', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('dataMode: defineBelow, should call runQueries with INSERT query', async () => {
		const nodeParameters: IDataObject = {
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list' },
			dataMode: 'defineBelow',
			valuesToSend: {
				values: [
					{ column: 'json', value: '{"test":15}' },
					{ column: 'foo', value: 'select 5' },
					{ column: 'id', value: '4' },
				],
			},
			options: { nodeVersion: 1 },
		};
		const columnsInfo: ColumnInfo[] = [
			{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', udt_name: '' },
			{ column_name: 'json', data_type: 'json', is_nullable: 'NO', udt_name: '' },
			{ column_name: 'foo', data_type: 'text', is_nullable: 'NO', udt_name: '' },
		];

		const nodeOptions = nodeParameters.options as IDataObject;

		await insert.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
			createMockDb(columnsInfo),
			pgPromise(),
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query: 'INSERT INTO $1:name.$2:name($3:name) VALUES($3:csv) RETURNING *',
					values: ['public', 'my_table', { json: '{"test":15}', foo: 'select 5', id: '4' }],
				},
			],
			nodeOptions,
		);
	});

	it('dataMode: autoMapInputData, should call runQueries with INSERT query per item', async () => {
		const nodeParameters: IDataObject = {
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list' },
			dataMode: 'autoMapInputData',
			options: { nodeVersion: 1 },
		};
		const columnsInfo: ColumnInfo[] = [
			{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', udt_name: '' },
			{ column_name: 'foo', data_type: 'text', is_nullable: 'NO', udt_name: '' },
		];

		const inputItems = [
			{ json: { id: 1, foo: 'data 1' } },
			{ json: { id: 2, foo: 'data 2' } },
		];

		const nodeOptions = nodeParameters.options as IDataObject;

		await insert.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			inputItems,
			nodeOptions,
			createMockDb(columnsInfo),
			pgPromise(),
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query: 'INSERT INTO $1:name.$2:name($3:name) VALUES($3:csv) RETURNING *',
					values: ['public', 'my_table', { id: 1, foo: 'data 1' }],
				},
				{
					query: 'INSERT INTO $1:name.$2:name($3:name) VALUES($3:csv) RETURNING *',
					values: ['public', 'my_table', { id: 2, foo: 'data 2' }],
				},
			],
			nodeOptions,
		);
	});
});
