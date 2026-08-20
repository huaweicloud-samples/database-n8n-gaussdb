/* eslint-disable n8n-nodes-base/node-filename-against-convention */
import { NodeConnectionTypes, type INodeTypeDescription } from 'n8n-workflow';

import * as database from './database/Database.resource';

export const versionDescription: INodeTypeDescription = {
	displayName: 'GaussDB',
	name: 'gaussDb',
	icon: 'file:gaussdb.svg',
	group: ['input'],
	version: [2, 2.1],
	subtitle: '={{ $parameter["operation"] }}',
	description: 'Get, add and update data in GaussDB',
	defaults: {
		name: 'GaussDB',
	},
	inputs: [NodeConnectionTypes.Main],
	outputs: [NodeConnectionTypes.Main],
	usableAsTool: true,
	credentials: [
		{
			name: 'gaussDbApi',
			required: true,
			testedBy: 'gaussDbConnectionTest',
		},
	],
	properties: [
		{
			displayName: 'Resource',
			name: 'resource',
			type: 'hidden',
			noDataExpression: true,
			options: [
				{
					name: 'Database',
					value: 'database',
				},
			],
			default: 'database',
		},
		...database.description,
	],
};
