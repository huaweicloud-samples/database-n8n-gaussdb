import type { PgpClient, PgpDatabase } from '../../Postgres/v2/helpers/interfaces';

export interface GaussDbNodeCredentials {
	host: string;
	database: string;
	user: string;
	password: string;
	port: number;
	ssl: 'allow' | 'disable' | 'require';
}

export interface GaussDbConnectionData {
	db: PgpDatabase;
	pgp: PgpClient;
}
