import { mock } from 'vitest-mock-extended';
import type { ICredentialTestFunctions, ICredentialsDecrypted } from 'n8n-workflow';

import type { GaussDbNodeCredentials } from '../../helpers/interfaces';

const { mockConfigureGaussDb, mockDb, mockConnection } = vi.hoisted(() => ({
	mockConfigureGaussDb: vi.fn(),
	mockDb: { connect: vi.fn() },
	mockConnection: { done: vi.fn() },
}));

vi.mock('../../transport', () => ({
	configureGaussDb: mockConfigureGaussDb,
}));

import { gaussDbConnectionTest } from '../../methods/credentialTest';

describe('gaussDbConnectionTest', () => {
	const credentialsData: GaussDbNodeCredentials = {
		host: 'localhost',
		database: 'testdb',
		user: 'gaussdb',
		password: 'secret',
		port: 8000,
		ssl: 'disable',
	};

	const credential = { data: credentialsData } as unknown as ICredentialsDecrypted;

	beforeEach(() => {
		vi.clearAllMocks();
		mockConfigureGaussDb.mockResolvedValue({ db: mockDb, pgp: vi.fn() });
		mockDb.connect.mockResolvedValue(mockConnection);
		mockConnection.done.mockResolvedValue(undefined);
	});

	it('returns OK on successful connection and releases the connection', async () => {
		const thisArg = mock<ICredentialTestFunctions>();
		const result = await gaussDbConnectionTest.call(thisArg, credential);

		expect(result).toEqual({ status: 'OK', message: 'Connection successful!' });
		expect(mockConnection.done).toHaveBeenCalledTimes(1);
	});

	it('returns Error with "Connection refused" on ECONNREFUSED', async () => {
		mockDb.connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

		const thisArg = mock<ICredentialTestFunctions>();
		const result = await gaussDbConnectionTest.call(thisArg, credential);

		expect(result).toEqual({ status: 'Error', message: 'Connection refused' });
		expect(mockConnection.done).not.toHaveBeenCalled();
	});

	it('returns Error with host-not-found message on ENOTFOUND', async () => {
		mockDb.connect.mockRejectedValue(new Error('getaddrinfo ENOTFOUND badhost'));

		const thisArg = mock<ICredentialTestFunctions>();
		const result = await gaussDbConnectionTest.call(thisArg, credential);

		expect(result).toEqual({
			status: 'Error',
			message: 'Host not found, please check your host name',
		});
	});

	it('returns Error with timeout message on ETIMEDOUT', async () => {
		mockDb.connect.mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.1:5432'));

		const thisArg = mock<ICredentialTestFunctions>();
		const result = await gaussDbConnectionTest.call(thisArg, credential);

		expect(result).toEqual({ status: 'Error', message: 'Connection timed out' });
	});
});
