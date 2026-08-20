import get from 'lodash/get';
import type {
	IDataObject,
	IExecuteFunctions,
	IGetNodeParameterOptions,
	INode,
	INodeParameters,
} from 'n8n-workflow';

import * as deleteTable from '../../../actions/database/deleteTable.operation';
import type { QueriesRunner } from '../../../../Postgres/v2/helpers/interfaces';

const runQueries: QueriesRunner = vi.fn().mockResolvedValue([]);

const node: INode = {
	id: '1',
	name: 'GaussDB node',
	typeVersion: 1,
	type: 'n8n-nodes-base.gaussDb',
	position: [0, 0],
	parameters: {
		operation: 'deleteTable',
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
	} as unknown as IExecuteFunctions;
	return fakeExecuteFunction;
};

describe('Test GaussDb, deleteTable operation', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('deleteCommand: delete, should call runQueries with DELETE FROM query', async () => {
		const nodeParameters: IDataObject = {
			operation: 'deleteTable',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list', cachedResultName: 'my_table' },
			deleteCommand: 'delete',
			where: {
				values: [{ column: 'id', condition: 'LIKE', value: '1' }],
			},
			options: { nodeVersion: 1 },
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await deleteTable.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query: 'DELETE FROM $1:name.$2:name WHERE $3:name LIKE $4',
					values: ['public', 'my_table', 'id', '1'],
				},
			],
			nodeOptions,
		);
	});

	it('deleteCommand: truncate, should call runQueries with TRUNCATE TABLE query', async () => {
		const nodeParameters: IDataObject = {
			operation: 'deleteTable',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list', cachedResultName: 'my_table' },
			deleteCommand: 'truncate',
			restartSequences: true,
			options: { nodeVersion: 1, cascade: true },
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await deleteTable.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query: 'TRUNCATE TABLE $1:name.$2:name RESTART IDENTITY CASCADE',
					values: ['public', 'my_table'],
				},
			],
			nodeOptions,
		);
	});

	it('deleteCommand: drop, should call runQueries with DROP TABLE query', async () => {
		const nodeParameters: IDataObject = {
			operation: 'deleteTable',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list', cachedResultName: 'my_table' },
			deleteCommand: 'drop',
			options: { nodeVersion: 1, cascade: true },
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await deleteTable.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query: 'DROP TABLE IF EXISTS $1:name.$2:name CASCADE',
					values: ['public', 'my_table'],
				},
			],
			nodeOptions,
		);
	});

	it('invalid deleteCommand, should throw', async () => {
		const nodeParameters: IDataObject = {
			operation: 'deleteTable',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list', cachedResultName: 'my_table' },
			deleteCommand: 'invalid',
			options: { nodeVersion: 1 },
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await expect(
			deleteTable.execute.call(
				createMockExecuteFunction(nodeParameters),
				runQueries,
				items,
				nodeOptions,
			),
		).rejects.toThrow();
	});
});
