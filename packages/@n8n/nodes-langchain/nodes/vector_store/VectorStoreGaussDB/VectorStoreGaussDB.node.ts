import { configurePostgres } from 'n8n-nodes-base/dist/nodes/Postgres/transport/index';
import type { PostgresNodeCredentials } from 'n8n-nodes-base/dist/nodes/Postgres/v2/helpers/interfaces';
import type { INodeProperties } from 'n8n-workflow';
import type pg from 'pg';

import { metadataFilterField, createVectorStoreNode } from '@n8n/ai-utilities';

import { GaussDBVectorStore } from './GaussDBVectorStore';

const tableNameField: INodeProperties = {
	displayName: 'Table Name',
	name: 'tableName',
	type: 'string',
	default: 'n8n_vectors',
	description:
		'The table name to store the vectors in. If table does not exist, it will be created.',
};

const indexTypeField: INodeProperties = {
	displayName: 'Index Type',
	name: 'indexType',
	type: 'options',
	default: 'auto',
	description: 'The vector index type to use for similarity search',
	options: [
		{
			name: 'Auto',
			value: 'auto',
			description: 'Auto-select: GsIVFFLAT for &lt;=1024 dims, GsDiskANN+PQ for &gt;1024',
		},
		{
			name: 'GsIVFFLAT',
			value: 'gsivfflat',
			description: 'IVF-based index for dimensions <=1024',
		},
		{
			name: 'GsDiskANN',
			value: 'gsdiskann',
			description: 'DiskANN index for any dimensions (PQ required for >1024)',
		},
	],
};

const retrieveFields: INodeProperties[] = [
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [metadataFilterField],
	},
];

export class VectorStoreGaussDB extends createVectorStoreNode<GaussDBVectorStore>({
	meta: {
		displayName: 'GaussDB Vector Store',
		name: 'vectorStoreGaussDB',
		icon: 'file:gaussdb.svg',
		description: 'GaussDB vector store (floatvector/GsIVFFLAT/GsDiskANN)',
		docsUrl: 'https://docs.n8n.io',
		credentials: [
			{
				name: 'postgres',
				required: true,
				testedBy: 'postgresConnectionTest',
			},
		],
		operationModes: ['load', 'insert', 'retrieve', 'retrieve-as-tool'],
	},
	sharedFields: [tableNameField, indexTypeField],
	loadFields: retrieveFields,
	retrieveFields,
	async getVectorStoreClient(context, filter, embeddings, itemIndex) {
		const credentials = await context.getCredentials('postgres');
		const pgConf = await configurePostgres.call(context, credentials as PostgresNodeCredentials);
		const pool = pgConf.db.$pool as unknown as pg.Pool;
		const tableName = context.getNodeParameter('tableName', itemIndex, 'n8n_vectors') as string;
		const indexType = context.getNodeParameter('indexType', itemIndex, 'auto') as
			| 'auto'
			| 'gsivfflat'
			| 'gsdiskann';

		return await GaussDBVectorStore.initialize(embeddings, { pool, tableName, indexType, filter });
	},
	async populateVectorStore(context, embeddings, documents, itemIndex) {
		const credentials = await context.getCredentials('postgres');
		const pgConf = await configurePostgres.call(context, credentials as PostgresNodeCredentials);
		const pool = pgConf.db.$pool as unknown as pg.Pool;
		const tableName = context.getNodeParameter('tableName', itemIndex, 'n8n_vectors') as string;
		const indexType = context.getNodeParameter('indexType', itemIndex, 'auto') as
			| 'auto'
			| 'gsivfflat'
			| 'gsdiskann';

		// Determine dimensions by embedding a probe query — needed to create the table and index
		const dimensions = (await embeddings.embedQuery('test')).length;
		const store = await GaussDBVectorStore.initialize(embeddings, {
			pool,
			tableName,
			dimensions,
			indexType,
		});
		await store.addDocuments(documents);
	},
}) {}
