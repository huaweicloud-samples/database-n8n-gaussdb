import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import * as database from './database/Database.resource';
import { addExecutionHints } from '../../../utils/utilities';
import { configureGaussDb } from '../transport';
import type { GaussDbNodeCredentials } from '../helpers/interfaces';
import type { PostgresNodeOptions, QueriesRunner } from '../../Postgres/v2/helpers/interfaces';
import { configureQueryRunner } from '../../Postgres/v2/helpers/utils';

type GaussDbType = {
	resource: 'database';
	operation: 'deleteTable' | 'executeQuery' | 'insert' | 'select' | 'update' | 'upsert';
};

export async function router(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	let returnData: INodeExecutionData[] = [];

	const items = this.getInputData();
	const resource = this.getNodeParameter<GaussDbType>('resource', 0);
	const operation = this.getNodeParameter('operation', 0);

	const credentials = await this.getCredentials<GaussDbNodeCredentials>('gaussDbApi');
	const options = this.getNodeParameter('options', 0, {}) as PostgresNodeOptions;
	const node = this.getNode();
	options.nodeVersion = node.typeVersion;
	options.operation = operation;

	const { db, pgp } = await configureGaussDb.call(this, credentials, options);

	const runQueries: QueriesRunner = configureQueryRunner.call(
		this,
		this.getNode(),
		this.continueOnFail(),
		pgp,
		db,
	);

	const gaussDbNodeData = { resource, operation } as GaussDbType;

	switch (gaussDbNodeData.resource) {
		case 'database':
			returnData = await database[gaussDbNodeData.operation].execute.call(
				this,
				runQueries,
				items,
				options,
				db,
				pgp,
			);
			break;
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported!`,
			);
	}

	addExecutionHints(this, node, items, gaussDbNodeData.operation, node.executeOnce);

	return [returnData];
}
