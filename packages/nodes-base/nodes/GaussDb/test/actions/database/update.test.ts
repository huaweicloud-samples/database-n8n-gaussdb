import get from 'lodash/get';
import type {
	IDataObject,
	IExecuteFunctions,
	IGetNodeParameterOptions,
	INode,
	INodeParameters,
} from 'n8n-workflow';

import * as update from '../../../actions/database/update.operation';
import type { ColumnInfo, PgpDatabase, QueriesRunner } from '../../../../Postgres/v2/helpers/interfaces';

const runQueries: QueriesRunner = vi.fn().mockResolvedValue([]);

const node: INode = {
	id: '1',
	name: 'GaussDB node',
	typeVersion: 1,
	type: 'n8n-nodes-base.gaussDb',
	position: [0, 0],
	parameters: {
		operation: 'update',
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

describe('Test GaussDb, update operation', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('dataMode: defineBelow, should call runQueries with UPDATE query', async () => {
		const nodeParameters: IDataObject = {
			operation: 'update',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list' },
			dataMode: 'defineBelow',
			columnToMatchOn: 'id',
			valueToMatchOn: '1',
			valuesToSend: {
				values: [
					{ column: 'json', value: { text: 'some text' } },
					{ column: 'foo', value: 'updated' },
				],
			},
			options: {
				outputColumns: ['json', 'foo'],
				nodeVersion: 1,
			},
		};
		const columnsInfo: ColumnInfo[] = [
			{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', udt_name: '' },
			{ column_name: 'json', data_type: 'json', is_nullable: 'NO', udt_name: '' },
			{ column_name: 'foo', data_type: 'text', is_nullable: 'NO', udt_name: '' },
		];

		const nodeOptions = nodeParameters.options as IDataObject;

		await update.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
			createMockDb(columnsInfo),
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query:
						'UPDATE $1:name.$2:name SET $5:name = $6, $7:name = $8 WHERE $3:name = $4 RETURNING $9:name',
					values: [
						'public',
						'my_table',
						'id',
						'1',
						'json',
						{ text: 'some text' },
						'foo',
						'updated',
						['json', 'foo'],
					],
				},
			],
			nodeOptions,
		);
	});

	it('dataMode: autoMapInputData, should call runQueries with UPDATE query per item', async () => {
		const nodeParameters: IDataObject = {
			operation: 'update',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list' },
			dataMode: 'autoMapInputData',
			columnToMatchOn: 'id',
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

		await update.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			inputItems,
			nodeOptions,
			createMockDb(columnsInfo),
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query: 'UPDATE $1:name.$2:name SET $5:name = $6 WHERE $3:name = $4 RETURNING *',
					values: ['public', 'my_table', 'id', 1, 'foo', 'data 1'],
				},
				{
					query: 'UPDATE $1:name.$2:name SET $5:name = $6 WHERE $3:name = $4 RETURNING *',
					values: ['public', 'my_table', 'id', 2, 'foo', 'data 2'],
				},
			],
			nodeOptions,
		);
	});
});
