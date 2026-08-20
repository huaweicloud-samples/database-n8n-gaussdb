import pgPromise from 'pg-promise';
import type {
	ICredentialTestFunctions,
	IExecuteFunctions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import type { PostgresNodeOptions } from '../../Postgres/v2/helpers/interfaces';
import type { GaussDbNodeCredentials, GaussDbConnectionData } from '../helpers/interfaces';

const pgp = pgPromise({ noWarnings: true });

export async function configureGaussDb(
	this: IExecuteFunctions | ICredentialTestFunctions | ILoadOptionsFunctions,
	credentials: GaussDbNodeCredentials,
	_options: PostgresNodeOptions,
): Promise<GaussDbConnectionData> {
	const config = {
		host: credentials.host,
		port: credentials.port,
		database: credentials.database,
		user: credentials.user,
		password: credentials.password,
		ssl: !['disable', undefined].includes(credentials.ssl),
		sslmode: credentials.ssl || 'disable',
		max: 10,
	};
	const db = pgp(config);
	return { db, pgp };
}
