import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { configureGaussDb } from '../transport';
import type { GaussDbNodeCredentials } from '../helpers/interfaces';
import { getTableSchema } from '../../Postgres/v2/helpers/utils';

export async function getColumns(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials<GaussDbNodeCredentials>('gaussDbApi');
	const options = { nodeVersion: this.getNode().typeVersion };

	const { db } = await configureGaussDb.call(this, credentials, options);

	const schema = this.getNodeParameter('schema', 0, {
		extractValue: true,
	}) as string;

	const table = this.getNodeParameter('table', 0, {
		extractValue: true,
	}) as string;

	const columns = await getTableSchema(db, schema, table);

	return columns.map((column) => ({
		name: column.column_name,
		value: column.column_name,
		description: `Type: ${column.data_type.toUpperCase()}, Nullable: ${column.is_nullable}`,
	}));
}

export async function getColumnsMultiOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const returnData = await getColumns.call(this);
	const returnAll = { name: '*', value: '*', description: 'All columns' };
	return [returnAll, ...returnData];
}

export async function getColumnsWithoutColumnToMatchOn(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const columnToMatchOn = this.getNodeParameter('columnToMatchOn') as string;
	const returnData = await getColumns.call(this);
	return returnData.filter((column) => column.value !== columnToMatchOn);
}
