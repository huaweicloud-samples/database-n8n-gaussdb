import type { Document } from '@langchain/core/documents';
import type { Embeddings } from '@langchain/core/embeddings';
import { createVectorStoreNode, metadataFilterField } from '@n8n/ai-utilities';
import { configurePostgres } from 'n8n-nodes-base/dist/nodes/Postgres/transport/index';
import type { PostgresNodeCredentials } from 'n8n-nodes-base/dist/nodes/Postgres/v2/helpers/interfaces';
import { postgresConnectionTest } from 'n8n-nodes-base/dist/nodes/Postgres/v2/methods/credentialTest';
import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeCredentialTestResult,
	INodeProperties,
	ISupplyDataFunctions,
	NodeParameterValueType,
} from 'n8n-workflow';
import { jsonParse } from 'n8n-workflow';
import type pg from 'pg';
import {
	filterChatHubMetadata,
	filterChatHubInsertDocuments,
	CHAT_HUB_RETRIEVE_METADATA_KEYS,
} from '../shared/chatHub';
import { getUserScopedSlot } from '../shared/userScoped';
import { GaussDBVectorStore } from '../VectorStoreGaussDB/GaussDBVectorStore';

type ChatHubVectorStoreGaussDBApiCredentials = PostgresNodeCredentials & {
	tableNamePrefix: string;
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

async function deleteDocuments(
	this: ILoadOptionsFunctions,
	payload: IDataObject | string | undefined,
): Promise<NodeParameterValueType> {
	const { filter } = (typeof payload === 'string' ? jsonParse(payload) : (payload ?? {})) as {
		filter: Record<string, string | string[]>;
	};

	const credentials = await this.getCredentials<ChatHubVectorStoreGaussDBApiCredentials>(
		'chatHubVectorStoreGaussDBApi',
	);
	const tableName = getUserScopedSlot(this, credentials.tableNamePrefix);

	const pgConf = await configurePostgres.call(this, credentials as PostgresNodeCredentials);
	const pool = pgConf.db.$pool as unknown as pg.Pool;

	if (!filter || Object.keys(filter).length === 0) {
		// The table is user-scoped (one table per user), so dropping it is safe
		// and avoids leaving empty ghost tables after user deletion.
		await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
		return null;
	}

	const conditions: string[] = [];
	const values: Array<string | string[]> = [];
	let paramIndex = 1;
	for (const [key, value] of Object.entries(filter)) {
		if (Array.isArray(value)) {
			conditions.push(`metadata->>($${paramIndex}::text) = ANY($${paramIndex + 1}::text[])`);
		} else {
			conditions.push(`metadata->>($${paramIndex}::text) = $${paramIndex + 1}`);
		}
		values.push(key, value);
		paramIndex += 2;
	}
	await pool.query(`DELETE FROM "${tableName}" WHERE ${conditions.join(' AND ')}`, values);

	return null;
}

async function chatHubVectorStoreGaussDBApiConnectionTest(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	const credentialWithSsh: ICredentialsDecrypted = {
		...credential,
		data: { ...(credential.data ?? {}), sshTunnel: false },
	};

	const connectionResult = await postgresConnectionTest.call(this, credentialWithSsh);
	if (connectionResult.status === 'Error') {
		return connectionResult;
	}

	const credentials = credential.data as ChatHubVectorStoreGaussDBApiCredentials;

	try {
		const pgConf = await configurePostgres.call(this, credentials as PostgresNodeCredentials);
		const pool = pgConf.db.$pool as unknown as pg.Pool;
		const result = await pool.query<{ enable_vectordb: string }>('SHOW enable_vectordb');
		const value = result.rows[0]?.enable_vectordb;
		if (value !== 'on') {
			return {
				status: 'Error',
				message:
					'enable_vectordb is off. Please enable vectordb at instance level and restart GaussDB.',
			};
		}
	} catch (error) {
		return {
			status: 'Error',
			message: error.message as string,
		};
	}

	return connectionResult;
}

export async function getVectorStoreClient(
	context: ISupplyDataFunctions | IExecuteFunctions,
	filter: Record<string, never> | undefined,
	embeddings: Embeddings,
	itemIndex: number,
): Promise<GaussDBVectorStore> {
	const credentials = await context.getCredentials<ChatHubVectorStoreGaussDBApiCredentials>(
		'chatHubVectorStoreGaussDBApi',
	);
	const tableName = getUserScopedSlot(context, credentials.tableNamePrefix, itemIndex);
	const pgConf = await configurePostgres.call(context, credentials as PostgresNodeCredentials);
	const pool = pgConf.db.$pool as unknown as pg.Pool;

	const store = await GaussDBVectorStore.initialize(embeddings, {
		pool,
		tableName,
		filter,
	});

	const originalSearch = store.similaritySearchVectorWithScore.bind(store);
	store.similaritySearchVectorWithScore = async (...args) => {
		const results = await originalSearch(...args);
		return results.map(([doc, score]) => [
			{ ...doc, metadata: filterChatHubMetadata(doc.metadata, CHAT_HUB_RETRIEVE_METADATA_KEYS) },
			score,
		]);
	};

	return store;
}

export async function populateVectorStore(
	context: ISupplyDataFunctions | IExecuteFunctions,
	embeddings: Embeddings,
	documents: Array<Document<Record<string, unknown>>>,
	itemIndex: number,
): Promise<void> {
	const credentials = await context.getCredentials<ChatHubVectorStoreGaussDBApiCredentials>(
		'chatHubVectorStoreGaussDBApi',
	);
	const tableName = getUserScopedSlot(context, credentials.tableNamePrefix, itemIndex);
	const pgConf = await configurePostgres.call(context, credentials as PostgresNodeCredentials);
	const pool = pgConf.db.$pool as unknown as pg.Pool;

	// Probe dimensions by embedding a probe query — needed to create the table and index
	const dimensions = (await embeddings.embedQuery('test')).length;
	const store = await GaussDBVectorStore.initialize(embeddings, {
		pool,
		tableName,
		dimensions,
	});
	await store.addDocuments(filterChatHubInsertDocuments(documents));
}

export class ChatHubVectorStoreGaussDB extends createVectorStoreNode({
	hidden: true,
	methods: {
		credentialTest: { chatHubVectorStoreGaussDBApiConnectionTest },
		actionHandler: { deleteDocuments },
	},
	meta: {
		description: 'Internal-use vector store for ChatHub (GaussDB)',
		icon: 'file:../VectorStoreGaussDB/gaussdb.svg',
		displayName: 'ChatHub GaussDB Store',
		docsUrl: 'https://docs.n8n.io',
		name: 'chatHubVectorStoreGaussDB',
		credentials: [
			{
				name: 'chatHubVectorStoreGaussDBApi',
				required: true,
				testedBy: 'chatHubVectorStoreGaussDBApiConnectionTest',
			},
		],
		operationModes: ['load', 'insert', 'retrieve', 'retrieve-as-tool'],
	},
	sharedFields: [],
	insertFields: [],
	loadFields: retrieveFields,
	retrieveFields,
	getVectorStoreClient,
	populateVectorStore,
}) {}
