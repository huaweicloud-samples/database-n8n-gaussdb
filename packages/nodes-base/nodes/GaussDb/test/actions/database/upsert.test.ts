import get from 'lodash/get';
import type {
	IDataObject,
	IExecuteFunctions,
	IGetNodeParameterOptions,
	INode,
	INodeParameters,
} from 'n8n-workflow';

import * as upsert from '../../../actions/database/upsert.operation';
import type { ColumnInfo, PgpDatabase, QueriesRunner } from '../../../../Postgres/v2/helpers/interfaces';

const runQueries: QueriesRunner = vi.fn().mockResolvedValue([]);

const node: INode = {
	id: '1',
	name: 'GaussDB node',
	typeVersion: 1,
	type: 'n8n-nodes-base.gaussDb',
	position: [0, 0],
	parameters: {
		operation: 'upsert',
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

describe('Test GaussDb, upsert operation', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('dataMode: defineBelow, should call runQueries with MERGE INTO query', async () => {
		const nodeParameters: IDataObject = {
			operation: 'upsert',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list' },
			dataMode: 'defineBelow',
			columnToMatchOn: 'id',
			valueToMatchOn: '5',
			valuesToSend: {
				values: [
					{ column: 'json', value: '{ "test": 5 }' },
					{ column: 'foo', value: 'data 5' },
				],
			},
			options: {
				outputColumns: ['json'],
				nodeVersion: 1,
			},
		};
		const columnsInfo: ColumnInfo[] = [
			{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', udt_name: '' },
			{ column_name: 'json', data_type: 'json', is_nullable: 'NO', udt_name: '' },
			{ column_name: 'foo', data_type: 'text', is_nullable: 'NO', udt_name: '' },
		];

		const nodeOptions = nodeParameters.options as IDataObject;

		await upsert.execute.call(
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
						'MERGE INTO $1:name.$2:name t USING (SELECT $3 AS c1, $4 AS c2, $5 AS c3) s ON (t.$8:name = s.c3) WHEN MATCHED THEN UPDATE SET $6:name = s.c1, $7:name = s.c2 WHEN NOT MATCHED THEN INSERT ($6:name, $7:name, $8:name) VALUES (s.c1, s.c2, s.c3)',
					values: [
						'public',
						'my_table',
						'{ "test": 5 }',
						'data 5',
						'5',
						'json',
						'foo',
						'id',
					],
				},
			],
			nodeOptions,
		);
	});

	it('dataMode: autoMapInputData, should call runQueries with MERGE INTO query per item', async () => {
		const nodeParameters: IDataObject = {
			operation: 'upsert',
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

		await upsert.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			inputItems,
			nodeOptions,
			createMockDb(columnsInfo),
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query:
						'MERGE INTO $1:name.$2:name t USING (SELECT $3 AS c1, $4 AS c2) s ON (t.$5:name = s.c1) WHEN MATCHED THEN UPDATE SET $6:name = s.c2 WHEN NOT MATCHED THEN INSERT ($5:name, $6:name) VALUES (s.c1, s.c2)',
					values: ['public', 'my_table', 1, 'data 1', 'id', 'foo'],
				},
				{
					query:
						'MERGE INTO $1:name.$2:name t USING (SELECT $3 AS c1, $4 AS c2) s ON (t.$5:name = s.c1) WHEN MATCHED THEN UPDATE SET $6:name = s.c2 WHEN NOT MATCHED THEN INSERT ($5:name, $6:name) VALUES (s.c1, s.c2)',
					values: ['public', 'my_table', 2, 'data 2', 'id', 'foo'],
				},
			],
			nodeOptions,
		);
	});
});
