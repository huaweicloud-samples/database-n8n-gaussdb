import get from 'lodash/get';
import type {
	IDataObject,
	IExecuteFunctions,
	IGetNodeParameterOptions,
	INode,
	INodeParameters,
} from 'n8n-workflow';

import * as executeQuery from '../../../actions/database/executeQuery.operation';
import type { QueriesRunner } from '../../../../Postgres/v2/helpers/interfaces';

const runQueries: QueriesRunner = vi.fn().mockResolvedValue([]);

const node: INode = {
	id: '1',
	name: 'GaussDB node',
	typeVersion: 1,
	type: 'n8n-nodes-base.gaussDb',
	position: [0, 0],
	parameters: {
		operation: 'executeQuery',
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

describe('Test GaussDb, executeQuery operation', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('should call runQueries with query and queryReplacement values', async () => {
		const nodeParameters: IDataObject = {
			operation: 'executeQuery',
			query: 'select * from $1:name;',
			options: {
				queryReplacement: 'my_table',
			},
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await executeQuery.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
		);

		expect(runQueries).toHaveBeenCalledWith(
			[{ query: 'select * from $1:name;', values: ['my_table'], options: { partial: true } }],
			nodeOptions,
		);
	});

	it('should insert enclosed placeholder into values when no queryReplacement', async () => {
		const nodeParameters: IDataObject = {
			operation: 'executeQuery',
			query: "select '$1';",
			options: {},
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await executeQuery.execute.call(
			createMockExecuteFunction(nodeParameters),
			runQueries,
			items,
			nodeOptions,
		);

		expect(runQueries).toHaveBeenCalledWith(
			[{ query: 'select $1;', values: ['$1'], options: { partial: true } }],
			nodeOptions,
		);
	});

	it('should throw when queryReplacement is an invalid type', async () => {
		const nodeParameters: IDataObject = {
			operation: 'executeQuery',
			query: 'SELECT 1',
			options: {
				queryReplacement: true,
			},
		};
		const nodeOptions = nodeParameters.options as IDataObject;

		await expect(
			executeQuery.execute.call(
				createMockExecuteFunction(nodeParameters),
				runQueries,
				items,
				nodeOptions,
			),
		).rejects.toThrow();
	});
});
