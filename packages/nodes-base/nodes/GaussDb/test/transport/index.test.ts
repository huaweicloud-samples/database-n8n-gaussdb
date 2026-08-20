import { mock } from 'vitest-mock-extended';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { GaussDbNodeCredentials } from '../../helpers/interfaces';

const { mockPgp, mockDb } = vi.hoisted(() => ({
	mockDb: {},
	mockPgp: vi.fn(),
}));

vi.mock('pg-promise', () => ({
	default: vi.fn(() => mockPgp),
}));

import { configureGaussDb } from '../../transport';

describe('configureGaussDb', () => {
	const baseCredentials: GaussDbNodeCredentials = {
		host: 'localhost',
		database: 'testdb',
		user: 'gaussdb',
		password: 'secret',
		port: 8000,
		ssl: 'disable',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockPgp.mockReturnValue(mockDb);
	});

	it('returns { db, pgp } with defined values', async () => {
		const thisArg = mock<IExecuteFunctions>();
		const result = await configureGaussDb.call(thisArg, baseCredentials, {
			nodeVersion: 1,
			operation: 'executeQuery',
		});
		expect(result).toBeDefined();
		expect(result.db).toBeDefined();
		expect(result.pgp).toBeDefined();
	});

	it('passes correct config (host/port/database/user/password/ssl/sslmode/max) to pgp', async () => {
		const thisArg = mock<IExecuteFunctions>();
		await configureGaussDb.call(thisArg, baseCredentials, {
			nodeVersion: 1,
			operation: 'executeQuery',
		});
		expect(mockPgp).toHaveBeenCalledWith({
			host: 'localhost',
			port: 8000,
			database: 'testdb',
			user: 'gaussdb',
			password: 'secret',
			ssl: false,
			sslmode: 'disable',
			max: 10,
		});
	});

	it('sets ssl=false and sslmode=disable when ssl=disable', async () => {
		const thisArg = mock<IExecuteFunctions>();
		await configureGaussDb.call(thisArg, { ...baseCredentials, ssl: 'disable' }, {
			nodeVersion: 1,
			operation: 'executeQuery',
		});
		expect(mockPgp).toHaveBeenCalledWith(
			expect.objectContaining({ ssl: false, sslmode: 'disable' }),
		);
	});

	it('sets ssl=true and sslmode=require when ssl=require', async () => {
		const thisArg = mock<IExecuteFunctions>();
		await configureGaussDb.call(thisArg, { ...baseCredentials, ssl: 'require' }, {
			nodeVersion: 1,
			operation: 'executeQuery',
		});
		expect(mockPgp).toHaveBeenCalledWith(
			expect.objectContaining({ ssl: true, sslmode: 'require' }),
		);
	});

	it('sets ssl=true when ssl=allow', async () => {
		const thisArg = mock<IExecuteFunctions>();
		await configureGaussDb.call(thisArg, { ...baseCredentials, ssl: 'allow' }, {
			nodeVersion: 1,
			operation: 'executeQuery',
		});
		expect(mockPgp).toHaveBeenCalledWith(
			expect.objectContaining({ ssl: true, sslmode: 'allow' }),
		);
	});
});
