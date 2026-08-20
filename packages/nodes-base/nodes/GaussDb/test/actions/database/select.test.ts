import get from 'lodash/get';
import type {
	IDataObject,
	IExecuteFunctions,
	IGetNodeParameterOptions,
	INode,
	INodeParameters,
} from 'n8n-workflow';

import * as select from '../../../actions/database/select.operation';
import type { QueriesRunner } from '../../../../Postgres/v2/helpers/interfaces';

const runQueries: QueriesRunner = vi.fn().mockResolvedValue([]);

const node: INode = {
	id: '1',
	name: 'GaussDB node',
	typeVersion: 1,
	type: 'n8n-nodes-base.gaussDb',
	position: [0, 0],
	parameters: {
		operation: 'select',
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

describe('Test GaussDb, select operation', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('returnAll, should call runQueries with SELECT * query', async () => {
		const nodeParameters: IDataObject = {
			operation: 'select',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list', cachedResultName: 'my_table' },
			returnAll: true,
			options: {},
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await select.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query: 'SELECT * FROM $1:name.$2:name',
					values: ['public', 'my_table'],
				},
			],
			nodeOptions,
		);
	});

	it('limit, whereClauses, sortRules, outputColumns, should call runQueries with full query', async () => {
		const nodeParameters: IDataObject = {
			operation: 'select',
			schema: { __rl: true, mode: 'list', value: 'public' },
			table: { __rl: true, value: 'my_table', mode: 'list', cachedResultName: 'my_table' },
			limit: 5,
			where: {
				values: [
					{ column: 'id', condition: '>=', value: 2 },
					{ column: 'foo', condition: 'equal', value: 'data 2' },
				],
			},
			sort: {
				values: [{ column: 'id' }],
			},
			options: {
				outputColumns: ['json', 'id'],
			},
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await select.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
		);

		expect(runQueries).toHaveBeenCalledWith(
			[
				{
					query:
						'SELECT $3:name FROM $1:name.$2:name WHERE $4:name >= $5 AND $6:name = $7 ORDER BY $8:name ASC LIMIT $9',
					values: ['public', 'my_table', ['json', 'id'], 'id', 2, 'foo', 'data 2', 'id', 5],
				},
			],
			nodeOptions,
		);
	});
});
