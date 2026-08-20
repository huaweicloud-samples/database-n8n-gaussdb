import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ChatHubVectorStoreGaussDBApi implements ICredentialType {
	name = 'chatHubVectorStoreGaussDBApi';

	extends = ['postgres'];

	displayName = 'ChatHub GaussDB Store API';

	documentationUrl = 'postgres';

	properties: INodeProperties[] = [
		{
			displayName: 'Table Name Prefix',
			name: 'tableNamePrefix',
			type: 'string',
			default: 'n8n_vectors',
			description: 'Prefix for table names. The full table name will be {prefix}_{userId}.',
		},
	];
}
